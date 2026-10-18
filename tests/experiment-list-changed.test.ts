import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentServer, type JsonObject } from "../src/experiment-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const changed = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
const definitions = [
  { name: "browser_navigate", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "browser_close", inputSchema: { type: "object", properties: {} } },
];

// Use the real transport parser, request IDs, and pending map. Only the process
// is replaced: no harness or model runs in these tests.
async function peer(notifyDuringInitialList = false) {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-list-changed-"));
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const bridge = new ExperimentBridge({ name: "experiment", command: process.execPath,
    args: [], env: [], recording: cwd }, cwd, "probe");
  const server = (bridge as unknown as { server: ExperimentServer }).server;
  const transport = server as unknown as {
    proc: { stdin: { write(line: string): void } };
    read(stream: ReadableStream<Uint8Array>, kind: string): Promise<void>;
    pending: Map<string, unknown>;
  };
  const sent: JsonObject[] = [];
  const requests: JsonObject[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { canceled = true; } });
  const reading = transport.read(stream, "server_stdout");
  const emit = (...messages: JsonObject[]) => controller.enqueue(Buffer.from(messages.map((m) => JSON.stringify(m) + "\n").join("")));
  let listTools = definitions;
  let holdLists = false;
  transport.proc = { stdin: { write(line) {
    const message = JSON.parse(line);
    requests.push(message);
    if (message.method === "tools/list" && !holdLists) {
      if (notifyDuringInitialList && requests.length === 1) emit(changed);
      emit({ jsonrpc: "2.0", id: message.id, result: message.params?.cursor === undefined
        ? { tools: [listTools[0]], nextCursor: "" } : { tools: [listTools[1]] } });
    }
  } } };
  let ended = 0;
  bridge.start((line) => sent.push(JSON.parse(line)), () => { ended++; }, () => {});
  start.mockRestore();
  cleanups.push(async () => {
    server.terminate();
    if (!canceled) controller.close();
    await reading;
    await bridge.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const push = (frame: JsonObject) => bridge.push(JSON.stringify(frame) + "\n");
  const mcp = (id: string, message: JsonObject) => push({ type: "control_request", request_id: id,
    request: { subtype: "mcp_message", server_name: "experiment", message: { jsonrpc: "2.0", ...message } } });
  mcp("list", { id: 1, method: "tools/list" });
  await tick();
  push({ type: "control_response", response: { subtype: "success", request_id: sent[0]!.request_id } });
  push({ type: "system", subtype: "init", tools: definitions.map((tool) => `mcp__experiment__${tool.name}`) });
  const records = (): JsonObject[] => readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const call = () => {
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use",
      id: "native-call", name: "mcp__experiment__browser_navigate", input: { url: "about:blank" } }] } });
    mcp("call", { id: 2, method: "tools/call", params: { name: "browser_navigate",
      arguments: { url: "about:blank" }, _meta: { "claudecode/toolUseId": "native-call" } } });
  };
  return { bridge, sent, requests, emit, records, call, push, transport,
    setTools: (tools: typeof definitions) => { listTools = tools; },
    holdLists: () => { holdLists = true; }, ended: () => ended };
}

test.each(["before", "after"])("list_changed %s the call response rechecks every page without reaching Claude", async (ordering) => {
  const p = await peer();
  p.call();
  const reply = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "unchanged output" }] } };
  if (ordering === "before") p.emit(changed, reply);
  else {
    p.emit(reply);
    await tick();
    p.emit(changed);
  }
  await tick();
  expect(() => p.bridge.finish()).not.toThrow();
  expect(p.transport.pending.size).toBe(0);
  expect(p.sent.filter((frame) => frame.type === "control_response")).toEqual([
    expect.objectContaining({ response: expect.objectContaining({ request_id: "list" }) }),
    { type: "control_response", response: { subtype: "success", request_id: "call", response: { mcp_response: reply } } },
  ]);
  expect(p.requests.filter((m) => m.method === "tools/list").map((m) => m.params?.cursor)).toEqual([undefined, "", undefined, ""]);
  const records = p.records();
  expect(records.filter((r) => r.kind === "server_notification")).toEqual([
    expect.objectContaining({ method: changed.method }),
  ]);
  expect(records.filter((r) => r.kind === "tool_inventory_recheck")).toEqual([
    expect.objectContaining({ equal: true, previous: definitions, current: definitions }),
  ]);
  expect(records.filter((r) => r.kind === "mcp_request").map((r) => r.message)).toEqual(p.requests);
  p.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-call", content: reply.result.content }] } });
  p.push({ type: "result", result: "OK" });
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")?.equal).toBe(true);
});

test("list_changed rejects a changed schema on the last page and records both inventories", async () => {
  const p = await peer();
  const current = structuredClone(definitions);
  current[1]!.inputSchema.properties = { url: { type: "number" } };
  p.setTools(current);
  p.emit(changed);
  await tick();
  expect(() => p.bridge.finish()).toThrow("experiment tool definitions changed during the run");
  expect(p.records().find((r) => r.kind === "tool_inventory_recheck"))
    .toMatchObject({ equal: false, previous: definitions, current });
});

