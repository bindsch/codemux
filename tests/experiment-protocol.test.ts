import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentServer, MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "../src/experiment-server.js";
import { claudeFamilyResult, parseClaudeResultEnvelope } from "../src/result-envelope.js";

const dirs: string[] = [];
const bridges: ExperimentBridge[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function peer() {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-protocol-"));
  dirs.push(cwd);
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  restores.push(() => start.mockRestore());
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "bash" }] } }));
  restores.push(() => request.mockRestore());
  const bridge = new ExperimentBridge({ name: "experiment", command: process.execPath, args: [], env: [] }, cwd, "probe");
  bridges.push(bridge);
  const sent: JsonObject[] = [];
  const end = mock(() => {});
  bridge.start((line) => sent.push(JSON.parse(line)), end, () => {});
  const push = (frame: JsonObject) => bridge.push(JSON.stringify(frame) + "\n");
  const ack = () => push({ type: "control_response", response: { subtype: "success", request_id: sent[0]!.request_id } });
  const mcp = (id: string, message: JsonObject) => push({ type: "control_request", request_id: id,
    request: { subtype: "mcp_message", server_name: "experiment", message: { jsonrpc: "2.0", ...message } } });
  const ready = async () => {
    mcp("list", { id: 1, method: "tools/list" });
    await new Promise((resolve) => setImmediate(resolve));
    ack();
    push({ type: "system", subtype: "init", tools: ["mcp__experiment__bash"] });
  };
  const result = () => push({ type: "result", result: "OK" });
  const call = (id: string, role = "assistant") => push({ type: role, message: { role,
    content: [{ type: "tool_use", id, name: "mcp__experiment__bash", input: {} }] } });
  const invoke = (nativeId: string, rpcId: number) => mcp(`call-${rpcId}`, { id: rpcId, method: "tools/call",
    params: { name: "bash", arguments: {}, _meta: { "claudecode/toolUseId": nativeId } } });
  const delivered = (id: string, text: string, role = "user") => push({ type: role, message: { role,
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
  return { bridge, sent, end, request, push, ack, mcp, ready, result, call, invoke, delivered };
}

test("a rejected control stops later tool calls in the same chunk synchronously", async () => {
  for (const invalid of [{ request_id: "bad", request: { subtype: "unsupported" } }, { request_id: null }]) {
    const p = peer();
    await p.ready();
    p.call("first");
    const before = p.request.mock.calls.length;
    p.bridge.push([
      { type: "control_request", ...invalid },
      { type: "control_request", request_id: "later", request: { subtype: "mcp_message", server_name: "experiment",
        message: { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "bash", arguments: {},
          _meta: { "claudecode/toolUseId": "first" } } } } },
    ].map((frame) => JSON.stringify(frame) + "\n").join(""));
    expect(p.request.mock.calls.length).toBe(before);
    expect(() => p.bridge.finish()).toThrow();
  }
});

test("tool error flags reject non-booleans on both protocol boundaries", async () => {
  for (const side of ["server", "model"]) {
    for (const invalid of ["false", "true", 0, 1, null, {}, []]) {
      const p = peer();
      await p.ready();
      p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10,
        result: { content: [], isError: side === "server" ? invalid : true } });
      p.call("first");
      p.invoke("first", 10);
      await Promise.resolve();
      if (side === "model") {
        expect(() => p.push({ type: "user", message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "first", content: [], is_error: invalid },
        ] } })).toThrow("must be a boolean");
      }
      expect(() => p.bridge.finish()).toThrow("must be a boolean");
    }
  }
});

test("unknown, missing, and non-string frame types fail closed", async () => {
  for (const frame of [{}, { type: null }, { type: 7 }, { type: "unknown" }]) {
    const p = peer();
    await p.ready();
    expect(() => p.push(frame)).toThrow("frame type");
    await expect(p.bridge.closeProtocol()).rejects.toThrow("frame type");
  }
});

