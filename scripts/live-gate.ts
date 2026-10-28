import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { AGENT_IDS, getAvailableAdapters } from "../src/adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "../src/autonomy.js";
import { FORCE_KILL_DELAY_MS, MAX_RUN_TIMEOUT_MS, PIPE_GIVE_UP_MS, signalProcess } from "../src/process-runner.js";
import { createTerminationTarget, waitForDescendantsGrace, type TerminationTarget } from "../src/process-tree.js";
import type { AgentId } from "../src/types.js";

const DEFAULT_TIMEOUT_SECONDS = 180;
const OUTER_TIMEOUT_GRACE_SECONDS = 30;
const NONCE_BYTES = 6;
const MAX_JOBS = 4;
const STDERR_LIMIT = 160;
const STDOUT_LIMIT = 80;
const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CODEMUX = join(ROOT, "bin/codemux");

// Entries must quote the matrix note explaining why medium cannot run a shell command headless.
// Every harness currently supports medium shell execution inside scode.
const MEDIUM_UNSUPPORTED: Partial<Record<AgentId, string>> = {};

interface GateOptions {
  codemux: string;
  timeout: number;
  jobs: number;
  skip: Set<AgentId>;
  only?: Set<AgentId>;
  passEnv?: string;
}

interface ProbeResult {
  status: "PASS" | "FAIL" | "SKIP" | "UNSUPPORTED";
  seconds: number;
  stderr: string;
  note?: string;
}

export interface HarnessResult {
  agent: AgentId;
  readOnly: ProbeResult;
  medium: ProbeResult;
}

function positiveInteger(maximum: number): (value: string) => number {
  return (value) => {
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new InvalidArgumentError(`Expected an integer from 1 to ${maximum}.`);
    }
    return number;
  };
}

function agentList(values: (string | undefined)[], label: string): Set<AgentId> {
  const agents = new Set<AgentId>();
  for (const name of values.flatMap((value) => value?.split(",") ?? [])) {
    const agent = name.trim();
    if (!agent) continue;
    if (!AGENT_IDS.includes(agent as AgentId)) throw new Error(`${label} list contains an unknown harness name.`);
    agents.add(agent as AgentId);
  }
  return agents;
}

export function parseOptions(args: string[], skipEnv = process.env.LIVE_GATE_SKIP): GateOptions {
  const command = new Command()
    .name("live-gate")
    .description("Spend quota to check every installed harness under the default sandbox.")
    .option("--codemux <path>", "Codemux executable to test", DEFAULT_CODEMUX)
    .option("--timeout <seconds>", "Timeout per probe in seconds", positiveInteger(MAX_RUN_TIMEOUT_MS / 1000), DEFAULT_TIMEOUT_SECONDS)
    .option("--jobs <count>", "Concurrent probes (1 to 4)", positiveInteger(MAX_JOBS), MAX_JOBS)
    .option("--skip <agents>", "Comma-separated harnesses without credentials (adds to LIVE_GATE_SKIP)")
    .option("--only <agents>", "Run only these comma-separated installed harnesses")
    .option("--pass-env <names>", "Forward this comma-separated environment list to every probe")
    .exitOverride();
  command.parse(args, { from: "user" });
  const options = command.opts<{ codemux: string; timeout: number; jobs: number; skip?: string; only?: string; passEnv?: string }>();
  const codemux = resolve(options.codemux);
  try {
    if (!statSync(codemux).isFile()) throw new Error("not a file");
    accessSync(codemux, constants.X_OK);
  } catch {
    command.error(`--codemux must name an existing executable file: ${escapeControls(codemux)}`, { exitCode: 2 });
  }
  const skip = agentList([skipEnv, options.skip], "Skip");
  const only = options.only === undefined ? undefined : agentList([options.only], "Only");
  if (only?.size === 0) throw new Error("Only list must contain at least one harness name.");
  return { codemux, timeout: options.timeout, jobs: options.jobs, skip, only, passEnv: options.passEnv };
}

