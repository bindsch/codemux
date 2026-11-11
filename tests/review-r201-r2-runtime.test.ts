import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { spawn } from "node:child_process";
import { createPiMcpStdioTransport } from "../src/pi-mcp-stdio.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { qwenExperimentResult } from "../src/qwen-experiment-run.js";
import { emptyUsage } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunContext } from "../src/adapters/base.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { launchRunRequest } from "../src/launch.js";
import * as runtime from "../src/cli-runtime.js";
import * as cost from "../src/codex-native-cost.js";
import * as receipts from "../src/launch/receipts.js";

function transport(broken = false) {
  const signals: string[] = [], sent: Record<string, unknown>[] = [];
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    sent.push(JSON.parse(chunk.toString()));
    callback(broken ? new Error("synthetic EPIPE") : undefined);
  } });
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout,
    kill(signal: string) { signals.push(signal); } });
  const client = createPiMcpStdioTransport("/synthetic/server", [], (() => child) as unknown as typeof spawn);
  const reply = (message: unknown) => stdout.write(JSON.stringify(message) + "\n");
  return { client, child, stdin, stdout, signals, sent, reply };
}

test.each(["stdin", "stdout"] as const)("Pi handles %s stream errors and awaits child cleanup", async (stream) => {
  const t = transport(stream === "stdin");
  // The observer prevents a broken transport from crashing the test runner.
  // Registration is asserted separately so it cannot hide the regression.
  const handlers = t[stream].listenerCount("error");
  let observed = false;
  t[stream].on("error", () => { observed = true; });
  const pending = t.client.request("tools/list");
  const rejected = pending.catch((error) => error);
  if (stream === "stdout") t.stdout.destroy(new Error("synthetic read error"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(handlers).toBeGreaterThan(0);
    expect(observed).toBe(true);
    expect(await rejected).toBeInstanceOf(Error);
    expect(t.signals).toContain("SIGTERM");
    let closed = false;
    const closing = t.client.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    t.child.emit("close");
    await closing;
  } finally { t.child.emit("close"); await t.client.close(); t.stdin.destroy(); t.stdout.destroy(); }
});

test("Pi accepts server notifications and refuses unsupported requests without losing pending replies", async () => {
  const t = transport();
  const pending = t.client.request("tools/list");
  const settled = pending.catch((error) => error);
  try {
    t.reply({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
    t.reply({ jsonrpc: "2.0", method: "sampling/createMessage", id: "server-1", params: {} });
    t.reply({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(await settled).toEqual({ tools: [] });
    expect(t.sent.at(-1)).toMatchObject({ id: "server-1", error: { code: -32601 } });
    expect(t.signals).toEqual([]);
  } finally { t.child.emit("close"); await t.client.close(); t.stdin.destroy(); t.stdout.destroy(); }
});

test("Pi releases inherited pipes after server exit so close cannot wait on a helper", async () => {
  const t = transport();
  let closed = false;
  const closing = t.client.close().then(() => { closed = true; });
  t.stdout.once("close", () => t.child.emit("close"));
  t.child.emit("exit", 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(t.stdin.destroyed).toBe(true);
    expect(t.stdout.destroyed).toBe(true);
    expect(closed).toBe(true);
  } finally { t.child.emit("close"); await closing; t.stdin.destroy(); t.stdout.destroy(); }
});

test.each(["answer", "x".repeat(MAX_CAPTURE_BYTES / 2 + 1)])("Copilot plain experiment returns a bounded answer without JSON duplication (%#. case)", (answer) => {
  const result = new CopilotAdapter({}).processRunResult({ success: true, exitCode: 0, stderr: "",
    stdout: JSON.stringify({ type: "assistant.message", data: { content: answer } }) + "\n" },
  { agent: "copilot", prompt: "p" }, { experimentCopilot: { usage: emptyUsage(),
    recordingPath: "recording", capturedOutput: "wire" } } as unknown as RunContext);
  expect(result.success).toBe(true);
  expect(result.stdout.length).toBe(answer.length + 1);
  expect(result.stdout).toBe(answer + "\n");
  expect(result.scanSurface).toBe("wire");
});

test("Qwen plain experiment drops partial answers after a native failure", () => {
  const result = qwenExperimentResult({ success: true, exitCode: 0, stderr: "", stdout:
    JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "partial",
      session_id: "synthetic", error: "failed" }) + "\n" }, { agent: "qwen", prompt: "p" }, "recording");
  expect(result.success).toBe(false);
  expect(result.stdout).toBe("");
});

test("sandboxed Codex cost interruption cleans the launch and writes its interruption receipt", async () => {
  const adapter = new CodexAdapter({});
  const context: RunContext = {};
  const order: string[] = [];
  const command = ["/synthetic/codex", "exec", "--json", "-"];
  const request = { agent: "codex" as const, prompt: "synthetic", sandboxed: true };
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "prepareSandbox").mockImplementation(() => {}),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(command),
    spyOn(adapter, "cleanupRun").mockImplementation(async (actual) => {
      expect(actual).toBe(context);
      order.push("cleanup");
    }),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async (...args) => {
      args[14]?.(command, [], args[5]);
      return { success: true, exitCode: 0, stdout: "answer", stderr: "" };
    }),
    spyOn(cost, "collectCodexNativeCost").mockImplementation(async (_raw, _request, _context, binding) => {
      expect(binding.options.sandboxed).toBe(true);
      await cost.readCodexNativeCost(binding, "01234567-89ab-cdef-0123-456789abcdef", async () => {
        let settle!: () => void;
        return {
          settled: new Promise<void>((resolve) => { settle = resolve; }),
          requestStop() { order.push("stop"); settle(); },
          writeLine() { queueMicrotask(() => process.emit("SIGTERM")); return { ok: true }; },
        };
      });
    }),
    spyOn(receipts, "appendInterruptedLaunchReceipt").mockImplementation((_provider, actual, _options, actualContext) => {
      expect(actual).toBe(request);
      expect(actualContext).toBe(context);
      order.push("interrupted receipt");
    }),
    // A mocked process.exit throws back into the launch; real exit cannot
    // reach this catch path. Keep its synthetic failure out of the ledger.
    spyOn(receipts, "appendFailedLaunchReceipt").mockImplementation(() => {}),
    spyOn(receipts, "recordCompletedLaunch").mockImplementation(() => { order.push("completed receipt"); }),
    spyOn(process, "exit").mockImplementation((code) => { order.push(`exit ${code}`); throw new Error(`exit ${code}`); }),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  try {
    await expect(launchRunRequest(adapter, request,
      { sandbox: true, requestedAutonomy: "read-only", harnessVersion: "0.166.0" })).rejects.toThrow("exit 143");
    expect(order).toEqual(["stop", "cleanup", "interrupted receipt", "exit 143"]);
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});
