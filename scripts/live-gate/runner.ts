// CLI parsing and the probe runner for the live gate. Kept separate from
// scripts/live-gate.ts (the entry hub) so no module in scripts/live-gate/
// imports the hub back: a static cycle there deadlocks bun's loader when the
// hub is the entry file.

import { Command, InvalidArgumentError } from "commander";
import { accessSync, appendFileSync, constants, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { AGENT_IDS } from "../../src/adapters/index.js";
import { FORCE_KILL_DELAY_MS, MAX_RUN_TIMEOUT_MS, PIPE_GIVE_UP_MS, signalProcess } from "../../src/process-runner.js";
import { createTerminationTarget, waitForDescendantsGrace, type TerminationTarget } from "../../src/process-tree.js";
import type { AgentId } from "../../src/types.js";

import { DEFAULT_PROBES, PROVIDER_OVERRIDE_OPT_IN, parseProbeList, probeApplies, type HarnessFacts, type ProbeLetter } from "./probes.js";

// 600: the codex experiment probe runs its code-mode model for six to
// eight minutes (395 s and 495 s on 2026-11-02), and the canonical
// `make live-gate` must be able to run every probe it requires (round 36).
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_JOBS = 4;
const STDERR_LIMIT = 160;
const STDOUT_LIMIT = 80;
const CAPTURE_LIMIT = 512 * 1024;
const ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_CODEMUX = join(ROOT, "bin/codemux");

/** This checkout's own launcher: when --codemux names it, discovery and
 * capabilities may come from the in-process adapter registry (the
 * checkout and the build are the same code). Any other path is a
 * candidate and answers `list --json` instead (candidate.ts). */
export function isDefaultCodemux(codemux: string): boolean {
  return codemux === DEFAULT_CODEMUX;
}

export interface GateOptions {
  codemux: string;
  timeout: number;
  jobs: number;
  skip: Set<AgentId>;
  only?: Set<AgentId>;
  passEnv?: string;
  probes: readonly ProbeLetter[];
  /** The `-m` value the codex experiment probe carries (`worker` by default:
   * the operator's alias; a codex experiment refuses a request without a
   * model). */
  codexModel: string;
  allowStaleContracts: boolean;
  /** KNOWN-BREAK has its own allowance (audit D15); a sandbox-mitigated
   * break never fails, flag or no flag. */
  allowKnownBreaks: boolean;
  /** Harnesses that run even when the gate's login pre-check (audit D8)
   * detects no credentials — the operator says the store is wrong. */
  probeAnyway: Set<AgentId>;
  allowVersionMismatch: boolean;
}

export interface ProbeResult {
  status: "PASS" | "FAIL" | "SKIP" | "UNSUPPORTED";
  seconds: number;
  stderr: string;
  note?: string;
}

export interface CapturedOutput {
  exit: number | null;
  stdout: string;
}

export type Verifier = (captured: CapturedOutput) => string | null;

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

export function parseOptions(args: string[], skipEnv = process.env.LIVE_GATE_SKIP, env: Record<string, string | undefined> = process.env): GateOptions {
  const command = new Command()
    .name("live-gate")
    .description("Spend quota to check every installed harness under the default sandbox.")
    .option("--codemux <path>", "Codemux executable to test", DEFAULT_CODEMUX)
    .option("--timeout <seconds>", "Timeout per probe in seconds", positiveInteger(MAX_RUN_TIMEOUT_MS / 1000), DEFAULT_TIMEOUT_SECONDS)
    .option("--jobs <count>", "Concurrent probes (1 to 4)", positiveInteger(MAX_JOBS), MAX_JOBS)
    .option("--skip <agents>", "Comma-separated harnesses without credentials (adds to LIVE_GATE_SKIP)")
    .option("--only <agents>", "Run only these comma-separated installed harnesses")
    .option("--pass-env <names>", "Forward this comma-separated environment list to every probe")
    .option("--probe <probes>", "Run only these comma-separated probes (letters or names; default: every probe but H, which is opt-in)")
    .option("--skip-probe <probes>", "Exclude these comma-separated probes")
    .option("--codex-model <alias>", "The -m value the codex experiment probe carries (a codex experiment refuses a request without one)", "worker")
    .option("--allow-stale-contracts", "Report stale version contracts without failing the gate")
    .option("--allow-known-breaks", "Report known-broken version contracts without failing the gate (a break the sandbox mitigates never fails, flag or no flag)")
    .option("--probe-anyway <agents>", "Run these harnesses even when the gate detects no credentials (the login pre-check would skip them)")
    .option("--allow-version-mismatch", "Test a candidate whose --version differs from this checkout anyway (its probe matrix still comes from the candidate)")
    .exitOverride();
  command.parse(args, { from: "user" });
  const options = command.opts<{ codemux: string; timeout: number; jobs: number; skip?: string; only?: string; passEnv?: string; probe?: string; skipProbe?: string; probeAnyway?: string; codexModel: string; allowStaleContracts?: boolean; allowKnownBreaks?: boolean; allowVersionMismatch?: boolean }>();
  const codemux = resolve(options.codemux);
  try {
    if (!statSync(codemux).isFile()) throw new Error("not a file");
    accessSync(codemux, constants.X_OK);
  } catch {
    command.error(`--codemux must name an existing executable file: ${escapeControls(codemux)}`, { exitCode: 2 });
  }
  // A list flag given with an empty value — the whole value or one
  // comma-separated entry — is a caller mistake, not an absent flag:
  // the list parsers skip empty entries, so `--skip ""` would silently
  // select every harness (review round 159). The env merge
  // (LIVE_GATE_SKIP) keeps its own convention: blank means unset.
  for (const [flag, value] of [["--skip", options.skip], ["--only", options.only], ["--pass-env", options.passEnv],
    ["--probe", options.probe], ["--skip-probe", options.skipProbe], ["--probe-anyway", options.probeAnyway]] as const) {
    if (value?.split(",").some((entry) => entry.trim() === "")) {
      throw new Error(`${flag} takes a comma-separated list; an entry is empty.`);
    }
  }
  const skip = agentList([skipEnv, options.skip], "Skip");
  const only = options.only === undefined ? undefined : agentList([options.only], "Only");
  if (only?.size === 0) throw new Error("Only list must contain at least one harness name.");
  const selected = options.probe === undefined ? [...DEFAULT_PROBES] : parseProbeList([options.probe], "Probe");
  if (selected.length === 0) throw new Error("Probe list must contain at least one probe.");
  const probes = selected.filter((letter) => !parseProbeList([options.skipProbe], "Skip-probe").includes(letter));
  if (probes.length === 0) throw new Error("Probe selection is empty after --skip-probe.");
  if (env[PROVIDER_OVERRIDE_OPT_IN] !== undefined && env[PROVIDER_OVERRIDE_OPT_IN] !== "1") {
    throw new Error(`${PROVIDER_OVERRIDE_OPT_IN} must be 1 when set.`);
  }
  if (options.codexModel.trim() === "" || options.codexModel.includes("\0")) throw new Error("--codex-model must be a nonempty model name or alias.");
  return { codemux, timeout: options.timeout, jobs: options.jobs, skip, only, passEnv: options.passEnv, probes, codexModel: options.codexModel, allowStaleContracts: options.allowStaleContracts === true, allowKnownBreaks: options.allowKnownBreaks === true, probeAnyway: agentList([options.probeAnyway], "Probe-anyway"), allowVersionMismatch: options.allowVersionMismatch === true };
}

/** The opt-in preflight for probe H (review round 4, edges finding H): a
 * harness that will run the provider-override probe must export all three
 * of its CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL} variables,
 * nonempty. A missing or empty one made the probe run WITHOUT the
 * override — the adapter never saw it and answered from the operator's
 * default credentials, a PASS that verified nothing and spent quota
 * outside the account the opt-in names. Refused before any probe runs,
 * naming the variable; unset the opt-in to skip probe H instead. */
export function providerOverridePreflight(
  facts: readonly HarnessFacts[],
  options: Pick<GateOptions, "probes" | "skip" | "only">,
  env: Record<string, string | undefined> = process.env
): void {
  if (env[PROVIDER_OVERRIDE_OPT_IN] !== "1") return;
  const running = facts.filter((fact) =>
    (!options.only || options.only.has(fact.id)) &&
    !options.skip.has(fact.id) &&
    options.probes.includes("H") &&
    probeApplies("H", fact));
  for (const fact of running) {
    for (const suffix of ["BASE_URL", "API_KEY", "MODEL"] as const) {
      const name = `CODEMUX_${fact.id.toUpperCase()}_PROVIDER_${suffix}`;
      if (!env[name]) {
        throw new Error(
          `${PROVIDER_OVERRIDE_OPT_IN}=1 runs probe H on ${fact.id}, but ${name} is missing or empty; export it or unset ${PROVIDER_OVERRIDE_OPT_IN}`
        );
      }
    }
  }
}

export function escapeControls(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

// Banner lines stay discarded; Warning: lines are kept in the row's note so a
// stale-contract warning can no longer hide behind a PASS (audit finding 4).
// Every completed line is classified on its own, whatever came before it:
// once an ordinary line was stored, a later Warning: used to be dropped
// (review round 5, edges finding 5). Warnings are capped so a chatty
// harness cannot grow the note without bound.
const STDERR_WARNING_CAP = 3;

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

/** A scripted stdin exchange for a probe whose child must keep reading
 * while it works: `open` is written once at spawn, stdin stays open, and
 * `next` is called with each completed stdout line. The bytes `next`
 * returns are written and stdin is then ended — that answer is the
 * exchange's last frame; null writes nothing and keeps the pipe open. The
 * fixed `stdin` string closes stdin at once, which a session driver reads
 * as EOF and answers by draining the session (docs/sessions.md, "End
 * conditions and failures") instead of running the turn at all. */
export interface StdinScript {
  open: string;
  next(line: string): string | null;
}

interface ProbeExecution {
  expected?: string;
  verify?: Verifier;
  stdin?: string | StdinScript;
  /** Extra environment for this probe alone (the loopback probes' override
   * variables), merged over the runner's own. */
  env?: Record<string, string>;
  /** A probe whose proof is not the child's exit status (the loopback
   * fake's request log is): any exit reaches the verifier, which sees the
   * exit itself and decides. */
  allowAnyExit?: boolean;
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

  /** Exact-output probe: trimmed stdout must equal `expected` and the exit
   * must be 0. Keeps the bounded streaming compare so a runaway reply never
   * lands in memory. */
  run(command: string[], expected: string, timeout: number, outputPath?: string, stdin?: string | StdinScript): Promise<ProbeResult> {
    return this.execute(command, { expected, timeout, outputPath, stdin });
  }

  /** Structural probe: the verifier decides over the captured stdout; the
   * exit must still be 0 unless `extra.allowAnyExit` moves the whole
   * judgment to the verifier. Full stdout is bounded at CAPTURE_LIMIT. */
  capture(command: string[], verify: Verifier, timeout: number, outputPath?: string, stdin?: string | StdinScript, extra: { env?: Record<string, string>; allowAnyExit?: boolean } = {}): Promise<ProbeResult> {
    return this.execute(command, { verify, timeout, outputPath, stdin, ...extra });
  }

  private async execute(command: string[], execution: ProbeExecution & { timeout: number; outputPath?: string }): Promise<ProbeResult> {
    const { expected, verify, stdin, timeout, outputPath, env, allowAnyExit } = execution;
    const start = performance.now();
    const failed = (stderr: string, note?: string): ProbeResult => ({
      status: "FAIL", seconds: (performance.now() - start) / 1000, stderr, ...(note === undefined ? {} : { note }),
    });
    const warnings: string[] = [];
    const stdoutPath = outputPath && `${outputPath}.out`;
    const stderrPath = outputPath && `${outputPath}.err`;
    if (stdoutPath) writeFileSync(stdoutPath, "");
    if (stderrPath) writeFileSync(stderrPath, "");
    if (this.interrupted) return failed("interrupted before probe started");
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(command, {
        cwd: ROOT, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", detached: true,
        // No `env` key inherits this process's environment; a probe with
        // its own variables gets them merged over that, never a stripped
        // environment (the probes are codemux runs, which need PATH).
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      });
    } catch {
      return failed("could not start the probe command");
    }
    // The probe is registered in `active` BEFORE its stdin write (review
    // round 13, edges 4): the write is the one await between spawn and
    // registration, and an interrupt inside it could not stop the child
    // it arrived for — the child ran on to completion or its own
    // timeout. Everything `stop` touches is initialized above the write,
    // so a stop fired mid-write is safe.
    let reason = "";
    let deadline = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpExit: () => void = () => {};
    const abandonedExit = new Promise<void>((done) => { giveUpExit = done; });
    const target = createTerminationTarget(proc, true);
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
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
    // The deadline is armed BEFORE any stdin write: a child that never
    // reads its stdin, or fills stdout while this side still writes, must
    // still die at the probe's timeout (round 31, edges 2).
    const timeoutTimer = setTimeout(() => stop("timeout"), timeout * 1000);
    const script = typeof stdin === "string" ? undefined : stdin;
    if (typeof stdin === "string") {
      // A child that already closed or exited before the write lands
      // throws here (EPIPE); the probe is still judged by its exit code
      // and output, never by this write, so the failure is contained
      // instead of rejecting the whole probe with a generic error
      // (review round 11, edges 10). The end is not awaited: the drain
      // below reads stdout while the bytes flush.
      try {
        proc.stdin.write(stdin);
        void Promise.resolve(proc.stdin.end()).catch(() => {});
      } catch {
        // The stdin bytes did not land; the run proceeds.
      }
    } else if (stdin !== undefined) {
      // A script opens with its first frame and keeps the pipe open; its
      // last frame ends it, so an EPIPE here is contained the same way.
      try {
        proc.stdin.write(stdin.open);
      } catch {
        // The stdin bytes did not land; the run proceeds.
      }
    }
    // An interrupt that arrived during the write already stopped the
    // child through the registration above; one that arrived before it
    // (between the pre-spawn check and the registration, or before
    // interrupt() saw this target) is caught here. `stop` is idempotent,
    // so the second call is the no-op.
    if (this.interrupted) stop("interrupted");

    // Keep a bounded preview while writing the full response to disk.
    let output = "";
    let captured = "";
    let truncated = false;
    let preview = "";
    let mismatch = false;
    let trailingWhitespace = false;
    // The script answers completed stdout lines: a line still missing its
    // newline waits, exactly like the child's own line grammar. A write
    // after the child closed stdin is contained the same way as the open
    // write — the probe is judged by the captured output, never by it.
    let scriptPending = "";
    const feedScript = (chunk: string): void => {
      scriptPending += chunk;
      for (;;) {
        const newline = scriptPending.indexOf("\n");
        if (newline === -1) break;
        const line = scriptPending.slice(0, newline);
        scriptPending = scriptPending.slice(newline + 1);
        const answer = script?.next(line);
        if (answer === null || answer === undefined) continue;
        try {
          proc.stdin.write(answer);
          Promise.resolve(proc.stdin.end()).catch(() => {
            // The last frame did not land; the run proceeds.
          });
        } catch {
          // The last frame did not land; the run proceeds.
        }
      }
    };
    const stdout = drain(stdoutReader, (chunk) => {
      if (script !== undefined) feedScript(chunk);
      preview += chunk.slice(0, STDOUT_LIMIT - preview.length);
      if (expected === undefined) {
        // Truncated only when a chunk actually dropped bytes (review
        // round 4, edges finding 5): a reply that ended exactly at the
        // limit is complete, not a prefix.
        if (captured.length < CAPTURE_LIMIT) {
          const room = CAPTURE_LIMIT - captured.length;
          captured += chunk.slice(0, room);
          if (chunk.length > room) truncated = true;
        } else if (chunk.length > 0) {
          truncated = true;
        }
        return;
      }
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
    let collectingStderr = true;
    const finishLine = (): void => {
      const line = pendingLine;
      pendingLine = "";
      const trimmed = line.trim();
      if (trimmed === "" || /^Running with/.test(trimmed)) return;
      if (/^Warning:/.test(trimmed)) {
        if (warnings.length < STDERR_WARNING_CAP) warnings.push(escapeControls(trimmed).slice(0, STDERR_LIMIT));
      } else if (!stderr) {
        stderr = escapeControls(trimmed).slice(0, STDERR_LIMIT);
      }
    };
    const errors = drain(stderrReader, (chunk) => {
      for (const character of chunk) {
        if (!collectingStderr) break;
        if (character === "\n") {
          finishLine();
          // Bounded read: stop once the first ordinary line and the
          // warning cap are both covered; the raw bytes still reach the
          // report file.
          if (stderr && warnings.length >= STDERR_WARNING_CAP) collectingStderr = false;
        } else if (pendingLine.length < STDERR_LIMIT && (pendingLine || character.trim())) {
          pendingLine += character;
        }
      }
    }, stderrPath);
    try {
      const [exit] = await Promise.all([
        Promise.race([proc.exited, abandonedExit]), stdout, errors,
      ]);
      finishLine();
      const note = [
        ...warnings,
        ...(truncated ? [`stdout truncated at ${CAPTURE_LIMIT} characters`] : []),
      ].join("; ");
      if (reason) return failed(reason, note);
      if (expected !== undefined) {
        const passed = exit === 0 && !mismatch && output === expected;
        return passed
          ? { status: "PASS", seconds: (performance.now() - start) / 1000, stderr: "", ...(note === "" ? {} : { note }) }
          : failed(reason || stderr || `exit ${exit ?? "without a status"}${preview ? `; stdout: ${escapeControls(preview)}` : ""}`, note === "" ? undefined : note);
      }
      // A capture that dropped bytes is a FAIL (review round 4, edges
      // finding 5): the verifier judged a prefix, so a PASS here could
      // mean the proof simply sat beyond the limit. The full stdout still
      // landed in the report file (drain appends every chunk).
      if (truncated) {
        return failed("stdout exceeded the capture limit; the verifier saw a prefix only", note === "" ? undefined : note);
      }
      const verifierFailure = exit === 0 || allowAnyExit === true ? verify?.({ exit: exit ?? null, stdout: captured }) ?? null : null;
      const passed = (exit === 0 || allowAnyExit === true) && verifierFailure === null;
      return passed
        ? { status: "PASS", seconds: (performance.now() - start) / 1000, stderr: "", ...(note === "" ? {} : { note }) }
        : failed(verifierFailure || stderr || `exit ${exit ?? "without a status"}${preview ? `; stdout: ${escapeControls(preview)}` : ""}`, note === "" ? undefined : note);
    } catch {
      stop("could not capture probe output");
      void stdoutReader.cancel().catch(() => {});
      void stderrReader.cancel().catch(() => {});
      await Promise.race([proc.exited, abandonedExit]).catch(() => {});
      finishLine();
      return failed(reason || stderr, warnings[0]);
    } finally {
      // A script whose last frame never fired (the child exited before any
      // line matched) leaves the write end open; close it so nothing
      // dangles past the probe. An already-ended sink is a no-op.
      if (script !== undefined) {
        try {
          Promise.resolve(proc.stdin.end()).catch(() => {});
        } catch {
          // Already closed; nothing to do.
        }
      }
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
