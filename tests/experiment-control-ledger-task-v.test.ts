import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { JsonObject } from "../src/experiment-server.js";
import { cleanupPeers, peer, restores } from "./helpers/experiment-peer.js";

afterEach(cleanupPeers);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const content = [{ type: "text", text: "first" }, { type: "text", text: "second" }];
const hash = createHash("sha256").update('[{"text":"first","type":"text"},{"text":"second","type":"text"}]').digest("hex");
const ledger = (p: ReturnType<typeof peer>) => p.records().filter((record) => record.kind === "call_ledger");
const writer = (p: ReturnType<typeof peer>, write: (line: string) => void) => {
  (p.bridge as unknown as { write: (line: string) => void }).write = write;
};

test("Claude control delivery records exact ledger fields, transport times, native ID, RPC ID, and content hash", async () => {
  const p = peer();
  await p.ready();
  p.call("native-7");
  let now = 1_793_275_200_123;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restores.push(() => clock.mockRestore());
  let resolve!: (reply: JsonObject) => void;
  p.request.mockImplementation(() => {
    now = 1_793_275_200_456;
    return new Promise((done) => { resolve = done; });
  });
  writer(p, (line) => {
    expect(ledger(p)).toEqual([]);
    expect(JSON.parse(line)).toMatchObject({ type: "control_response", response: {
      request_id: "control-91", response: { mcp_response: { id: "rpc-91", result: { content } } },
    } });
    now = 1_793_275_201_789;
  });
  p.mcp("control-91", { id: "rpc-91", method: "tools/call", params: {
    name: "bash", arguments: {}, _meta: { "claudecode/toolUseId": "native-7" },
  } });
  expect(ledger(p)).toEqual([]);
  resolve({ jsonrpc: "2.0", id: "rpc-91", result: { content } });
  await settle();
  const entry = ledger(p)[0];
  expect(entry).toEqual({ kind: "call_ledger", run_id: p.bridge.runId, seq: expect.any(Number), t: expect.any(Number),
    relay_request_seq: "control-91", native_call_id: "native-7", dispatched_t: 1_793_275_200.123,
    delivered_t: 1_793_275_201.789, correlation: "request_meta", rpc_id: "rpc-91", result_sha256: hash });
  const serverResult = p.records().find((record) => record.kind === "server_tool_result");
  expect(serverResult).toMatchObject({ relay_request_seq: "control-91", tool_use_id: "native-7",
    rpc_id: "rpc-91", result_sha256: hash, result: { content } });
  const mcpRequest = p.records().find((record) => record.kind === "mcp_request" && record.tool_use_id === "native-7");
  expect(mcpRequest).toMatchObject({ control_id: "control-91", relay_request_seq: entry.relay_request_seq,
    rpc_id: entry.rpc_id, tool_use_id: entry.native_call_id });
  expect(mcpRequest.seq).toBeLessThan(serverResult.seq);
  expect(serverResult.seq).toBeLessThan(entry.seq);
  expect(p.records().filter((record) => ["model_tool_result", "tool_result_delivered"].includes(record.kind))).toEqual([]);
  p.push({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "native-7", content },
  ] } });
  p.result();
  expect(() => p.bridge.finish()).not.toThrow();
  await p.bridge.close();
  expect(ledger(p)).toHaveLength(1);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 1, model_results: 1, error: null });
});

test("Claude inventory, notification, and permission responses emit no call ledger", async () => {
  const p = peer();
  await p.ready();
  p.request.mockResolvedValue(undefined);
  p.mcp("notification", { method: "notifications/initialized" });
  p.push({ type: "control_request", request_id: "permission", request: {
    subtype: "can_use_tool", tool_name: "mcp__experiment__bash", input: {},
  } });
  await settle();
  p.result();
  expect(() => p.bridge.finish()).not.toThrow();
  await p.bridge.close();
  expect(ledger(p)).toEqual([]);
  expect(p.sent.filter((frame) => frame.type === "control_response")).toHaveLength(3);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 0, error: null });
});