test("documented compaction boundaries and tool heartbeats are recorded without aborting", async () => {
  const p = peer();
  await p.ready();
  const notifications = [
    { type: "system", subtype: "compact_boundary", uuid: crypto.randomUUID(), session_id: "session",
      compact_metadata: { trigger: "auto", pre_tokens: 150000 } },
    { type: "tool_progress", tool_use_id: "first", tool_name: "mcp__experiment__bash",
      parent_tool_use_id: null, elapsed_time_seconds: 30, uuid: crypto.randomUUID(), session_id: "session" },
  ];
  for (const frame of notifications) p.push(frame);
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  await p.bridge.closeProtocol();
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const frames = records.filter((record) => record.kind === "control_stdout")
    .map((record) => JSON.parse(Buffer.from(record.bytes_base64, "base64").toString()));
  for (const frame of notifications) expect(frames).toContainEqual(frame);
  expect(records.some((record) => record.kind === "failure")).toBe(false);
});

test("identical parallel calls retain native IDs when requests and replies reverse order", async () => {
  const p = peer();
  await p.ready();
  const replies = new Map<number, (reply: JsonObject) => void>();
  p.request.mockImplementation((message) => new Promise((resolve) => replies.set(message.id, resolve)));
  p.call("first");
  p.call("second");
  p.invoke("second", 20);
  p.invoke("first", 10);
  replies.get(10)!({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "first output" }] } });
  await Promise.resolve();
  replies.get(20)!({ jsonrpc: "2.0", id: 20, result: { content: [{ type: "text", text: "second output" }] } });
  await Promise.resolve();
  p.delivered("second", "second output");
  p.delivered("first", "first output");
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
});

test("a JSON-RPC response with the wrong ID cannot be associated", async () => {
  const p = peer();
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 999, result: { content: [] } });
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  await Promise.resolve();
  expect(() => p.bridge.finish()).toThrow("response id mismatch");
});

test("calls without native ID metadata cannot fall back to matching arguments", async () => {
  const p = peer();
  await p.ready();
  p.call("first");
  p.mcp("call", { id: 10, method: "tools/call", params: { name: "bash", arguments: {} } });
  await Promise.resolve();
  expect(() => p.bridge.finish()).toThrow("matching native tool_use id");
});

test("result cannot bypass tools/list or system/init", async () => {
  const p = peer();
  p.ack();
  expect(p.result).toThrow("inventory and control completion");
});

test("tools/list alone does not validate the harness inventory", async () => {
  const p = peer();
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  p.ack();
  expect(p.result).toThrow("inventory and control completion");
});

test.each(["assistant", "user"])("%s text before validated inventory fails the bridge", async (role) => {
  const p = peer();
  p.ack();
  expect(() => p.push({ type: role, message: { role, content: [{ type: "text", text: "premature answer" }] } }))
    .toThrow("before validated Claude inventory");
  await expect(p.bridge.closeProtocol()).rejects.toThrow("before validated Claude inventory");
});

test.each(["assistant", "user"])("malformed %s message content fails closed and is recorded", async (role) => {
  for (const content of [undefined, null, "text", 1, true,
    { type: "tool_use", id: "hidden", name: "mcp__experiment__bash", input: {} }]) {
    const p = peer();
    await p.ready();
    expect(() => p.push({ type: role, message: { role, content } })).toThrow("message.content must be an array");
    expect(p.result).toThrow("message.content must be an array");
    await expect(p.bridge.closeProtocol()).rejects.toThrow("message.content must be an array");
    const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.kind === "failure")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", result_received: false, error: "Claude message.content must be an array" });
  }
});

