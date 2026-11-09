// runProbes orchestration for the live gate: probe commands, private nonce
// files, environment forwarding, scope selection, and cleanup.
// scripts/live-gate/probes.ts owns the probe set; scripts/live-gate/run.ts
// owns runProbes.
import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  ProbeRunner,
  formatReport,
  parseOptions,
  runProbes,
  type ProbeLetter,
} from "../scripts/live-gate.js";
import { ROOT, cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv, reportInput } from "./helpers/live-gate.js";
import { MARKER } from "./fixtures/experiment-mcp.js";

// Every runProbes call below passes loggedInEnv(): the gate reads the login
// state before the matrix (audit D8), and the operator's own stores would
// decide which cells run.
afterAll(cleanupLoggedInHomes);

test.each([false, true])("live gate passes the explicit binary to every probe (relative: %s)", async (useRelative) => {
  const directory = fixtureDirectory();
  const fixture = loggedInEnv();
  const binary = join(directory, "installed codemux");
  const stub = join(directory, "stub");
  writeFileSync(stub, `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[args.indexOf("--auto") + 1] === "medium") {
      const result = Bun.spawnSync(["sh", "probe.sh"], { cwd: args[args.indexOf("--cwd") + 1] });
      process.stdout.write(result.stdout); process.exit(result.exitCode);
    } else console.log("OK");
  `, { mode: 0o700 });
  symlinkSync(stub, binary);
  const spawn = spyOn(Bun, "spawn");
  try {
    const options = parseOptions(["--probe", "A,B", "--codemux", useRelative ? relative(process.cwd(), binary) : binary], "");
    const rows = await runProbes([factsFor("agy")], options, new ProbeRunner(), directory, fixture.env);
    expect(options.codemux).toBe(binary);
    expect(spawn.mock.calls.map(([command]) => (command as string[])[0])).toEqual([binary, binary]);
    const report = formatReport(reportInput({ rows, codemux: binary, probes: ["A", "B"] }));
    expect(report.split("\n")[0]).toBe(`Codemux: ${binary}`);
    expect(report).toContain(`live-gate (${binary}): 2 pass, 0 fail, 0 skip, 0 unsupported`);
  } finally { spawn.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});

test("live gate builds the documented command for every probe letter", async () => {
  const reportDirectory = fixtureDirectory();
  const fixture = loggedInEnv({
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
    // The preflight requires every harness that runs H to carry its full
    // override environment (claude and opencode here; cursor has no
    // provider-override capability).
    CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8011/v1",
    CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
    CODEMUX_CLAUDE_PROVIDER_MODEL: "glm-5.3",
    CODEMUX_OPENCODE_PROVIDER_BASE_URL: "http://127.0.0.1:8011/v1",
    CODEMUX_OPENCODE_PROVIDER_API_KEY: "sk-test",
    CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
  });
  const calls: { agent: string; command: string[]; expected?: string; stdin?: string | { open: string; next: (line: string) => string | null } }[] = [];
  const experimentSpecs = new Map<string, object>();
  let experimentVerify: ((captured: { exit: number | null; stdout: string }) => string | null) | undefined;
  let experimentResults: { bare: string | null; header: string | null } | undefined;
  const letters: ProbeLetter[] = ["A", "B", "C", "D", "E", "F", "G", "H", "K"];
  try {
    const rows = await runProbes(
      [factsFor("claude"), factsFor("opencode"), factsFor("cursor")],
      parseOptions(["--probe", letters.join(","), "--pass-env", "EXTRA_NAME", "--timeout", "12"], ""),
      {
        async run(command, expected, _timeout, _prefix, stdin) {
          calls.push({ agent: command[3]!, command, expected, stdin });
          if (command.includes("--experiment-mcp")) {
            experimentSpecs.set(command[3]!, JSON.parse(readFileSync(command[command.indexOf("--experiment-mcp") + 1]!, "utf8")));
          }
          return { status: "PASS", seconds: 0, stderr: "" };
        },
        async capture(command, verify, _timeout, _prefix, stdin) {
          calls.push({ agent: command[3]!, command, stdin });
          if (command.includes("--experiment-mcp")) {
            // Probe G's verifier reads the recording from the probe's run
            // directory (finding 2); write one claude-shaped recording so
            // the bare-marker reply verifies while the directory is alive.
            const cwd = command[command.indexOf("--cwd") + 1]!;
            writeFileSync(join(cwd, `${randomUUID()}.jsonl`), `${JSON.stringify({ kind: "model_tool_result", tool_use_id: "t1", block: { type: "tool_result", content: MARKER } })}\n${JSON.stringify({ kind: "result_comparison", tool_use_id: "t1", equal: true })}\n`);
            experimentVerify = verify;
            experimentResults = {
              bare: verify({ exit: 0, stdout: `${MARKER}\n` }),
              header: verify({ exit: 0, stdout: `Wall time: 0.1234 seconds\nOutput:\n${MARKER}` }),
            };
          }
          verify({ exit: 0, stdout: "" });
          return { status: "PASS", seconds: 0, stderr: "" };
        },
      },
      reportDirectory,
      fixture.env,
    );
    const claudeCommands = calls.filter((call) => call.agent === "claude").map((call) => call.command.join(" "));
    expect(claudeCommands.length).toBe(8);
    // Probes C and H both run with --result-json (H asserts the override on
    // the envelope's model).
    expect(claudeCommands.filter((command) => command.includes("--result-json")).length).toBe(2);
    const check = calls.find((call) => call.agent === "claude" && call.command[1] === "check" && !call.command.includes("--session"))!;
    expect(check.command).toContain("--hermetic");
    expect(check.command).toContain("--pass-env");
    // Probe K is the session form of the hermetic check: the same check
    // binary with --session added, so the canary's three session launches
    // run under it (lane H4).
    const sessionCheck = calls.find((call) => call.agent === "claude" && call.command[1] === "check" && call.command.includes("--session"))!;
    expect(sessionCheck.command).toContain("--hermetic");
    expect(sessionCheck.command).toContain("--session");
    expect(sessionCheck.command).toContain("--pass-env");
    const session = calls.find((call) => call.agent === "claude" && call.command[1] === "session")!;
    expect(session.command).toContain("session");
    // The session stdin opens with one JSONL user frame naming a fresh
    // nonce — not plain text the protocol would reject as malformed — and
    // rides a scripted exchange (finding 1): stdin stays open while the
    // turn runs, and the shutdown frame is written only once a turn
    // completed on stdout; any other stdout line writes nothing.
    const exchange = session.stdin as { open: string; next: (line: string) => string | null } | undefined;
    const frame = JSON.parse((exchange?.open ?? "").trim()) as { type?: string; text?: string };
    expect(frame.type).toBe("user");
    expect(frame.text).toMatch(/^Reply with exactly: [0-9a-f]{12}$/);
    expect(exchange!.next(JSON.stringify({ type: "assistant_message", text: frame.text }))).toBeNull();
    expect(JSON.parse((exchange!.next(JSON.stringify({ type: "turn_completed", finish: "end" })) ?? "").trim()))
      .toEqual({ type: "shutdown" });
    const experiment = calls.find((call) => call.agent === "claude" && call.command.some((argument) => argument === "--experiment-mcp"))!;
    expect(experimentSpecs.get("claude")).not.toHaveProperty("accept_harness_prefix");
    expect(experiment.command).toContain("--hermetic");
    expect(experiment.command).toContain("none");
    // Probe G verifies the reply instead of string-comparing it, and the
    // delivery from the probe directory's recording (finding 2): with a
    // claude recording holding the bare marker, claude's bare-marker reply
    // passes and a header-carrying reply — a shape claude's wire never
    // produces — fails (review round 14, edges 1; round 15, blocker).
    expect(experimentVerify).toBeDefined();
    expect(experimentResults!.bare).toBeNull();
    expect(experimentResults!.header).toContain("not the bare marker");
    const override = calls.find((call) => call.agent === "claude" && /\bCODEMUX_CLAUDE_PROVIDER_BASE_URL/.test(call.command.join(" ")))!;
    expect(override.command.join(" ")).toContain("EXTRA_NAME");
    const opencode = calls.filter((call) => call.agent === "opencode");
    // OpenCode runs every letter except H: its wire carries no served-model
    // evidence, so probe H reports UNSUPPORTED (review round 14, edges 2).
    expect(opencode.length).toBe(7);
    expect(opencode.some((call) => call.command.includes("--tools") && call.command.includes("none"))).toBe(true);
    const cursor = calls.filter((call) => call.agent === "cursor");
    expect(cursor.length).toBe(2);
    expect(rows.map((row) => row.agent)).toEqual(["claude", "opencode", "cursor"]);
    for (const letter of ["C", "D", "E", "F", "G", "H", "K"] as const) {
      expect(rows[2]!.results[letter]).toMatchObject({ status: "UNSUPPORTED" });
    }
    expect(rows[2]!.results.A!.status).toBe("PASS");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("probe H is skipped without the explicit opt-in environment", async () => {
  const reportDirectory = fixtureDirectory();
  const fixture = loggedInEnv();
  try {
    const rows = await runProbes([factsFor("claude")], parseOptions(["--probe", "H"], ""), {
      async run() { throw new Error("H must not run without the opt-in"); },
      async capture() { throw new Error("H must not run without the opt-in"); },
    }, reportDirectory, fixture.env);
    expect(rows[0]!.results.H!.status).toBe("SKIP");
    expect(rows[0]!.results.H!.note).toContain("LIVE_GATE_PROVIDER_OVERRIDE=1");
    const report = formatReport(reportInput({ rows, probes: ["H"] }));
    expect(report).toContain("SKIP (opt-in probe: --probe provider-override with LIVE_GATE_PROVIDER_OVERRIDE=1");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("live gate prepares private nonce files and gives the outer deadline 30 extra seconds", async () => {
  const fixture = loggedInEnv();
  const calls: string[][] = [];
  const directories: string[] = [];
  const reportDirectory = fixtureDirectory();
  const runner = {
    async run(command: string[], expected: string, timeout: number, prefix?: string) {
      calls.push(command);
      expect(command[0]).toBe(join(ROOT, "bin/codemux"));
      expect(timeout).toBe(42);
      expect(command.slice(1, 3)).toEqual(["run", "-a"]);
      expect(command).not.toContain("--no-sandbox");
      expect(command).toContain("--timeout");
      expect(command[command.indexOf("--timeout") + 1]).toBe("12");
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
        expect(readdirSync(cwd).sort()).toEqual(["nonce.txt", "probe.sh"]);
        const nonce = readFileSync(join(cwd, "nonce.txt"), "utf8");
        expect(nonce).toMatch(/^[0-9a-f]{12}$/);
        const { createHash } = await import("node:crypto");
        expect(expected).toBe(createHash("sha256").update(nonce).digest("hex").slice(0, 16));
        expect(statSync(join(cwd, "nonce.txt")).mode & 0o777).toBe(0o600);
        expect(readFileSync(join(cwd, "probe.sh"), "utf8")).not.toContain(expected);
        expect(statSync(join(cwd, "probe.sh")).mode & 0o777).toBe(0o700);
      } else {
        expect(expected).toBe("OK");
        expect(readdirSync(cwd)).toEqual([]);
      }
      expect(dirname(cwd)).toBe(tmpdir());
      expect(cwd.startsWith(`${ROOT}/`)).toBe(false);
      directories.push(cwd);
      expect(prefix).toBe(join(reportDirectory, `${command[3]}-${medium ? "B" : "A"}`));
      return { status: "PASS" as const, seconds: 0, stderr: "" };
    },
    async capture() { throw new Error("unexpected capture probe"); },
  };
  try {
    const rows = await runProbes([factsFor("agy"), factsFor("kimi"), factsFor("gemini")], parseOptions(["--skip", "gemini", "--probe", "A,B", "--timeout", "12"], ""), runner, reportDirectory, fixture.env);
    expect(calls).toHaveLength(4);
    expect(directories).toHaveLength(4);
    expect(new Set(directories).size).toBe(4);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(formatReport(reportInput({ rows, probes: ["A", "B"] }))).toContain(`live-gate (${join(ROOT, "bin/codemux")}): 4 pass, 0 fail, 2 skip, 0 unsupported`);
    expect(rows.every((row) => row.agent === "gemini" || (row.results.A!.status === "PASS" && row.results.B!.status === "PASS"))).toBe(true);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test.each(["command", "sha256sum fallback", "echo nonce", "wrong stdout", "codemux-ok"])("live gate requires the nonce hash from command execution: %s", async (output) => {
  const reportDirectory = fixtureDirectory();
  const runner = new ProbeRunner();
  try {
    const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", "A,B"], ""), {
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
              process.stdout.write(fs.readFileSync(dir + "/nonce.txt", "utf8"));`;
            probe = [process.execPath, "-e", source, cwd];
          }
        }
        return runner.run(probe, expected, timeout, prefix);
      },
      async capture() { throw new Error("unexpected capture probe"); },
    }, reportDirectory, loggedInEnv().env);
    expect(rows[0]!.results.A!.status).toBe("PASS");
    expect(rows[0]!.results.B!.status).toBe(["command", "sha256sum fallback"].includes(output) ? "PASS" : "FAIL");
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
    const rows = await runProbes([factsFor("cursor"), factsFor("agy")], parseOptions(["--timeout", "12", "--probe", "A,B"], ""), {
      async run(command, _expected, timeout) {
        calls.push(command);
        expect(timeout).toBe(42);
        expect(command[command.indexOf("--timeout") + 1]).toBe("12");
        expect(command.indexOf("--pass-env")).toBe(-1);
        expect(command).not.toContain("CODEMUX_CURSOR_ENTRY");
        return { status: "PASS", seconds: 0, stderr: "" };
      },
      async capture() { throw new Error("unexpected capture probe"); },
    }, reportDirectory, loggedInEnv().env);
    expect(calls).toHaveLength(4);
    expect(rows.every((row) => row.results.A!.status === "PASS" && row.results.B!.status === "PASS")).toBe(true);
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
    const rows = await runProbes([factsFor("cursor"), factsFor("agy")], parseOptions(["--pass-env", names, "--probe", "A,B"], ""), {
      async run(command) {
        calls.push(command);
        expect(command.filter((arg) => arg === "--pass-env")).toHaveLength(1);
        expect(command[command.indexOf("--pass-env") + 1]).toBe(names);
        return { status: "PASS", seconds: 0, stderr: "" };
      },
      async capture() { throw new Error("unexpected capture probe"); },
    }, reportDirectory, loggedInEnv().env);
    expect(calls).toHaveLength(4);
    expect(rows.every((row) => row.results.A!.status === "PASS" && row.results.B!.status === "PASS")).toBe(true);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("live gate cleans probe directories when the runner rejects", async () => {
  const reportDirectory = fixtureDirectory();
  const directories: string[] = [];
  try {
    const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", "A,B"], ""), {
      async run(command) {
        directories.push(command[command.indexOf("--cwd") + 1]!);
        throw new Error("test failure");
      },
      async capture() { throw new Error("test failure"); },
    }, reportDirectory, loggedInEnv().env);
    expect(directories).toHaveLength(2);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
    expect(formatReport(reportInput({ rows, probes: ["A", "B"] }))).toContain(`live-gate (${join(ROOT, "bin/codemux")}): 0 pass, 2 fail, 0 skip, 0 unsupported`);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("live gate includes only selected harnesses in its probes, report, and totals", async () => {
  const reportDirectory = fixtureDirectory();
  const calls: string[] = [];
  const options = parseOptions(["--only", "agy,kimi", "--skip", "kimi", "--probe", "A,B"], "");
  try {
    const rows = await runProbes([factsFor("agy"), factsFor("kimi"), factsFor("gemini")], options, {
      async run(command) {
        const agent = command[3]!;
        calls.push(agent);
        return { status: "PASS", seconds: 0, stderr: "" };
      },
      async capture() { throw new Error("unexpected capture probe"); },
    }, reportDirectory, loggedInEnv().env);
    expect(calls).toEqual(["agy", "agy"]);
    expect(rows.map((row) => row.agent)).toEqual(["agy", "kimi"]);
    const report = formatReport(reportInput({ rows, only: options.only, probes: ["A", "B"] }));
    expect(report.split("\n")[2]).toBe("Scope: --only agy,kimi (installed harnesses only).");
    expect(report).not.toContain("gemini");
    expect(report).toContain(`live-gate (${join(ROOT, "bin/codemux")}): 2 pass, 0 fail, 2 skip, 0 unsupported`);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

// Review round 3, edges/contracts-2: probe G must carry a model on codex
// (a codex experiment refuses model_required without one), probe F must
// speak the session protocol's JSONL grammar and require a completed
// turn, and probe H must fail a harness that ignores the override.
test("the codex experiment probe carries a model; the other G harnesses default", async () => {
  const reportDirectory = fixtureDirectory();
  const commands: { agent: string; command: string[] }[] = [];
  try {
    await runProbes([factsFor("codex"), factsFor("kimi"), factsFor("claude"), factsFor("zai")],
      parseOptions(["--probe", "G"], ""), {
        async run() { throw new Error("unexpected exact-output probe"); },
        async capture(command) {
          commands.push({ agent: command[3]!, command });
          return { status: "PASS", seconds: 0, stderr: "" };
        },
      }, reportDirectory, loggedInEnv().env);
    const codex = commands.find((call) => call.agent === "codex")!;
    expect(codex.command).toContain("--experiment-mcp");
    expect(codex.command[codex.command.indexOf("-m") + 1]).toBe("worker");
    for (const other of ["kimi", "claude", "zai"]) {
      expect(commands.find((call) => call.agent === other)!.command).not.toContain("-m");
    }
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("probe H is unsupported for an override harness without result JSON or served-model evidence", async () => {
  const reportDirectory = fixtureDirectory();
  try {
    // droid: no result JSON; codex: served_model only from a reroute notice
    // (round 26, edges 2); claude: full evidence.
    const rows = await runProbes([factsFor("droid"), factsFor("codex"), factsFor("claude")],
      parseOptions(["--probe", "H"], ""), {
        async run() { throw new Error("H must not run as an exact-output probe"); },
        async capture() { return { status: "PASS", seconds: 0, stderr: "" }; },
      }, reportDirectory, loggedInEnv({
        LIVE_GATE_PROVIDER_OVERRIDE: "1",
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8011/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
        CODEMUX_CLAUDE_PROVIDER_MODEL: "glm-5.3",
      }).env);
    expect(rows[0]!.results.H).toMatchObject({ status: "UNSUPPORTED" });
    expect(rows[1]!.results.H).toMatchObject({ status: "UNSUPPORTED" });
    expect(rows[2]!.results.H!.status).toBe("PASS");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("the hermetic check's outer deadline covers both of its launches (round 18, edges 3)", async () => {
  // A hermetic check is two sequential children — the probe, then the
  // control — each with the full --timeout (src/check-command.ts), so D
  // needs 2 * timeout + 30 while every single-launch probe keeps
  // timeout + 30. The session form (K) is three sequential session
  // launches — hermetic, control, resumed — so it needs 3 * timeout + 30.
  const reportDirectory = fixtureDirectory();
  const allowances: { letter: string; timeout: number }[] = [];
  const runner = {
    async run(_command: string[], _expected: string, timeout: number) {
      allowances.push({ letter: "A", timeout });
      return { status: "PASS" as const, seconds: 0, stderr: "" };
    },
    async capture(command: string[], _verify: unknown, timeout: number) {
      const letter = command[1] === "check" ? (command.includes("--session") ? "K" : "D") : "?";
      allowances.push({ letter, timeout });
      return { status: "PASS" as const, seconds: 0, stderr: "" };
    },
  };
  try {
    const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", "A,D,K", "--timeout", "12"], ""), runner, reportDirectory, loggedInEnv().env);
    expect(allowances).toEqual([
      { letter: "A", timeout: 42 },
      { letter: "D", timeout: 54 },
      { letter: "K", timeout: 66 },
    ]);
    expect(rows[0]!.results.A!.status).toBe("PASS");
    expect(rows[0]!.results.D!.status).toBe("PASS");
    expect(rows[0]!.results.K!.status).toBe("PASS");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("a failed probe keeps its directory and recording under the report directory", async () => {
  // The 2026-11-02 codex G timeout removed its recording with the probe
  // directory, leaving a 300 s failure with no evidence to read.
  const reportDirectory = fixtureDirectory();
  try {
    const rows = await runProbes([factsFor("claude")], parseOptions(["--probe", "G"], ""), {
      async run() { return { status: "PASS", seconds: 0, stderr: "" }; },
      async capture(command) {
        const cwd = command[command.indexOf("--cwd") + 1]!;
        writeFileSync(join(cwd, "evidence.jsonl"), `${JSON.stringify({ kind: "run_start" })}\n`);
        return { status: "FAIL", seconds: 1, stderr: "agent timed out", note: "Warning: slow" };
      },
    }, reportDirectory, loggedInEnv().env);
    const result = rows[0]!.results.G!;
    expect(result.status).toBe("FAIL");
    const kept = join(reportDirectory, "claude-G-probe");
    expect(result.note).toBe(`Warning: slow; probe directory kept at ${kept}`);
    expect(readFileSync(join(kept, "evidence.jsonl"), "utf8")).toContain("run_start");
  } finally { rmSync(reportDirectory, { recursive: true, force: true }); }
});
