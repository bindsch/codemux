import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentFailureCode, resultContentSha256 } from "../src/experiment-records.js";
import { readRelayHttpResponse, type RelayHttpResponse } from "./experiment-relay-http.js";
import { MARKER } from "./fixtures/experiment-mcp.js";

const relays: ExperimentHttpRelay[] = [];
const clients: ClientRequest[] = [];
const timing = { sseSwitchMs: 20, sseKeepaliveMs: 15 };
const result = { content: [{ type: "text", text: MARKER }] };
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

async function setup(options = timing) {
  const parent = resolve("scratch/session-14c66a93/exp/relay-task-y");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings") }, cwd, {}, options);
  relays.push(relay);
  relay.resolveCallId = async (call) => `native-${call.relay_index}`;
  await relay.start();
  expect((await post(relay, 1, "tools/list")).status).toBe(200);
  return relay;
}

function records(relay: ExperimentHttpRelay): any[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function dispatched(relay: ExperimentHttpRelay): any[] {
  return records(relay).filter((entry) => entry.kind === "server_stdin")
    .map((entry) => JSON.parse(Buffer.from(entry.bytes_base64, "base64").toString()))
    .filter((message) => message.method === "tools/call");
}

async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 1000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(1);
  }
}

function open(relay: ExperimentHttpRelay, id: string | number, method: string, params?: object) {
  const server = (relay as unknown as { http: Server }).http;
  const closed = new Promise<void>((resolveClosed) => {
    const observe = (request: IncomingMessage, response: ServerResponse) => {
      if (request.headers["x-test-rpc-id"] !== String(id)) return;
      server.off("request", observe);
      response.once("close", resolveClosed);
    };
    server.on("request", observe);
  });
  const client = httpRequest(relay.url, { method: "POST", agent: false, headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream", "x-test-rpc-id": String(id),
  } });
  clients.push(client);
  const chunks: { text: string; t: number }[] = [];
  const headers = new Promise<IncomingMessage>((resolveHeaders) => client.once("response", (response) => {
    response.on("data", (chunk) => chunks.push({ text: Buffer.from(chunk).toString(), t: Date.now() / 1000 }));
    resolveHeaders(response);
  }));
  const response = readRelayHttpResponse(client);
  void response.catch(() => {});
  client.end(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
  return { client, response, headers, chunks, closed };
}

function post(relay: ExperimentHttpRelay, id: string | number, method: string, params?: object) {
  return open(relay, id, method, params).response;
}

function call(relay: ExperimentHttpRelay, id: string | number, input: object, nativeId?: string) {
  return open(relay, id, "tools/call", { name: "bash", arguments: input,
    ...(nativeId ? { _meta: { callId: nativeId } } : {}) });
}

async function abandon(pending: ReturnType<typeof call>) {
  pending.client.destroy();
  await pending.closed;
  await pending.response.catch(() => undefined);
}

function expectResult(response: RelayHttpResponse, id: string | number) {
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ jsonrpc: "2.0", id, result });
}

function ledger(relay: ExperimentHttpRelay) {
  return records(relay).filter((entry) => entry.kind === "call_ledger");
}

test("slow tools/call flushes SSE headers and keepalives before one final message", async () => {
  const relay = await setup();
  const pending = call(relay, "slow", { command: "hold:240" });
  const early = await Promise.race([pending.headers, Bun.sleep(150).then(() => undefined)]);
  expect(early?.statusCode).toBe(200);
  expect(early?.headers["content-type"]).toMatch(/^text\/event-stream(?:;|$)/);
  expect(early?.headers["cache-control"]).toBe("no-cache");
  expect(early?.headers["content-length"]).toBeUndefined();
  const response = await pending.response;
  expectResult(response, "slow");
  expect(response.events).toEqual([{ event: "message", data: response.body }]);
  expect(response.keepalives).toBeGreaterThanOrEqual(2);
  expect(response.rawBody).toContain(": keepalive\n\n");
  expect(response.rawBody).toContain(`event: message\ndata: ${response.body}\n\n`);
  const dataChunk = pending.chunks.find((chunk) => chunk.text.includes("data:"));
  expect(dataChunk).toBeDefined();
  expect(pending.chunks.filter((chunk) => chunk.text.includes(": keepalive") && chunk.t < dataChunk!.t).length).toBeGreaterThanOrEqual(2);
  const sse = records(relay).filter((entry) => entry.kind === "relay_sse");
  expect(sse).toHaveLength(1);
  expect(sse[0]).toMatchObject({ rpc_id: "slow", keepalives: response.keepalives, t: expect.any(Number) });
  await until(() => ledger(relay).length === 1, "SSE delivery was not recorded");
  expect(ledger(relay)[0]).toMatchObject({ rpc_id: "slow", result_sha256: resultContentSha256(result.content) });
  expect(Math.abs(ledger(relay)[0].delivered_t - dataChunk!.t)).toBeLessThan(0.1);
  expect(relay.failureCode).toBeNull();
  relay.finish();
});