function escapeControls(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

function firstStderrLine(value: string): string {
  const line = value.trim();
  return /^(Running with|Warning:)/.test(line) ? "" : escapeControls(line).slice(0, STDERR_LIMIT);
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (chunk: string) => void,
  path?: string,
): Promise<void> {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (path) appendFileSync(path, value);
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export class ProbeRunner {
  private readonly active = new Map<TerminationTarget, (reason: string) => void>();
  interrupted: NodeJS.Signals | undefined;

  interrupt(signal: NodeJS.Signals): void {
    const repeated = this.interrupted !== undefined;
    this.interrupted ??= signal;
    for (const [target, stop] of this.active) {
      stop("interrupted");
      if (repeated) signalProcess(target, "SIGKILL", "tree");
    }
  }

  async run(command: string[], expected: string, timeout: number, outputPath?: string): Promise<ProbeResult> {
    const start = performance.now();
    const failed = (stderr: string): ProbeResult => ({
      status: "FAIL", seconds: (performance.now() - start) / 1000, stderr,
    });
    const stdoutPath = outputPath && `${outputPath}.out`;
    const stderrPath = outputPath && `${outputPath}.err`;
    if (stdoutPath) writeFileSync(stdoutPath, "");
    if (stderrPath) writeFileSync(stderrPath, "");
    if (this.interrupted) return failed("interrupted before probe started");
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(command, { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    } catch {
      return failed("could not start codemux");
    }
    const target = createTerminationTarget(proc, true);
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    let reason = "";
    let deadline = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpExit: () => void = () => {};
    const abandonedExit = new Promise<void>((done) => { giveUpExit = done; });
    const stop = (message: string): void => {
      if (reason) return;
      reason = message;
      deadline = performance.now() + FORCE_KILL_DELAY_MS;
      killTimer = setTimeout(() => signalProcess(target, "SIGKILL", "tree"), FORCE_KILL_DELAY_MS);
      giveUpTimer = setTimeout(() => {
        void stdoutReader.cancel().catch(() => {});
        void stderrReader.cancel().catch(() => {});
        giveUpExit();
      }, FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS);
      signalProcess(target, "SIGTERM", "tree");
    };
    this.active.set(target, stop);
    const timeoutTimer = setTimeout(() => stop("timeout"), timeout * 1000);

    // Keep a bounded preview while writing the full response to disk.
    let output = "";
    let preview = "";
    let mismatch = false;
    let trailingWhitespace = false;
    const stdout = drain(stdoutReader, (chunk) => {
      preview += chunk.slice(0, STDOUT_LIMIT - preview.length);
      for (const character of chunk) {
        if (mismatch) break;
        if (character.trim() === "") {
          if (output) trailingWhitespace = true;
        } else if (trailingWhitespace || character !== expected[output.length]) {
          mismatch = true;
        } else {
          output += character;
        }
      }
    }, stdoutPath);
    let stderr = "";
    let pendingLine = "";
    const finishLine = (): void => {
      stderr ||= firstStderrLine(pendingLine);
      pendingLine = "";
    };
    const errors = drain(stderrReader, (chunk) => {
      for (const character of chunk) {
        if (stderr) break;
        if (character === "\n") finishLine();
        else if (pendingLine.length < STDERR_LIMIT && (pendingLine || character.trim())) pendingLine += character;
      }
    }, stderrPath);
    try {
      const [exit] = await Promise.all([
        Promise.race([proc.exited, abandonedExit]), stdout, errors,
      ]);
      finishLine();
      const passed = !reason && exit === 0 && !mismatch && output === expected;
      return {
        status: passed ? "PASS" : "FAIL",
        seconds: (performance.now() - start) / 1000,
        stderr: passed ? "" : reason || stderr || `exit ${exit ?? "without a status"}${preview ? `; stdout: ${escapeControls(preview)}` : ""}`,
      };
    } catch {
      stop("could not capture probe output");
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
      await Promise.race([proc.exited, abandonedExit]).catch(() => {});
      finishLine();
      return failed(reason || stderr);
    } finally {
      clearTimeout(timeoutTimer);
      if (reason) {
        await waitForDescendantsGrace(target, deadline);
        signalProcess(target, "SIGKILL", "tree");
      }
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      this.active.delete(target);
    }
  }
}

export async function runPool(tasks: (() => Promise<void>)[], jobs: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]!();
  }));
}

