import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexPlainFold, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { CodexEventReducer } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES, runCapturedCommand } from "../src/process-runner.js";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { registerRunExitCleanup } from "../src/run-exit-cleanup.js";

test("API-key launches neither link nor inspect an existing token", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "codemux-0131-key-"));
  const token = join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
  fs.mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
  fs.writeFileSync(token, "unreadable fallback", { mode: 0o000 });
  const original = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path, ...args) => {
    if (String(path) === token) throw new Error("unused token was inspected");
    return original(path, ...args);
  }) as typeof fs.lstatSync);
  try {
    for (const key of ["GEMINI_API_KEY"]) {
      const adapter = new AgyAdapter({ HOME: home, [key]: "synthetic-key" });
      const context = adapter.prepareRun({ agent: "agy", prompt: "test", sandboxed: true, hermetic: true });
      // The key is the route: no path to the operator's token (review round 5).
      expect(fs.readdirSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli"))).not.toContain("antigravity-oauth-token");
      adapter.cleanupRun(context);
    }
  } finally {
    stat.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test.each([0, 2])("protocol cleanup preserves child exit %s and both captured streams", async (exitCode) => {
  let output = "";
  const result = await runCapturedCommand([process.execPath, "-e",
    `process.stdout.write('answer'); process.stderr.write('authentication diagnostic'); process.exit(${exitCode})`], {
    cwd: process.cwd(), env: {}, stdoutSink: {
      push(chunk) { output += chunk; }, finish() { return output; }, keptBytes() { return output.length; },
      closeProtocol() { throw new Error("recording fsync failed"); },
    },
  });
  expect(result).toMatchObject({ stdout: "answer", exitCode, success: exitCode === 0,
    stderr: "authentication diagnostic\nNote: cleanup failed: recording fsync failed\n" });
});

test("a completed Plan reply survives a later nonzero Codex exit", () => {
  const stdout = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }]
    .map((event) => JSON.stringify(event)).join("\n");
  const result = codexPlainStreamResult({ stdout, stderr: "late failure", exitCode: 2, success: false },
    () => ({ outcome: "text", text: "Plan reply" }));
  expect(result).toMatchObject({ stdout: "Plan reply\n", exitCode: 2, success: false });
  expect(result.stderr).toContain("late failure");
});

test("human-mode cumulative capture retains at most 16 MiB across complete lines", () => {
  const first = "a".repeat(10 * 1024 * 1024) + "\n";
  const second = "é".repeat(5 * 1024 * 1024) + "\n";
  for (const chunks of [[first + second], [first, second]]) {
    const fold = new CodexPlainFold();
    for (const chunk of chunks) fold.push(chunk);
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
    const retained = fold.finish();
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(retained.startsWith(first)).toBe(true);
    expect(retained).not.toContain("�");
  }
});

test("a warning after turn.failed is trailing drift, never a startup warning", () => {
  const stream = new CodexEventReducer();
  for (const event of [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "turn.failed", error: { message: "failed" } },
    { type: "item.completed", item: { type: "error", message: "trailing warning" } },
  ]) stream.takeEvent(event);
  expect(stream).not.toBeNull();
  expect(stream!.warnings).not.toContain("trailing warning");
  expect(stream!.drift).toContain("outside a turn");
});

test("Claude preparation preserves the injected child HOME and login", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "codemux-0131-claude-"));
  fs.mkdirSync(join(home, ".claude"));
  const target = join(home, ".claude/.credentials.json");
  fs.writeFileSync(target, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "" } }));
  try {
    const adapter = new ClaudeAdapter({ HOME: home });
    adapter.prepareSandbox();
    expect(adapter.buildExecutionEnv().HOME).toBe(home);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).claudeAiOauth.accessToken).toBe("old");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the exit backstop finalizes a recording synchronously without starting async cleanup", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "codemux-0131-exit-"));
  const bridge = new ExperimentBridge({ name: "experiment", command: process.execPath, args: [], env: [], recording: dir }, dir, "test");
  const adapter = new ClaudeAdapter({});
  const asyncCleanup = spyOn(adapter, "cleanupRun");
  const serverClose = spyOn(ExperimentServer.prototype, "close");
  const before = new Set(process.listeners("exit"));
  const release = registerRunExitCleanup(adapter, { experimentBridge: bridge, stdoutSink: bridge });
  try {
    for (const listener of process.listeners("exit")) if (!before.has(listener)) listener(1);
    expect(asyncCleanup).not.toHaveBeenCalled();
    expect(serverClose).not.toHaveBeenCalled();
    const records = fs.readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ kind: "run_end", error: expect.stringContaining("process exited") });
    bridge.closeSync();
    expect(fs.readFileSync(bridge.recordingPath, "utf8").trim().split("\n")).toHaveLength(records.length);
  } finally {
    release(); asyncCleanup.mockRestore(); serverClose.mockRestore(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