test("fast tools/call retains JSON and GET remains method not allowed", async () => {
  const relay = await setup({ sseSwitchMs: 500, sseKeepaliveMs: 15 });
  const response = await call(relay, "fast", { command: "constant" }).response;
  expectResult(response, "fast");
  expect(response.type).toBe("application/json");
  expect(response.events).toBeUndefined();
  expect(records(relay).filter((entry) => entry.kind === "relay_sse")).toEqual([]);
  const client = httpRequest(relay.url, { method: "GET", agent: false,
    headers: { Authorization: `Bearer ${relay.token}`, Accept: "text/event-stream" } });
  clients.push(client);
  const get = readRelayHttpResponse(client);
  client.end();
  expect(await get).toMatchObject({ status: 405, allow: "POST", body: "" });
  expect(dispatched(relay)).toHaveLength(1);
  expect(relay.failureCode).toBeNull();
});

test("identical open Kimi connections dispatch separately with FIFO native IDs", async () => {
  const relay = await setup();
  const first = call(relay, "first", { command: "hold:120", nested: { a: 1, b: 2 } });
  await until(() => dispatched(relay).length === 1, "first call was not dispatched");
  const second = call(relay, "second", { nested: { b: 2, a: 1 }, command: "hold:120" });
  expectResult(await first.response, "first");
  expectResult(await second.response, "second");
  expect(dispatched(relay)).toHaveLength(2);
  expect(relay.calls.map((entry) => entry.call_id)).toEqual(["native-0", "native-1"]);
  expect(relay.calls.map((entry) => entry.rpc_ids)).toEqual([["first"], ["second"]]);
  await until(() => ledger(relay).length === 2, "separate deliveries were not recorded");
  expect(ledger(relay).map((entry) => entry.relay_request_seq)).toEqual([0, 1]);
  expect(records(relay).filter((entry) => entry.correlation === "retry")).toEqual([]);
});

test("a resend after close before native resolution shares one pending dispatch", async () => {
  const relay = await setup();
  let resolutions = 0;
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  relay.resolveCallId = async () => { const ordinal = ++resolutions; await held; return `native-${ordinal}`; };
  const first = call(relay, "original", { command: "hold:120", nested: { a: 1, b: [true, null] } });
  await until(() => resolutions === 1, "native ID resolution did not start");
  await abandon(first);
  const retry = call(relay, 0, { nested: { b: [true, null], a: 1 }, command: "hold:120" });
  await until(() => records(relay).filter((entry) => entry.kind === "http_request").length === 3,
    "retry HTTP request was not received");
  release();
  await until(() => dispatched(relay).length > 0, "original tool call was not dispatched");
  expectResult(await retry.response, 0);
  expect(resolutions).toBe(1);
  expect(dispatched(relay)).toHaveLength(1);
  expect(relay.calls).toHaveLength(1);
  await until(() => ledger(relay).length === 1, "retry delivery was not recorded");
  const attached = records(relay).filter((entry) => entry.kind === "tool_call" && entry.correlation === "retry");
  expect(attached).toHaveLength(1);
  expect(attached[0]).toMatchObject({ relay_request_seq: 0, rpc_ids: ["original", 0] });
  expect(ledger(relay)[0]).toMatchObject({ rpc_id: 0, correlation: "retry" });
  expect(new Set(ledger(relay).map((entry) => entry.relay_request_seq))).toEqual(new Set([0]));
  expect(new Set(ledger(relay).map((entry) => entry.result_sha256))).toEqual(new Set([resultContentSha256(result.content)]));
  expect(relay.failureCode).toBeNull();
  relay.finish();
});