test.each([
  { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
  { jsonrpc: "2.0", method: "notifications/unknown" },
  { ...changed, id: "unsolicited" },
  { ...changed, id: null },
  { jsonrpc: "2.0", method: "sampling/createMessage", id: 99 },
  { jsonrpc: "2.0", method: "tools/call", id: 2 },
])("other server messages stay refused: %j", async (message) => {
  const p = await peer();
  p.call();
  const before = p.sent.length;
  p.emit(message);
  await tick();
  expect(() => p.bridge.finish()).toThrow("experiment MCP server-initiated requests and notifications are unsupported");
  expect(p.sent).toHaveLength(before);
  expect(p.records().some((r) => r.kind === "tool_inventory_recheck")).toBe(false);
});

test("Claude's final result waits for an outstanding inventory recheck", async () => {
  const p = await peer();
  p.holdLists();
  p.emit(changed);
  await tick();
  p.push({ type: "result", result: "OK" });
  expect(p.ended()).toBe(0);
  const request = p.requests.at(-1)!;
  p.emit({ jsonrpc: "2.0", id: request.id, result: { tools: definitions } });
  await tick();
  expect(p.ended()).toBe(1);
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
});

test("a notification during the initial inventory waits for the complete baseline", async () => {
  const p = await peer(true);
  expect(() => p.bridge.finish()).not.toThrow();
  expect(p.records().filter((r) => r.kind === "tool_inventory_recheck"))
    .toEqual([expect.objectContaining({ equal: true, previous: definitions, current: definitions })]);
});

test("each notification in a burst gets a complete serialized recheck", async () => {
  const p = await peer();
  p.emit(changed, changed, changed);
  await tick();
  expect(() => p.bridge.finish()).not.toThrow();
  expect(p.records().filter((r) => r.kind === "tool_inventory_recheck")).toHaveLength(3);
  expect(p.requests.filter((m) => m.method === "tools/list").map((m) => m.params?.cursor))
    .toEqual([undefined, "", undefined, "", undefined, "", undefined, ""]);
});

test.each([
  [{ tools: [] }, "complete nonempty tools/list"],
  [{ tools: [{ name: "bad name" }] }, "unsupported or duplicate tool name"],
  [{ tools: [definitions[0], definitions[0]] }, "unsupported or duplicate tool name"],
])("inventory rechecks retain collection validation: %j", async (result, error) => {
  const p = await peer();
  p.holdLists();
  p.emit(changed);
  await tick();
  p.emit({ jsonrpc: "2.0", id: p.requests.at(-1)!.id, result });
  await tick();
  expect(() => p.bridge.finish()).toThrow(error);
});

test("an inventory recheck rejects a repeated pagination cursor", async () => {
  const p = await peer();
  p.holdLists();
  p.emit(changed);
  await tick();
  for (let page = 0; page < 2; page++) {
    p.emit({ jsonrpc: "2.0", id: p.requests.at(-1)!.id, result: { tools: [definitions[page]], nextCursor: "" } });
    await tick();
  }
  expect(() => p.bridge.finish()).toThrow("invalid or repeated experiment tools/list cursor");
});

test("an inventory recheck rejects JSON-RPC errors without replying to Claude", async () => {
  const p = await peer();
  const before = p.sent.length;
  p.holdLists();
  p.emit(changed);
  await tick();
  p.emit({ jsonrpc: "2.0", id: p.requests.at(-1)!.id, error: { code: -32000, message: "failed" } });
  await tick();
  expect(() => p.bridge.finish()).toThrow("experiment MCP tools/list returned a JSON-RPC error");
  expect(p.sent).toHaveLength(before);
});

test("protocol cleanup waits for a recheck after Claude exits", async () => {
  const p = await peer();
  p.holdLists();
  p.emit(changed);
  await tick();
  p.push({ type: "result", result: "OK" });
  const closing = p.bridge.closeProtocol();
  p.emit({ jsonrpc: "2.0", id: p.requests.at(-1)!.id, result: { tools: definitions } });
  await closing;
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", result_received: true, error: null });
  expect(p.records().find((r) => r.kind === "tool_inventory_recheck")?.equal).toBe(true);
});

test("a late notification rechecks the inventory without closing Claude's stdin twice", async () => {
  const p = await peer();
  p.push({ type: "result", result: "OK" });
  expect(p.ended()).toBe(1);
  p.emit(changed);
  await tick();
  expect(p.records().find((r) => r.kind === "tool_inventory_recheck")?.equal).toBe(true);
  expect(p.ended()).toBe(1);
  await p.bridge.closeProtocol();
  expect(p.records().at(-1)?.error).toBeNull();
});