function cell(value: string): string {
  return escapeControls(value).replaceAll("&", "&amp;").replaceAll("|", "&#124;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resultCell(result: ProbeResult): string {
  if (result.status === "SKIP") return "SKIP (no credentials; operator requested)";
  if (result.status === "UNSUPPORTED") return cell(`UNSUPPORTED (documented): ${result.note}`);
  return result.status;
}

function hasProbes(rows: HarnessResult[]): boolean {
  return rows.some((row) => [row.readOnly, row.medium].some((result) => result.status === "PASS" || result.status === "FAIL"));
}

export function formatReport(rows: HarnessResult[], only?: ReadonlySet<AgentId>, codemux = DEFAULT_CODEMUX): string {
  const totals = { pass: 0, fail: 0, skip: 0, unsupported: 0 };
  const scope = only ? `Scope: --only ${[...only].join(",")} (installed harnesses only).` : "Scope: all installed harnesses.";
  const lines = [`Codemux: ${escapeControls(codemux)}`, scope, "", "| Agent | Read-only | Medium | Seconds | First stderr line on failure |", "| --- | --- | --- | ---: | --- |"];
  for (const row of rows) {
    const results = [row.readOnly, row.medium];
    if (results.some((result) => result.status === "FAIL")) totals.fail++;
    else if (results.some((result) => result.status === "SKIP")) totals.skip++;
    else if (results.some((result) => result.status === "UNSUPPORTED")) totals.unsupported++;
    else totals.pass++;
    const failure = results.find((result) => result.status === "FAIL");
    lines.push(`| ${row.agent} | ${resultCell(row.readOnly)} | ${resultCell(row.medium)} | ${(row.readOnly.seconds + row.medium.seconds).toFixed(1)} | ${cell(failure?.stderr ?? "")} |`);
  }
  lines.push("", `live-gate (${escapeControls(codemux)}): ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip, ${totals.unsupported} unsupported`);
  if (!hasProbes(rows)) {
    const allSkipped = rows.length > 0 && rows.every((row) => row.readOnly.status === "SKIP" && row.medium.status === "SKIP");
    lines.push(`live-gate: nothing was probed${allSkipped ? " (all skipped)" : ""}`);
  }
  return lines.join("\n");
}

export async function runProbes(
  agents: readonly AgentId[], options: GateOptions, runner: Pick<ProbeRunner, "run">, reportDirectory: string,
): Promise<HarnessResult[]> {
  const rows: HarnessResult[] = [];
  const tasks: (() => Promise<void>)[] = [];
  for (const agent of agents.filter((agent) => !options.only || options.only.has(agent))) {
    const result = (): ProbeResult => ({ status: "SKIP", seconds: 0, stderr: "" });
    const row: HarnessResult = { agent, readOnly: result(), medium: result() };
    rows.push(row);
    if (options.skip.has(agent)) continue;
    const command = (level: string, prompt: string): string[] => [
      options.codemux, "run", "-a", agent,
      ...(options.passEnv === undefined ? [] : ["--pass-env", options.passEnv]),
      "--auto", level, "--timeout", String(options.timeout), "-p", prompt,
    ];
    const probe = (key: "readOnly" | "medium", level: string, prompt: string): void => {
      tasks.push(async () => {
        let directory: string | undefined;
        try {
          directory = mkdtempSync(join(tmpdir(), "codemux-live-gate-"));
          let expected = "OK";
          if (key === "medium") {
            const nonce = randomBytes(NONCE_BYTES).toString("hex");
            expected = createHash("sha256").update(nonce).digest("hex").slice(0, 16);
            writeFileSync(join(directory, "nonce.txt"), nonce, { mode: 0o600 });
            writeFileSync(join(directory, "probe.sh"), [
              "if command -v shasum >/dev/null 2>&1; then",
              '  printf %s "$(cat nonce.txt)" | shasum -a 256 | cut -c1-16',
              "else",
              '  printf %s "$(cat nonce.txt)" | sha256sum | cut -c1-16',
              "fi\n",
            ].join("\n"), { mode: 0o700 });
          }
          row[key] = await runner.run([
            ...command(level, prompt), "--cwd", directory,
          ], expected, options.timeout + OUTER_TIMEOUT_GRACE_SECONDS, join(reportDirectory, `${agent}-${level}`));
        } catch {
          row[key] = { status: "FAIL", seconds: 0, stderr: "could not prepare or run probe" };
        } finally {
          if (directory) {
            try {
              rmSync(directory, { recursive: true, force: true });
            } catch {
              row[key] = { status: "FAIL", seconds: row[key].seconds, stderr: "could not clean probe directory" };
            }
          }
        }
      });
    };
    probe("readOnly", "read-only", "Reply with exactly: OK");
    const unsupported = MEDIUM_UNSUPPORTED[agent];
    if (unsupported !== undefined) {
      if (!unsupported || unsupported !== AUTONOMY_EQUIVALENCE[agent].notes) {
        throw new Error("Unsupported medium entry must quote its autonomy matrix note.");
      }
      row.medium = { status: "UNSUPPORTED", seconds: 0, stderr: "", note: `src/autonomy.ts: ${unsupported}` };
    } else {
      probe("medium", "medium", "Run the shell command: sh probe.sh and reply with exactly its output, nothing else.");
    }
  }
  await runPool(tasks, options.jobs);
  return rows;
}

export function createReportDirectory(scratch: string): string {
  const base = existsSync(scratch) ? join(scratch, "live-gate") : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "codemux-live-gate-report-"));
}

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const directory = createReportDirectory(join(ROOT, "scratch"));
  const runner = new ProbeRunner();
  const onInterrupt = (): void => runner.interrupt("SIGINT");
  const onTerminate = (): void => runner.interrupt("SIGTERM");
  const onHangup = (): void => runner.interrupt("SIGHUP");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  try {
    const rows = await runProbes(getAvailableAdapters().map((adapter) => adapter.id), options, runner, directory);
    const report = formatReport(rows, options.only, options.codemux);
    console.log(report);
    const path = join(directory, "report.md");
    await Bun.write(path, `${report}\n`);
    console.log(`Report: ${path}`);
    process.exitCode = runner.interrupted === "SIGHUP" ? 129 : runner.interrupted === "SIGINT" ? 130 : runner.interrupted ? 143
      : !hasProbes(rows) || rows.some((row) => row.readOnly.status === "FAIL" || row.medium.status === "FAIL") ? 1 : 0;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if ((error as { code?: string }).code !== "commander.helpDisplayed") {
      console.error("live-gate: could not complete; check arguments, installation, and report directory");
      process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
    }
  }
}