test("a completed undelivered call serves one cached resend with its own RPC ID", async () => {
  const relay = await setup();
  let resolutions = 0;
  relay.resolveCallId = async () => `native-${++resolutions}`;
  const first = call(relay, "first", { command: "hold:80", nested: { x: 1, y: 2 } });
  await until(() => dispatched(relay).length === 1, "first call was not dispatched");
  await abandon(first);
  await until(() => records(relay).some((entry) => entry.kind === "relay_delivery_failed"), "failed delivery was not recorded");
  expectResult(await call(relay, "cached", { nested: { y: 2, x: 1 }, command: "hold:80" }).response, "cached");
  expect(resolutions).toBe(1);
  expect(dispatched(relay)).toHaveLength(1);
  expect(relay.calls).toHaveLength(1);
  await until(() => ledger(relay).length === 1, "cached delivery was not recorded");
  expect(records(relay).filter((entry) => entry.kind === "tool_call" && entry.correlation === "retry_cached"))
    .toEqual([expect.objectContaining({ relay_request_seq: 0, rpc_ids: ["first", "cached"] })]);
  expect(ledger(relay).map((entry) => entry.rpc_id)).toEqual(["cached"]);
  expect(ledger(relay)[0].correlation).toBe("retry_cached");
  expect(new Set(ledger(relay).map((entry) => entry.relay_request_seq))).toEqual(new Set([0]));
  expect(new Set(ledger(relay).map((entry) => entry.result_sha256))).toEqual(new Set([resultContentSha256(result.content)]));
  expect(relay.failureCode).toBeNull();
  expectResult(await call(relay, "new", { command: "hold:80", nested: { x: 1, y: 2 } }).response, "new");
  expect(dispatched(relay)).toHaveLength(2);
  expect(resolutions).toBe(2);
  relay.finish();
});

test("a completed delivered call never supplies a later identical call", async () => {
  const relay = await setup();
  expectResult(await call(relay, "first", { command: "constant" }).response, "first");
  expectResult(await call(relay, "second", { command: "constant" }).response, "second");
  expect(dispatched(relay)).toHaveLength(2);
  expect(relay.calls.map((entry) => entry.call_id)).toEqual(["native-0", "native-1"]);
  await until(() => ledger(relay).length === 2, "both deliveries were not recorded");
  expect(ledger(relay).map((entry) => entry.relay_request_seq)).toEqual([0, 1]);
  expect(records(relay).some((entry) => entry.correlation === "retry_cached")).toBe(false);
});

test.each(["open", "closed", "completed"])("distinct Codex metadata IDs dispatch twice; original=%s", async (state) => {
  const relay = await setup();
  const ids: string[] = [];
  relay.resolveCallId = async (_call, request) => { ids.push(request.params._meta.callId); return ids.at(-1)!; };
  const first = call(relay, "first", { command: "hold:120" }, "native-A");
  await until(() => dispatched(relay).length === 1, "first Codex call was not dispatched");
  if (state !== "open") await abandon(first);
  if (state === "completed") await until(() => records(relay).some((entry) => entry.kind === "relay_delivery_failed"),
    "Codex failed delivery was not recorded");
  const second = call(relay, "second", { command: "hold:120" }, "native-B");
  if (state === "open") expectResult(await first.response, "first");
  expectResult(await second.response, "second");
  expect(dispatched(relay)).toHaveLength(2);
  expect(ids).toEqual(["native-A", "native-B"]);
  expect(relay.calls.map((entry) => entry.call_id)).toEqual(ids);
});

test("the same Codex metadata ID after close retries before native resolution", async () => {
  const relay = await setup();
  let resolutions = 0;
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  relay.resolveCallId = async (_call, request) => { resolutions++; await held; return request.params._meta.callId; };
  const first = call(relay, "first", { command: "hold:80" }, "native-A");
  await until(() => resolutions === 1, "Codex native resolution did not start");
  await abandon(first);
  const retry = call(relay, "retry", { command: "hold:80" }, "native-A");
  await until(() => records(relay).filter((entry) => entry.kind === "http_request").length === 3, "retry was not received");
  release();
  expectResult(await retry.response, "retry");
  expect(dispatched(relay)).toHaveLength(1);
  expect(resolutions).toBe(1);
  await until(() => ledger(relay).length === 1, "Codex retry delivery was not recorded");
  expect(ledger(relay)[0]).toMatchObject({ rpc_id: "retry", native_call_id: "native-A", correlation: "retry", relay_request_seq: 0 });
  expect(relay.calls[0]?.rpc_ids).toEqual(["first", "retry"]);
});