test.each(["rejected", "rpc-error", "invalid-result"])("Claude %s tool response emits no delivery ledger", async (mode) => {
  const p = peer();
  await p.ready();
  p.call("native-fail");
  if (mode === "rejected") p.request.mockRejectedValue(new Error("server request failed"));
  else p.request.mockResolvedValue(mode === "rpc-error" ? { jsonrpc: "2.0", id: 9, error: { message: "failed" } }
    : { jsonrpc: "2.0", id: 9, result: { content: "invalid" } });
  p.invoke("native-fail", 9);
  await settle();
  expect(p.bridge.failureCode).not.toBeNull();
  await p.bridge.close();
  expect(ledger(p)).toEqual([]);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 0 });
});

test("Claude retains server result hash but emits no ledger when writing its control response fails", async () => {
  const p = peer();
  await p.ready();
  p.call("native-write-fail");
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content } });
  writer(p, () => { throw new Error("control response write failed"); });
  p.invoke("native-write-fail", 10);
  await settle();
  expect(p.bridge.failureError?.message).toBe("control response write failed");
  await p.bridge.close();
  expect(p.records().find((record) => record.kind === "server_tool_result")).toMatchObject({
    relay_request_seq: "call-10", rpc_id: 10, result_sha256: hash,
  });
  expect(ledger(p)).toEqual([]);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 0,
    error: "control response write failed" });
});

test("Claude failed runs count delivered control responses independently of later model evidence", async () => {
  const p = peer();
  await p.ready();
  p.call("native-delivered");
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content } });
  p.invoke("native-delivered", 10);
  await settle();
  expect(ledger(p)).toHaveLength(1);
  expect(() => p.delivered("native-delivered", "changed")).toThrow("changed the experiment tool result");
  await p.bridge.close();
  expect(ledger(p)).toHaveLength(1);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 1, model_results: 0,
    code: "result_changed" });
});

test("Claude concurrent tool replies retain their control and RPC IDs when delivered out of order", async () => {
  const p = peer();
  await p.ready();
  p.call("native-first");
  p.call("native-second");
  const pending = new Map<string | number, (reply: JsonObject) => void>();
  p.request.mockImplementation((message) => new Promise((resolve) => { pending.set(message.id, resolve); }));
  for (const [native, control, rpc] of [["native-first", "control-first", "rpc-first"],
    ["native-second", "control-second", 23]] as const) {
    p.mcp(control, { id: rpc, method: "tools/call", params: {
      name: "bash", arguments: {}, _meta: { "claudecode/toolUseId": native },
    } });
  }
  pending.get(23)!({ jsonrpc: "2.0", id: 23, result: { content, isError: true } });
  await settle();
  pending.get("rpc-first")!({ jsonrpc: "2.0", id: "rpc-first", result: { content: [] } });
  await settle();
  expect(ledger(p).map(({ relay_request_seq, native_call_id, rpc_id, result_sha256 }) =>
    ({ relay_request_seq, native_call_id, rpc_id, result_sha256 }))).toEqual([
    { relay_request_seq: "control-second", native_call_id: "native-second", rpc_id: 23, result_sha256: hash },
    { relay_request_seq: "control-first", native_call_id: "native-first", rpc_id: "rpc-first",
      result_sha256: createHash("sha256").update("[]").digest("hex") },
  ]);
  p.bridge.fail(new Error("stopped after transport delivery"));
  await p.bridge.close();
  expect(ledger(p)).toHaveLength(2);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 2, model_results: 0,
    error: "stopped after transport delivery" });
});

test("Claude does not record delivery when a pending tool reply arrives after failure", async () => {
  const p = peer();
  await p.ready();
  p.call("native-pending");
  let resolve!: (reply: JsonObject) => void;
  p.request.mockImplementation(() => new Promise((done) => { resolve = done; }));
  p.invoke("native-pending", 10);
  p.bridge.fail(new Error("run stopped before response"));
  resolve({ jsonrpc: "2.0", id: 10, result: { content } });
  await settle();
  await p.bridge.close();
  expect(ledger(p)).toEqual([]);
  expect(p.records().filter((record) => record.kind === "server_tool_result")).toEqual([]);
  expect(p.records().at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 0 });
});
