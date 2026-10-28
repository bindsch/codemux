import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../src/adapters/agy.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { agyKeychainHost, AGY_MIRROR_PATH, AGY_TEMPLATE_NAME, agyKeychainStateDir, recoverAgyKeychainSearchList } from "../src/agy-keychain.js";
import { CodexPlainFold, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { CodexEventReducer } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES, runCapturedCommand } from "../src/process-runner.js";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { registerRunExitCleanup } from "../src/run-exit-cleanup.js";

test("selected API keys never inspect or read the unused file token", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "codemux-0131-key-"));
  const host = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const security = spyOn(agyKeychainHost, "securityPath").mockReturnValue(undefined);
  const token = join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
  fs.mkdirSync(join(home, ".gemini/antigravity-cli"), { recursive: true });
  fs.writeFileSync(token, "unreadable fallback", { mode: 0o000 });
  const original = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path, ...args) => {
    if (String(path) === token) throw new Error("unused token was inspected");
    return original(path, ...args);
  }) as typeof fs.lstatSync);
  try {
    for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      const adapter = new AgyAdapter({ HOME: home, [key]: "synthetic-key" });
      const context = adapter.prepareRun({ agent: "agy", prompt: "test", sandboxed: true, hermetic: true });
      expect(fs.existsSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/antigravity-oauth-token"))).toBe(false);
      adapter.cleanupRun(context);
    }
  } finally {
    stat.mockRestore(); security.mockRestore(); host.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stale sweeping validates HOME first and requires owned entries in both roots", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "codemux-0131-sweep-"));
  const host = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const security = spyOn(agyKeychainHost, "securityPath").mockReturnValue(undefined);
  const supplied = join(home, "supplied");
  const root = (base: string) => join(base, ".gemini/.codemux-isolation-probes");
  const seed = (base: string, name: string, marked = true) => {
    const path = join(root(base), name);
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, ".codemux-probe-pid"), "2147483647");
    if (marked) fs.writeFileSync(join(path, ".codemux-probe-owner"), crypto.randomUUID());
    return path;
  };
  const owned = seed(home, "run-owned");
  const unmarked = seed(home, "run-unmarked", false);
  const relocated = seed(supplied, "run-relocated");
  const request = { agent: "agy" as const, prompt: "test", sandboxed: false };
  try {
    expect(() => new AgyAdapter({ HOME: "." }).prepareRun(request)).toThrow("absolute");
    expect(fs.existsSync(owned)).toBe(true);
    const original = fs.lstatSync;
    const stat = spyOn(fs, "lstatSync").mockImplementation(((path, ...args) => {
      const value = original(path, ...args);
      if (value && String(path) === fs.realpathSync(supplied)) return Object.assign(value, { uid: -1 });
      return value;
    }) as typeof fs.lstatSync);
    try { expect(() => new AgyAdapter({ HOME: supplied }).prepareRun(request)).toThrow("user-owned"); }
    finally { stat.mockRestore(); }
    expect(fs.existsSync(owned)).toBe(true);
    new AgyAdapter({ HOME: supplied }).prepareRun(request);
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.existsSync(unmarked)).toBe(true);
    expect(fs.existsSync(relocated)).toBe(false);
  } finally {
    security.mockRestore(); host.mockRestore(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Keychain recovery preserves unrelated lookalikes and canonical symlink escapes", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "codemux-0131-recovery-"));
  const host = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const security = spyOn(agyKeychainHost, "securityPath").mockReturnValue(process.execPath);
  const root = join(home, ".gemini/.codemux-isolation-probes");
  const outside = join(home, "outside");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(root, "run-link"));
  const foreign = "/Volumes/team/.codemux-isolation-probes/run-production/customer.keychain-db";
  const escape = join(root, "run-link/customer.keychain-db");
  const parentEscape = `${root}/run-link/../customer.keychain-db`;
  const owned = join(root, "run-old", AGY_MIRROR_PATH);
  const template = join(agyKeychainStateDir(), AGY_TEMPLATE_NAME);
  let list = [foreign, owned, escape, parentEscape, template, join(home, "ordinary.keychain-db")];
  const spawn = spyOn(agyKeychainHost, "spawnSync").mockImplementation(((args: string[]) => {
    if (args[1] === "list-keychains" && args[4] === "-s") list = args.slice(5);
    const output = args[1] === "default-keychain" ? `"${join(home, AGY_MIRROR_PATH)}"` : list.map((path) => `"${path}"`).join("\n");
    return { exitCode: 0, stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
  }) as typeof Bun.spawnSync);
  const warning = spyOn(console, "error").mockImplementation(() => {});
  try {
    recoverAgyKeychainSearchList({});
    expect(list).toEqual([foreign, escape, parentEscape, join(home, "ordinary.keychain-db")]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("left an unrelated keychain"));
  } finally {
    warning.mockRestore(); spawn.mockRestore(); security.mockRestore(); host.mockRestore();
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

test("Claude credential preparation uses the injected child HOME", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "codemux-0131-claude-"));
  fs.mkdirSync(join(home, ".claude"));
  const target = join(home, ".claude/.credentials.json");
  fs.writeFileSync(target, JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "" } }));
  class TestAdapter extends ClaudeAdapter {
    protected override credentialReader = () => ({ kind: "secret" as const,
      value: JSON.stringify({ claudeAiOauth: { accessToken: "fresh", refreshToken: "", expiresAt: Date.now() + 3_600_000 } }) });
    protected override credentialBackupDir = () => join(home, "backups");
  }
  try {
    const adapter = new TestAdapter({ HOME: home });
    adapter.prepareSandbox();
    expect(adapter.buildExecutionEnv().HOME).toBe(home);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).claudeAiOauth.accessToken).toBe("fresh");
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