test("an open replacement connection cannot absorb another identical call", async () => {
  const relay = await setup();
  const first = call(relay, "original", { command: "hold:160" });
  await until(() => dispatched(relay).length === 1, "original call was not dispatched");
  await abandon(first);
  const retry = call(relay, "retry", { command: "hold:160" });
  await until(() => records(relay).some((entry) => entry.kind === "tool_call" && entry.correlation === "retry"),
    "retry did not attach");
  const concurrent = call(relay, "concurrent", { command: "hold:160" });
  expectResult(await retry.response, "retry");
  expectResult(await concurrent.response, "concurrent");
  expect(dispatched(relay)).toHaveLength(2);
  expect(relay.calls.map((entry) => entry.rpc_ids)).toEqual([["original", "retry"], ["concurrent"]]);
});

test("a local keepalive write failure does not create a client-abandoned cache entry", async () => {
  const relay = await setup();
  const server = (relay as unknown as { http: Server }).http;
  server.once("request", (_request, response) => {
    response.write = (() => { throw new Error("synthetic keepalive write failure"); }) as typeof response.write;
  });
  const first = call(relay, "local-failure", { command: "hold:80" });
  await first.response.catch(() => undefined);
  await until(() => records(relay).some((entry) => entry.kind === "relay_delivery_failed"), "local delivery failure was not recorded");
  expectResult(await call(relay, "new", { command: "hold:80" }).response, "new");
  expect(dispatched(relay)).toHaveLength(2);
  expect(relay.calls.map((entry) => entry.rpc_ids)).toEqual([["local-failure"], ["new"]]);
});

test("changed arguments dispatch a distinct call instead of using a pending or cached result", async () => {
  const relay = await setup();
  const first = call(relay, "one", { command: "hold:100", nested: [1, 2] });
  await until(() => dispatched(relay).length === 1, "first tool call was not dispatched");
  const second = call(relay, "two", { command: "hold:100", nested: [2, 1] });
  expectResult(await first.response, "one");
  expectResult(await second.response, "two");
  expectResult(await call(relay, "three", { command: "constant", nested: [1, 2] }).response, "three");
  expect(dispatched(relay)).toHaveLength(3);
  expect(relay.calls).toHaveLength(3);
  expect(relay.failureCode).toBeNull();
});

test("a disconnected original request does not fail its attached retry", async () => {
  const relay = await setup();
  let resolutions = 0;
  relay.resolveCallId = async () => `native-${++resolutions}`;
  const first = call(relay, "abandoned", { command: "hold:200" });
  await until(() => dispatched(relay).length === 1, "original tool call was not dispatched");
  await abandon(first);
  const retry = call(relay, "survivor", { command: "hold:200" });
  await until(() => records(relay).filter((entry) => entry.kind === "http_request").length === 3,
    "retry HTTP request was not received");
  expectResult(await retry.response, "survivor");
  await until(() => ledger(relay).length === 1, "surviving delivery was not recorded");
  expect(ledger(relay)[0]).toMatchObject({ rpc_id: "survivor", relay_request_seq: 0, correlation: "retry" });
  expect(resolutions).toBe(1);
  expect(dispatched(relay)).toHaveLength(1);
  expect(relay.failureCode).toBeNull();
  const deliveryFailure = records(relay).find((entry) => entry.kind === "relay_delivery_failed" && entry.rpc_id === "abandoned");
  expect(deliveryFailure).toMatchObject({ relay_request_seq: 0, message: expect.any(String) });
  expect(records(relay).filter((entry) => entry.kind === "failure")).toEqual([]);
  relay.finish();
});

test("a recording failure while sending a tool response remains fatal", async () => {
  const relay = await setup();
  const record = relay.record;
  const recordingError = "synthetic HTTP response recording failure";
  const recording = spyOn(relay, "record").mockImplementation((kind, fields) => {
    if (kind === "http_response") throw new Error(recordingError);
    record(kind, fields);
  });
  try {
    await call(relay, "recording-error", { command: "constant" }).response.catch(() => undefined);
    expect(relay.failureCode).toBe(ExperimentFailureCode.Protocol);
    expect(relay.failureError?.message).toContain(recordingError);
    expect(records(relay).filter((entry) => entry.kind === "relay_delivery_failed")).toEqual([]);
  } finally { recording.mockRestore(); }
});
