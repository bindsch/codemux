import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import {
  createReportDirectory,
  formatReport,
  parseOptions,
  ProbeRunner,
  runProbes,
  runPool,
  type HarnessResult,
} from "../scripts/live-gate.js";

const ROOT = resolve(import.meta.dir, "..");

function fixtureDirectory(): string {
  const scratch = join(ROOT, "scratch");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "live-gate-test-"));
}

function completeProbe(command: string[], expected: string) {
  if (command.includes("medium")) {
    const cwd = command[command.indexOf("--cwd") + 1]!;
    const child = Bun.spawnSync(["sh", "probe.sh"], { cwd });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe(expected);
    expect(readdirSync(cwd).sort()).toEqual([".nonce", "probe.sh"]);
  }
  return { status: "PASS" as const, seconds: 0, stderr: "" };
}

test("live gate validates limits and combines credential skips", () => {
  const options = parseOptions(["--timeout", "12", "--jobs", "2", "--skip", "qwen"], "gemini, goose");
  expect(options.timeout).toBe(12);
  expect(options.jobs).toBe(2);
  expect([...options.skip]).toEqual(["gemini", "goose", "qwen"]);
  expect(parseOptions([], undefined).timeout).toBe(180);
  expect(parseOptions([], undefined).jobs).toBe(4);
  for (const args of [["--jobs", "5"], ["--jobs", "0"], ["--timeout", "NaN"], ["--timeout", "0"]]) {
    expect(() => parseOptions(args, undefined)).toThrow();
  }
  expect(() => parseOptions(["--skip", "unknown"], undefined)).toThrow();
});

test("live gate validates and deduplicates the selected harnesses", () => {
  const options = parseOptions(["--only", " agy,kimi,agy ", "--skip", "kimi"], "");
  expect([...(options.only ?? [])]).toEqual(["agy", "kimi"]);
  expect([...options.skip]).toEqual(["kimi"]);
  expect(parseOptions([], "").only).toBeUndefined();
  for (const selection of ["unknown", "", " , "]) {
    expect(() => parseOptions(["--only", selection], "")).toThrow();
  }
});

test("live gate limits concurrent probes", async () => {
  let running = 0;
  let peak = 0;
  let finished = 0;
  await runPool(Array.from({ length: 9 }, () => async () => {
    running++;
    peak = Math.max(peak, running);
    await Bun.sleep(5);
    running--;
    finished++;
  }), 4);
  expect(peak).toBe(4);
  expect(finished).toBe(9);
});

test("live gate requires exact trimmed output and a zero exit", async () => {
  const runner = new ProbeRunner();
  const probe = (source: string) => runner.run([process.execPath, "-e", source], "OK", 5);
  expect((await probe('console.log(" OK ")')).status).toBe("PASS");
  const mismatch = await probe('console.log("secret unexpected output")');
  expect(mismatch.status).toBe("FAIL");
  expect(mismatch.stderr).toBe("exit 0; stdout: secret unexpected output\\u000a");
  const failure = await probe('console.log("OK"); console.error("first\\tline"); console.error("secret second line"); process.exit(7)');
  expect(failure.status).toBe("FAIL");
  expect(failure.stderr).toBe("first\\tline");
  expect(JSON.stringify(failure)).not.toContain("secret second line");
});

test("live gate skips banners, warnings, and blank stderr lines across chunks", async () => {
  const source = 'process.stderr.write("\\nRunning with aider (sandboxed)...\\nWar"); await Bun.sleep(10); process.stderr.write("ning: " + "x".repeat(300) + "\\r\\n  \\nactual\\tproblem"); process.exit(7);';
  const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5);
  expect(result.status).toBe("FAIL");
  expect(result.stderr).toBe("actual\\tproblem");
});

test("live gate falls back to the exit code and at most 80 stdout characters", async () => {
  for (const output of ["", "x".repeat(100)]) {
    const source = `process.stderr.write("Running with aider (sandboxed)...\\nWarning: version\\n\\n"); process.stdout.write(${JSON.stringify(output)}); process.exit(9);`;
    const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5);
    expect(result.stderr).toBe(output ? `exit 9; stdout: ${"x".repeat(80)}` : "exit 9");
  }
});

