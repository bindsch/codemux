import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeEnvironment } from "../src/environment.js";
import { DEFAULT_VERSION_PROBE_TIMEOUT_MS, HARNESS_CONTRACTS, probeHarnessVersionDetailed } from "../src/harness-compatibility.js";
import { cursorModelsAnswer, helpAnswer, runOutputProbe, versionAnswer } from "../src/output-probe.js";
import { readProcessTable } from "../src/process-table.js";
import { runCapturedCommand } from "../src/process-runner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fake(body: string) {
  const root = mkdtempSync(join(tmpdir(), "codemux-output-probe-"));
  roots.push(root);
  const binary = join(root, "fake-harness");
  writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  chmodSync(binary, 0o755);
  return { root, binary, options: { cwd: root, env: {}, timeoutMs: 500 } };
}

const models = "Available models\n\nclerk - Clerk\nworker - Worker\n\n" +
  "Tip: use --model <id> (or /model <id> in interactive mode) to switch.\n";
const print = (text: string) => `printf '%s' '${text.replaceAll("'", "'\\''")}'`;

describe("one-shot output probes", () => {
  test.each(["stdout", "stderr"])("only a complete stdout version accepts an exit hang (%s)", async (stream) => {
    const f = fake(`${print("2026.11.05-86047df\n")} ${stream === "stderr" ? ">&2" : ""}\n/bin/sleep 30`);
    const result = await probeHarnessVersionDetailed(f.binary, HARNESS_CONTRACTS.cursor!, f.root,
      probeEnvironment({}), "cursor-agent", { timeoutMs: 500 });
    expect(result).toEqual(stream === "stdout"
      ? { version: "2026.11.05", timedOut: false }
      : { version: null, timedOut: true });
  });

  test("a split prerelease waits for the rest of the version line", async () => {
    const f = fake(`${print("1.2.3")}\n/bin/sleep 0.1\n${print("-beta.1\n")}\n/bin/sleep 30`);
    const contract = { ...HARNESS_CONTRACTS.claude!, pattern: /(\d+\.\d+\.\d+(?:-[\w.]+)?)/ };
    const result = await probeHarnessVersionDetailed(f.binary, contract, f.root,
      probeEnvironment({}), "claude", { timeoutMs: 500 });
    expect(result).toEqual({ version: "1.2.3-beta.1", timedOut: false });
  });

  test("an unterminated version is not accepted before EOF", async () => {
    const f = fake(`${print("2026.11.05")}\n/bin/sleep 30`);
    const result = await probeHarnessVersionDetailed(f.binary, HARNESS_CONTRACTS.cursor!, f.root,
      probeEnvironment({}), "cursor-agent", { timeoutMs: 100 });
    expect(result).toEqual({ version: null, timedOut: true });
  });

  test("version output ending at EOF needs no newline", async () => {
    const f = fake(print("2026.11.05-86047df"));
    expect(await probeHarnessVersionDetailed(f.binary, HARNESS_CONTRACTS.cursor!, f.root,
      probeEnvironment({}), "cursor-agent", { timeoutMs: 500 }))
      .toEqual({ version: "2026.11.05", timedOut: false });
  });

  test("complete model listing survives an exit hang and kills its whole group", async () => {
    // The leader and its child ignore TERM, requiring the runner's group KILL.
    const f = fake(`trap '' TERM\n/bin/sleep 30 &\nprintf '%s %s' "$$" "$!" > pids\n${print(models)}\nwait`);
    const result = await runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer);
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.stdout).toBe(models);
    const table = readProcessTable();
    for (const pid of readFileSync(join(f.root, "pids"), "utf8").split(" ").map(Number)) {
      expect(table.has(pid)).toBe(false);
    }
  });

  test("model completion waits for the footer, including later rows", async () => {
    const f = fake(`${print("Available models\n\nclerk - Clerk\n")}\n/bin/sleep 0.1\n` +
      `${print("worker - Worker\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n")}\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(models);
  });

  test("an incomplete model listing still times out with its output retained", async () => {
    const partial = "Available models\n\nclerk - Clerk\n";
    const f = fake(`${print(partial)}\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "models"], { ...f.options, timeoutMs: 100 }, cursorModelsAnswer);
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe(partial);
  });

  test("model footer accepts terminal colors without truncating the capture", async () => {
    const colored = models.replace("Available models", "\x1b[2mAvailable models\x1b[0m");
    const f = fake(`${print(colored)}\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(colored);
  });

  test("authentication errors remain failures", async () => {
    const f = fake(`${print("Authentication required\n")} >&2\nexit 1`);
    const result = await runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Authentication required\n");
  });

  test.each(["version", "models", "help"])("a natural nonzero %s exit remains a failure", async (kind) => {
    const output = kind === "models" ? models : kind === "help" ? "--keep-env NAME\n" : "1.2.3\n";
    const answer = kind === "models" ? cursorModelsAnswer : kind === "help" ? helpAnswer(["--keep-env"]) : versionAnswer(/(1\.2\.3)/);
    const f = fake(`${print(output)}\nexit 7`);
    const result = await runOutputProbe([f.binary], f.options, answer);
    expect(result.exitCode).toBe(7);
    expect(result.success).toBe(false);
  });

  test("help accepts every requested capability at the deadline", async () => {
    const f = fake(`${print("Options:\n  --first X\n")}\n/bin/sleep 0.1\n${print("  --second Y\n")}\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "--help"], f.options, helpAnswer(["--first", "--second"]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--second");
  });

  test("help missing a required capability cannot succeed on timeout", async () => {
    const f = fake(`${print("Options:\n  --first X\n")}\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "--help"], { ...f.options, timeoutMs: 100 }, helpAnswer(["--second"]));
    expect(result.exitCode).toBe(124);
  });

  test("an unframed probe can complete when both output streams close", async () => {
    const f = fake(`${print("help output\n")}\nexec 1>&- 2>&-\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "--help"], f.options);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("help output\n");
  });

  test("the ordinary command runner still times out after printing", async () => {
    const f = fake(`${print(models)}\n/bin/sleep 30`);
    const result = await runCapturedCommand([f.binary], { ...f.options, timeoutMs: 100 });
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe(models);
  });

  test("completion kills a descendant retaining pipes after its leader exits", async () => {
    const f = fake(`/bin/sleep 30 &\nprintf '%s' "$!" > child\n${print(models)}\nexit 0`);
    const result = await runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(models);
    expect(readProcessTable().has(Number(readFileSync(join(f.root, "child"), "utf8")))).toBe(false);
  });

  test("help split across stdout and stderr cannot succeed on timeout", async () => {
    const f = fake(`${print("--first X\n")}\n${print("--second Y\n")} >&2\n/bin/sleep 30`);
    const result = await runOutputProbe([f.binary, "--help"], f.options, helpAnswer(["--first", "--second"]));
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("--second Y\n");
  });

  test("a child's own signal exit is not successful probe termination", async () => {
    const f = fake(`${print(models)}\nkill -TERM $$`);
    const result = await runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer);
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  test.each([
    ['kill -TERM $$', 143],
    ['exit 7', 7],
  ] as const)("preserves leader status from %s while a descendant retains its pipes", async (ending, code) => {
    const f = fake("");
    const command = ["/bin/sh", "-c", `/bin/sleep 0.2 & printf "1.2.3\\n"; ${ending}`];
    const ordinary = await runCapturedCommand(command, f.options);
    const probe = await runOutputProbe(command, f.options, versionAnswer(/(1\.2\.3)/));
    for (const result of [ordinary, probe]) {
      expect(result.stdout).toBe("1.2.3\n");
      expect(result.exitCode).toBe(code);
      expect(result.success).toBe(false);
      expect(result.timedOut).toBeUndefined();
    }
  });

  test("invalid UTF-8 still fails after an answer is printed", async () => {
    const f = fake(`${print(models)}\n/bin/sleep 0.15\nprintf '\\377' >&2\n/bin/sleep 30`);
    await expect(runOutputProbe([f.binary, "models"], f.options, cursorModelsAnswer))
      .rejects.toThrow("stderr is not valid UTF-8");
  });

  test.each([7, 0])("waits for a delayed natural exit %s after complete output", async (code) => {
    const f = fake("");
    const command = ["/bin/sh", "-c", `printf "1.2.3\\n"; /bin/sleep 0.15; exit ${code}`];
    const options = { ...f.options, timeoutMs: 1_000 };
    const ordinary = await runCapturedCommand(command, options);
    const start = performance.now();
    const probe = await runOutputProbe(command, options, versionAnswer(/(1\.2\.3)/));
    expect(performance.now() - start).toBeGreaterThanOrEqual(150);
    expect(probe).toEqual(ordinary);
    expect(probe.exitCode).toBe(code);
    expect(probe.success).toBe(code === 0);
    expect(probe.stoppedAfterOutput).toBeUndefined();
  });

  test("print then hang runs until the configured deadline and marks termination", async () => {
    const f = fake(`${print("1.2.3\n")}\n/bin/sleep 30`);
    const start = performance.now();
    const result = await runOutputProbe([f.binary], f.options, versionAnswer(/(1\.2\.3)/));
    expect(performance.now() - start).toBeGreaterThanOrEqual(f.options.timeoutMs);
    expect(result).toEqual({ stdout: "1.2.3\n", stderr: "", exitCode: 0,
      success: true, stoppedAfterOutput: true });
  });

  test.each([
    ["kill -TERM $$", 143, "1.2.3\n"],
    ["exit 7", 7, "1.2.3\n"],
    ["exit 0", 0, "1.2.3\n"],
    ["kill -TERM $$", 143, ""],
    ["exit 7", 7, ""],
    ["exit 0", 0, ""],
  ] as const)("keeps %s (code %s, output %j) with pipes open past the deadline", async (ending, code, output) => {
    const f = fake(`/bin/sleep 30 &\nprintf '%s' "$!" > child\n${print(output)}\n/bin/sleep 0.15\n${ending}`);
    const result = await runOutputProbe([f.binary], f.options, versionAnswer(/(1\.2\.3)/));
    expect(result).toEqual({ stdout: output, stderr: "", exitCode: code, success: code === 0 });
    expect(readProcessTable().has(Number(readFileSync(join(f.root, "child"), "utf8")))).toBe(false);
  });

  test("no output then hang remains a timeout", async () => {
    const f = fake("/bin/sleep 30");
    const result = await runOutputProbe([f.binary], { ...f.options, timeoutMs: 100 }, versionAnswer(/(1\.2\.3)/));
    expect(result).toEqual({ stdout: "", stderr: "Error: agent timed out after 100ms\n",
      exitCode: 124, success: false, timedOut: true });
  });

  test("the default version deadline accepts a Cursor-style 30-second hang", async () => {
    const f = fake(`${print("2026.11.05-86047df\n")}\n/bin/sleep 30`);
    expect(HARNESS_CONTRACTS.cursor!.versionTimeoutMs).toBeLessThan(30_000);
    const result = await probeHarnessVersionDetailed(f.binary, HARNESS_CONTRACTS.cursor!, f.root,
      probeEnvironment({}), "cursor-agent");
    expect(result).toEqual({ version: "2026.11.05", timedOut: false });
  }, 10_000);

  test("other harnesses retain time for a slow version startup", async () => {
    const f = fake(`/bin/sleep 6\n${print("OpenHands CLI 1.16.0\n")}`);
    expect(DEFAULT_VERSION_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(await probeHarnessVersionDetailed(f.binary, HARNESS_CONTRACTS.openhands!, f.root,
      probeEnvironment({}), "openhands")).toEqual({ version: "1.16.0", timedOut: false });
  }, 10_000);

  test("a clean exit can still report its version on stderr", async () => {
    const f = fake(`${print("2026.11.05-86047df\n")} >&2`);
    expect(await probeHarnessVersionDetailed(f.binary, HARNESS_CONTRACTS.cursor!, f.root,
      probeEnvironment({}), "cursor-agent", { timeoutMs: 500 }))
      .toEqual({ version: "2026.11.05", timedOut: false });
  });
});