test("a large inventory passes through with every inputSchema unchanged (Gaia2-sized, 98 tools)", async () => {
  const p = peer();
  const tools = Array.from({ length: 98 }, (_, i) => ({
    name: `App${i % 7}__function_${i}`,
    description: `function ${i}`,
    inputSchema: { type: "object", properties: { arg: { type: "string", description: `arg ${i}` } }, required: ["arg"] },
  }));
  p.request.mockImplementation(async (message) => ({ jsonrpc: "2.0", id: message.id, result: { tools } }));
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(p.sent.at(-1)!.response.response.mcp_response.result).toEqual({ tools });
  p.ack();
  p.push({ type: "system", subtype: "init", tools: tools.map((tool) => `mcp__experiment__${tool.name}`) });
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
});

test.each([
  ["Calendar__add_calendar_event", true],                 // Gaia2/ARE app functions
  ["browser_navigate", true],                             // Playwright MCP
  ["x".repeat(47), true],                                 // "mcp__experiment__" (17) + 47 = 64 characters
  ["x".repeat(48), false],                                // 65 characters namespaced
  ["two words", false],
  ["", false],
])("experiment tool names are checked by format and namespaced length: %s", async (name, accepted) => {
  const p = peer();
  p.request.mockImplementation(async (message) => ({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name }] } }));
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  if (!accepted) {
    expect(() => p.bridge.finish()).toThrow("unsupported or duplicate tool name");
    return;
  }
  expect(p.sent.at(-1)!.response.response.mcp_response.result).toEqual({ tools: [{ name }] });
  p.ack();
  p.push({ type: "system", subtype: "init", tools: [`mcp__experiment__${name}`] });
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
});

test("text-only conversation frames with inconsistent roles fail and record the failure", async () => {
  for (const role of ["assistant", "user"]) {
    const p = peer();
    await p.ready();
    expect(() => p.push({ type: role, message: {
      role: role === "assistant" ? "user" : "assistant", content: [{ type: "text", text: "OK" }],
    } })).toThrow("message.role must match");
    expect(p.result).toThrow("message.role must match");
    await expect(p.bridge.closeProtocol()).rejects.toThrow("message.role must match");
    const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.kind === "failure")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", result_received: false });
  }
});

test.each([false, true])("empty cursors fetch every inventory page, including forbidden later tools: %s", async (forbidden) => {
  const p = peer();
  p.request.mockImplementation(async (message) => ({ jsonrpc: "2.0", id: message.id,
    result: message.params?.cursor === undefined ? { tools: [{ name: "bash" }], nextCursor: "" } :
      message.params.cursor === "" ? { tools: [], nextCursor: "last" } : { tools: [{ name: forbidden ? "not a tool name" : "read" }] },
  }));
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(p.request.mock.calls.map(([message]) => message.params?.cursor)).toEqual([undefined, "", "last"]);
  if (forbidden) expect(() => p.bridge.finish()).toThrow("unsupported or duplicate tool name");
  else {
    const inventory = p.sent.at(-1)!.response.response.mcp_response.result;
    expect(inventory).toEqual({ tools: [{ name: "bash" }, { name: "read" }] });
    p.ack();
    p.push({ type: "system", subtype: "init", tools: ["mcp__experiment__bash", "mcp__experiment__read"] });
    p.result();
    expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  }
});

test("result cannot overtake an active control request", async () => {
  const p = peer();
  await p.ready();
  p.request.mockImplementation(() => new Promise(() => {}));
  p.mcp("pending", { id: 3, method: "ping" });
  expect(p.result).toThrow("inventory and control completion");
});

test("user tool_use is not evidence of a model call", async () => {
  const p = peer();
  await p.ready();
  expect(() => p.call("first", "user")).toThrow("tool_use must come from the assistant");
});

test("assistant tool_result is not evidence of model delivery", async () => {
  const p = peer();
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "output" }] } });
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  expect(() => p.delivered("first", "output", "assistant")).toThrow("tool_result must be delivered in a user frame");
});