test("live gate preserves complete raw stdout and stderr for passing and failing probes", async () => {
  const directory = fixtureDirectory();
  try {
    for (const exit of [0, 7]) {
      const prefix = join(directory, `agy-${exit === 0 ? "read-only" : "medium"}`);
      const stdout = exit === 0 ? " OK \n" : `${"x".repeat(200)}\n`;
      const stderr = "Running with aider (sandboxed)...\nWarning: version\nfirst\tproblem\nsecond problem\n";
      const source = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exit});`;
      const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 5, prefix);
      expect(result.status).toBe(exit === 0 ? "PASS" : "FAIL");
      expect(readFileSync(`${prefix}.out`, "utf8")).toBe(stdout);
      expect(readFileSync(`${prefix}.err`, "utf8")).toBe(stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live gate cancels an open pipe when capture of the other pipe fails", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const stdout = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { canceled = true; },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(value) { value.error(new Error("capture failed")); },
  });
  const child = {
    pid: 2147483647, stdout, stderr, exited: Promise.resolve(0),
  } as Bun.Subprocess<"ignore", "pipe", "pipe">;
  const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
  const kill = spyOn(process, "kill").mockReturnValue(true);
  try {
    const result = await new ProbeRunner().run(["stub-child"], "OK", 5);
    expect(result.status).toBe("FAIL");
    expect(result.stderr).toBe("could not capture probe output");
    expect(canceled).toBe(true);
    expect(stdout.locked).toBe(false);
  } finally {
    if (!canceled) controller!.close();
    spawn.mockRestore();
    kill.mockRestore();
  }
});

test("live gate creates report directories under scratch or the system temporary directory", () => {
  const directory = fixtureDirectory();
  const reports: string[] = [];
  try {
    for (const scratch of [directory, join(directory, "absent")]) {
      const report = createReportDirectory(scratch);
      reports.push(report);
      expect(dirname(report)).toBe(existsSync(scratch) ? join(scratch, "live-gate") : tmpdir());
      expect(readdirSync(report)).toEqual([]);
    }
    expect(createReportDirectory(directory)).not.toBe(reports[0]);
  } finally {
    for (const report of reports) rmSync(report, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("live gate stops the process group and blocks new probes after %s", async (signal) => {
  const runner = new ProbeRunner();
  const kill = spyOn(process, "kill");
  try {
    const pending = runner.run([process.execPath, "-e", "setInterval(() => {}, 1000)"], "OK", 10);
    runner.interrupt(signal);
    expect((await pending).status).toBe("FAIL");
    expect(runner.interrupted).toBe(signal);
    expect(kill.mock.calls.some(([pid, sent]) => pid < 0 && sent === "SIGTERM")).toBe(true);
    const next = await runner.run([process.execPath, "-e", 'console.log("OK")'], "OK", 5);
    expect(next.status).toBe("FAIL");
    expect(next.stderr).toContain("interrupted");
  } finally {
    kill.mockRestore();
  }
});

test("live gate kills a process group that ignores termination on timeout", async () => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "live-gate-timeout-"));
  const pidFile = join(directory, "pid");
  const source = `process.on("SIGTERM", () => {}); console.error("earlier error"); await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  try {
    const result = await new ProbeRunner().run([process.execPath, "-e", source], "OK", 1);
    expect(result.status).toBe("FAIL");
    expect(result.stderr).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live gate reports harness totals and escapes failure details", () => {
  const pass = { status: "PASS" as const, seconds: 1, stderr: "" };
  const rows: HarnessResult[] = [
    { agent: "codex", readOnly: pass, medium: pass },
    { agent: "cursor", readOnly: { status: "FAIL", seconds: 2, stderr: "first | failure" }, medium: pass },
    { agent: "gemini", readOnly: { status: "SKIP", seconds: 0, stderr: "" }, medium: { status: "SKIP", seconds: 0, stderr: "" } },
    { agent: "kimi", readOnly: pass, medium: { status: "UNSUPPORTED", seconds: 0, stderr: "", note: "src/autonomy.ts: matrix note" } },
  ];
  const report = formatReport(rows);
  expect(report).toContain("live-gate: 1 pass, 1 fail, 1 skip, 1 unsupported");
  expect(report).toContain("SKIP (no credentials; operator requested)");
  expect(report).toContain("UNSUPPORTED (documented): src/autonomy.ts: matrix note");
  expect(report).toContain("first &#124; failure");
});

test("live gate prepares private nonce files and gives the outer deadline 30 extra seconds", async () => {
  const calls: string[][] = [];
  const directories: string[] = [];
  const reportDirectory = fixtureDirectory();
  const runner = {
    async run(command: string[], expected: string, timeout: number, prefix?: string) {
      calls.push(command);
      expect(timeout).toBe(210);
      expect(command.slice(1, 3)).toEqual(["run", "-a"]);
      expect(command).not.toContain("--no-sandbox");
      expect(command).toContain("--timeout");
      expect(command[command.indexOf("--timeout") + 1]).toBe("180");
      const medium = command.includes("medium");
      const prompt = command[command.indexOf("-p") + 1]!;
      expect(prompt).toBe(medium
        ? "Run the shell command: sh probe.sh and reply with exactly its output, nothing else."
        : "Reply with exactly: OK");
      expect(command).toContain("--cwd");
      const cwd = command[command.indexOf("--cwd") + 1]!;
      if (medium) {
        expect(expected).toMatch(/^[0-9a-f]{16}$/);
        expect(prompt).not.toContain(expected);
        expect(readdirSync(cwd).sort()).toEqual([".nonce", "probe.sh"]);
        const nonce = readFileSync(join(cwd, ".nonce"), "utf8");
        expect(nonce).toMatch(/^[0-9a-f]{12}$/);
        expect(expected).toBe(createHash("sha256").update(nonce).digest("hex").slice(0, 16));
        expect(statSync(join(cwd, ".nonce")).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(cwd, "probe.sh"), "utf8")).not.toContain(expected);
        expect(statSync(join(cwd, "probe.sh")).mode & 0o777).toBe(0o700);
      } else {
        expect(expected).toBe("OK");
        expect(readdirSync(cwd)).toEqual([]);
      }
      expect(dirname(cwd)).toBe(tmpdir());
      expect(cwd.startsWith(`${ROOT}/`)).toBe(false);
      directories.push(cwd);
      expect(prefix).toBe(join(reportDirectory, `${command[3]}-${medium ? "medium" : "read-only"}`));
      return completeProbe(command, expected);
    },
  };
  try {
    const rows = await runProbes(["agy", "kimi", "gemini"], parseOptions(["--skip", "gemini"], ""), runner, reportDirectory);
    expect(calls).toHaveLength(4);
    expect(directories).toHaveLength(4);
    expect(new Set(directories).size).toBe(4);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(formatReport(rows)).toContain("live-gate: 2 pass, 0 fail, 1 skip, 0 unsupported");
    expect(rows.every((row) => row.agent === "gemini" || (row.readOnly.status === "PASS" && row.medium.status === "PASS"))).toBe(true);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test.each(["command", "sha256sum fallback", "echo nonce", "wrong stdout", "codemux-ok"])("live gate requires the nonce hash from command execution: %s", async (output) => {
  const reportDirectory = fixtureDirectory();
  const runner = new ProbeRunner();
  try {
    const rows = await runProbes(["agy"], parseOptions([], ""), {
      run(command, expected, timeout, prefix) {
        const cwd = command[command.indexOf("--cwd") + 1]!;
        let probe = [process.execPath, "-e", 'console.log(" OK ")'];
        if (command.includes("medium")) {
          if (output === "command" || output === "wrong stdout") {
            const script = output === "command" ? 'cd "$1" && sh probe.sh'
              : 'cd "$1" && sh probe.sh >/dev/null && printf codemux-ok';
            probe = ["sh", "-c", script, "sh", cwd];
          } else if (output === "sha256sum fallback") {
            const bin = join(reportDirectory, "bin");
            mkdirSync(bin);
            for (const utility of ["sh", "cat", "cut"]) symlinkSync(Bun.which(utility)!, join(bin, utility));
            writeFileSync(join(bin, "sha256sum"), `#!${process.execPath}
              const { createHash } = require("node:crypto");
              console.log(createHash("sha256").update(await Bun.stdin.text()).digest("hex") + "  -");
            `, { mode: 0o700 });
            probe = [Bun.which("env")!, `PATH=${bin}`, "sh", "-c", 'cd "$1" && sh probe.sh', "sh", cwd];
          } else if (output === "codemux-ok") {
            probe = [process.execPath, "-e", 'console.log("codemux-ok")'];
          } else {
            const source = `const fs = require("node:fs"); const dir = process.argv[1];
              process.stdout.write(fs.readFileSync(dir + "/.nonce", "utf8"));`;
            probe = [process.execPath, "-e", source, cwd];
          }
        }
        return runner.run(probe, expected, timeout, prefix);
      },
    }, reportDirectory);
    expect(rows[0]!.readOnly.status).toBe("PASS");
    expect(rows[0]!.medium.status).toBe(["command", "sha256sum fallback"].includes(output) ? "PASS" : "FAIL");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test.each([undefined, "cursor", "other", ""])("live gate never adds pass-env from the ambient Cursor entry: %s", async (entry) => {
  const previous = process.env.CODEMUX_CURSOR_ENTRY;
  const reportDirectory = fixtureDirectory();
  const calls: string[][] = [];
  try {
    if (entry === undefined) delete process.env.CODEMUX_CURSOR_ENTRY;
    else process.env.CODEMUX_CURSOR_ENTRY = entry;
    const rows = await runProbes(["cursor", "agy"], parseOptions(["--timeout", "12"], ""), {
      async run(command, expected, timeout) {
        calls.push(command);
        expect(timeout).toBe(42);
        expect(command[command.indexOf("--timeout") + 1]).toBe("12");
        const passEnv = command.indexOf("--pass-env");
        expect(passEnv).toBe(-1);
        expect(command).not.toContain("CODEMUX_CURSOR_ENTRY");
        return completeProbe(command, expected);
      },
    }, reportDirectory);
    expect(calls).toHaveLength(4);
    expect(rows.every((row) => row.readOnly.status === "PASS" && row.medium.status === "PASS")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.CODEMUX_CURSOR_ENTRY;
    else process.env.CODEMUX_CURSOR_ENTRY = previous;
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("live gate forwards the explicit pass-env list verbatim to every probe", async () => {
  const reportDirectory = fixtureDirectory();
  const names = "CODEMUX_CURSOR_ENTRY, CUSTOM_VALUE";
  const calls: string[][] = [];
  try {
    const rows = await runProbes(["cursor", "agy"], parseOptions(["--pass-env", names], ""), {
      async run(command, expected) {
        calls.push(command);
        expect(command.filter((arg) => arg === "--pass-env")).toHaveLength(1);
        expect(command[command.indexOf("--pass-env") + 1]).toBe(names);
        return completeProbe(command, expected);
      },
    }, reportDirectory);
    expect(calls).toHaveLength(4);
    expect(rows.every((row) => row.readOnly.status === "PASS" && row.medium.status === "PASS")).toBe(true);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("make live-gate forwards LIVE_GATE_ARGS", async () => {
  const result = Bun.spawnSync(["make", "-n", "live-gate", "LIVE_GATE_ARGS=--pass-env CODEMUX_CURSOR_ENTRY"], { cwd: ROOT });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("bun run scripts/live-gate.ts --pass-env CODEMUX_CURSOR_ENTRY");
});

test("live gate registers and removes SIGHUP handling and exits 129", async () => {
  const source = `
    import { main, ProbeRunner } from ${JSON.stringify(join(ROOT, "scripts/live-gate.ts"))};
    ProbeRunner.prototype.run = async () => { throw new Error("unexpected harness probe"); };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const before = signals.map((signal) => process.listenerCount(signal));
    const pending = main();
    for (const [index, signal] of signals.entries()) {
      if (process.listenerCount(signal) !== before[index] + 1) throw new Error("missing " + signal);
    }
    process.emit("SIGHUP");
    await pending;
    for (const [index, signal] of signals.entries()) {
      if (process.listenerCount(signal) !== before[index]) throw new Error("leaked " + signal);
    }
    console.log("signal handlers removed");
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    cwd: ROOT, env: { ...process.env, LIVE_GATE_SKIP: AGENT_IDS.join(",") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  const report = stdout.match(/^Report: (.+)$/m)?.[1];
  try {
    expect(stderr).toBe("");
    expect(exit).toBe(129);
    expect(stdout).toContain("signal handlers removed");
  } finally {
    if (report) rmSync(dirname(report), { recursive: true, force: true });
  }
});

test("live gate cleans both probe directories when the runner rejects", async () => {
  const reportDirectory = fixtureDirectory();
  const directories: string[] = [];
  try {
    const rows = await runProbes(["agy"], parseOptions([], ""), {
      async run(command) {
        directories.push(command[command.indexOf("--cwd") + 1]!);
        throw new Error("test failure");
      },
    }, reportDirectory);
    expect(directories).toHaveLength(2);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(formatReport(rows)).toContain("live-gate: 0 pass, 1 fail, 0 skip, 0 unsupported");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("live gate includes only selected harnesses in its probes, report, and totals", async () => {
  const reportDirectory = fixtureDirectory();
  const calls: string[] = [];
  const options = parseOptions(["--only", "agy,kimi", "--skip", "kimi"], "");
  try {
    const rows = await runProbes(["agy", "kimi", "gemini"], options, {
      async run(command, expected) {
        const agent = command[3]!;
        calls.push(agent);
        if (agent === "gemini") return { status: "FAIL" as const, seconds: 0, stderr: "" };
        return completeProbe(command, expected);
      },
    }, reportDirectory);
    expect(calls).toEqual(["agy", "agy"]);
    expect(rows.map((row) => row.agent)).toEqual(["agy", "kimi"]);
    const report = formatReport(rows, options.only);
    expect(report.split("\n")[0]).toBe("Scope: --only agy,kimi (installed harnesses only).");
    expect(report).not.toContain("gemini");
    expect(report).toContain("live-gate: 1 pass, 0 fail, 1 skip, 0 unsupported");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test.each([
  { label: "none installed", installed: [], args: [], skip: "", skipped: false },
  { label: "only uninstalled", installed: ["agy"], args: ["--only", "kimi"], skip: "", skipped: false },
  { label: "only skipped or uninstalled", installed: ["agy"], args: ["--only", "agy,kimi", "--skip", "agy"], skip: "", skipped: true },
  { label: "all skipped by environment", installed: ["agy", "kimi"], args: [], skip: "agy,kimi", skipped: true },
  { label: "all skipped by flag", installed: ["agy", "kimi"], args: ["--skip", "agy,kimi"], skip: "", skipped: true },
])("live gate fails when nothing was probed: $label", async ({ installed, args, skip, skipped }) => {
  const source = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(join(ROOT, "src/adapters/index.ts"))}, () => ({
      AGENT_IDS: ${JSON.stringify(AGENT_IDS)},
      getAvailableAdapters: () => ${JSON.stringify(installed)}.map((id) => ({ id })),
    }));
    const { main, ProbeRunner } = await import(${JSON.stringify(join(ROOT, "scripts/live-gate.ts"))});
    ProbeRunner.prototype.run = async () => { throw new Error("unexpected harness probe"); };
    process.argv = ["bun", "live-gate", ...${JSON.stringify(args)}];
    await main();
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    cwd: ROOT, env: { ...process.env, LIVE_GATE_SKIP: skip },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  const report = stdout.match(/^Report: (.+)$/m)?.[1];
  const message = `live-gate: nothing was probed${skipped ? " (all skipped)" : ""}`;
  try {
    expect(stderr).toBe("");
    expect(exit).toBe(1);
    expect(stdout).toContain("| Agent | Read-only | Medium | Seconds | First stderr line on failure |");
    expect(stdout).toContain(message);
    expect(stdout.indexOf("live-gate: 0 pass, 0 fail,")).toBeLessThan(stdout.indexOf(message));
    expect(report).toBeDefined();
    expect(readFileSync(report!, "utf8")).toContain(message);
  } finally {
    if (report) rmSync(dirname(report), { recursive: true, force: true });
  }
});