test("outbound control frames are bounded after JSON escaping", async () => {
  const p = peer();
  await p.ready();
  const reply = { jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "" }] } };
  const overhead = Buffer.byteLength(JSON.stringify(reply) + "\n");
  reply.result.content[0]!.text = '"'.repeat(Math.floor((MAX_EXPERIMENT_MESSAGE_BYTES - overhead - 1) / 2));
  expect(Buffer.byteLength(JSON.stringify(reply) + "\n")).toBeLessThan(MAX_EXPERIMENT_MESSAGE_BYTES);
  p.request.mockResolvedValue(reply);
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  await Promise.resolve();
  expect(() => p.bridge.finish()).toThrow("control frame exceeds 1 MiB");
});

test("notification acknowledgment contains no JSON-RPC reply", async () => {
  const p = peer();
  p.request.mockResolvedValue(undefined);
  p.mcp("notification", { method: "notifications/initialized" });
  await Promise.resolve();
  expect(p.sent.at(-1)!.response).toEqual({ subtype: "success", request_id: "notification", response: {} });
});

test("run_end records server cleanup failure after cleanup settles", async () => {
  const p = peer();
  await p.ready();
  p.result();
  const close = spyOn(ExperimentServer.prototype, "close").mockImplementation(() => { throw new Error("cleanup failed"); });
  restores.push(() => close.mockRestore());
  await expect(p.bridge.close()).rejects.toThrow("cleanup failed");
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.at(-1)).toMatchObject({ kind: "run_end", result_received: true, error: "cleanup failed" });
  await expect(p.bridge.close()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(1);
});

test("a JSON-RPC error reply, ping included, fails the bridge", async () => {
  const p = peer();
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "server exploded" } });
  p.mcp("ping", { id: 3, method: "ping" });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(() => p.bridge.finish()).toThrow("experiment MCP ping returned a JSON-RPC error: server exploded");
});

test("Claude's exposed tools must equal the server's advertised set", async () => {
  const p = peer();
  p.request.mockImplementation(async (message: JsonObject) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "bash" }, { name: "read" }] } }));
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  p.ack();
  // The server advertised bash and read; exposing only bash is a failure
  // before the first turn, with both sets in the recording.
  expect(() => p.push({ type: "system", subtype: "init", tools: ["mcp__experiment__bash"] }))
    .toThrow("advertised set");
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const inventory = records.find((r) => r.kind === "tool_inventory")!;
  expect(inventory.tools).toEqual(["mcp__experiment__bash"]);
  expect(inventory.server_tools).toEqual(["mcp__experiment__bash", "mcp__experiment__read"]);
});

test("a partial server frame after a valid reply fails cleanup and retains its exact bytes", async () => {
  const p = peer();
  await p.ready();
  const server = (p.bridge as unknown as { server: ExperimentServer }).server;
  const internals = server as unknown as {
    read(stream: ReadableStream<Uint8Array>, kind: string): Promise<void>;
    pending: Map<string, { resolve(reply: JsonObject): void; reject(error: Error): void }>;
  };
  const reply = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "OK" }] } };
  const received = mock(() => {});
  internals.pending.set("7", { resolve: received, reject: () => {} });
  const partial = '{"jsonrpc":';
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const reading = internals.read(stream, "server_stdout");
  controller.enqueue(Buffer.from(JSON.stringify(reply) + "\n" + partial));
  await new Promise((resolve) => setImmediate(resolve));
  expect(received).toHaveBeenCalledWith(reply);
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  server.terminate();
  controller.close();
  await reading;
  await expect(p.bridge.closeProtocol()).rejects.toThrow("incomplete experiment MCP server stdout frame");
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const retained = records.find((record) => record.kind === "server_stdout_partial");
  expect(Buffer.from(retained.bytes_base64, "base64").toString()).toBe(partial);
  expect(records.at(-1)).toMatchObject({ kind: "run_end", result_received: true,
    error: "incomplete experiment MCP server stdout frame" });
});

test.each(['{"type":', " "])("partial Claude traffic is retained and fails cleanup: %j", async (partial) => {
  const p = peer();
  await p.ready();
  p.result();
  p.bridge.push(partial);
  expect(() => p.bridge.finish()).toThrow("incomplete Claude control frame");
  await expect(p.bridge.closeProtocol()).rejects.toThrow("incomplete Claude control frame");
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((record) => record.kind === "control_stdout_partial").bytes_base64)
    .toBe(Buffer.from(partial).toString("base64"));
  expect(records.at(-1).error).toBe("incomplete Claude control frame");
});

test("both envelope helpers accept the result extracted from a validated stream-json launch", async () => {
  const p = peer();
  await p.ready();
  p.result();
  const stdout = p.bridge.finish();
  await p.bridge.closeProtocol();
  expect(parseClaudeResultEnvelope(stdout)?.envelope.result).toBe("OK");
  const result = claudeFamilyResult({ stdout, stderr: "", exitCode: 0, success: true },
    { agent: "claude", prompt: "probe", autonomy: "read-only", resultJson: true }, "claude", p.bridge.recordingPath);
  expect(result.success).toBe(true);
  expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", result: "OK",
    codemux: { recording: p.bridge.recordingPath } });
});

test("a failure recorded after the delivered result still fails the run at protocol cleanup", async () => {
  const p = peer();
  await p.ready();
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  // The failure arrives after Claude's successful finish -- a server exit,
  // here a canceled control request as the deterministic stand-in.
  expect(() => p.push({ type: "control_cancel_request", request_id: "late" })).toThrow("after its result");
  await expect(p.bridge.closeProtocol()).rejects.toThrow("after its result");
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.at(-1)).toMatchObject({ kind: "run_end", result_received: true,
    error: "Claude sent a frame after its result" });
  // The invariant decision 1 protects: success is decided once, at final
  // protocol cleanup, from the recorded failure -- a result_received run
  // with a non-null run_end error can never complete successfully.
  await expect(p.bridge.closeProtocol()).rejects.toThrow("after its result");
});

test.each([
  ["mcp__experiment__bash", "mcp__experiment__bash"],
  ["mcp__experiment__bash", "mcp__experiment__read", "mcp__experiment__bash"],
])("duplicate Claude inventory entries fail even if the unique set is complete: %j", async (...tools) => {
  const p = peer();
  p.request.mockImplementation(async (message: JsonObject) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "bash" }, { name: "read" }] } }));
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  p.ack();
  expect(() => p.push({ type: "system", subtype: "init", tools })).toThrow("advertised set");
  const records = readFileSync(p.bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((r) => r.kind === "tool_inventory")).toMatchObject({ tools, equal: false,
    server_tools: ["mcp__experiment__bash", "mcp__experiment__read"] });
  expect(records.at(-1).kind).toBe("failure");
});

test("tools/call before system/init validation never reaches the experiment server", async () => {
  const p = peer();
  p.mcp("list", { id: 1, method: "tools/list" });
  await new Promise((resolve) => setImmediate(resolve));
  p.ack();
  p.invoke("early", 2);
  await Promise.resolve();
  expect(() => p.bridge.finish()).toThrow("before validated Claude inventory");
  expect(p.request).toHaveBeenCalledTimes(1);
});

test("a result ends stdin once before any subsequent buffered frame can execute", async () => {
  const p = peer();
  await p.ready();
  p.call("late");
  const frames = [
    { type: "result", result: "OK" },
    { type: "control_request", request_id: "late-call", request: { subtype: "mcp_message",
      server_name: "experiment", message: { jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "bash", arguments: {}, _meta: { "claudecode/toolUseId": "late" } } } } },
  ];
  expect(() => p.bridge.push(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"))
    .toThrow("after its result");
  expect(p.end).toHaveBeenCalledTimes(1);
  expect(p.request).toHaveBeenCalledTimes(1);
  expect(p.result).toThrow("after its result");
  expect(p.end).toHaveBeenCalledTimes(1);
});
