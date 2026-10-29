import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { readRelayHttpResponse } from "./experiment-relay-http.js";

const relays: ExperimentHttpRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

// The stdin loop cannot process a ping while the tool call is held.
const serverScript = `
import { createInterface } from "node:readline";
const keepAlive = setInterval(() => {}, 1000);
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result;
  if (message.method === "initialize") {
    if (initialized) {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32600,message:"already initialized"}})+"\\n");
      continue;
    }
    initialized = true;
    result = {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"strict-fixture",version:"1"}};
  } else if (message.method === "tools/list") {
    result = {tools:[{name:"bash",inputSchema:{type:"object"}}]};
  } else if (message.method === "tools/call") {
    await Bun.sleep(400);
    result = {content:[{type:"text",text:"held result"}]};
  } else {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"no ping handler"}})+"\\n");
    continue;
  }
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\\n");
}
clearInterval(keepAlive);`;

async function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/relay-task-w");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, "-e", serverScript],
    env: [], recording: join(cwd, "recordings") }, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async (call) => `native-${call.relay_index}`;
  await relay.start();
  return relay;
}

function records(relay: ExperimentHttpRelay): any[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function messages(relay: ExperimentHttpRelay): any[] {
  return records(relay).filter((entry) => entry.kind === "server_stdin")
    .map((entry) => JSON.parse(Buffer.from(entry.bytes_base64, "base64").toString()));
}

async function post(relay: ExperimentHttpRelay, id: string | number, method: string, params?: object) {
  const request = httpRequest(relay.url, { method: "POST", agent: false, headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
  } });
  const response = readRelayHttpResponse(request);
  request.end(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
  const reply = await response;
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body);
}

async function pendingCall(relay: ExperimentHttpRelay) {
  const result = post(relay, "held-call", "tools/call", { name: "bash", arguments: {} });
  // Observe dispatch before sending the liveness or reconnect request.
  const deadline = performance.now() + 1000;
  while (!messages(relay).some((message) => message.method === "tools/call")) {
    if (performance.now() >= deadline) throw new Error("held call was not dispatched");
    await Bun.sleep(1);
  }
  return { result };
}

test.each([0, "ping-id"])("relay answers ping locally before initialization: %s", async (id) => {
  const relay = await setup();
  const before = Date.now() / 1000;
  expect(await post(relay, id, "ping")).toEqual({ jsonrpc: "2.0", id, result: {} });
  expect(relay.failureCode).toBeNull();
  expect(messages(relay)).toEqual([]);
  expect(records(relay).filter((entry) => entry.kind === "mcp_request")).toEqual([]);
  const ping = records(relay).find((entry) => entry.kind === "relay_ping");
  expect(ping.rpc_id).toBe(id);
  expect(typeof ping.t).toBe("number");
  expect(ping.t).toBeGreaterThanOrEqual(before);
  expect(ping.t).toBeLessThanOrEqual(Date.now() / 1000);
});

test("relay answers ping while its server stdin loop holds a tool call", async () => {
  const relay = await setup();
  await post(relay, 1, "initialize");
  await post(relay, 2, "tools/list");
  const { result } = await pendingCall(relay);
  const first = await Promise.race([
    post(relay, 3, "ping").then((reply) => ({ kind: "ping", reply })),
    result.then((reply) => ({ kind: "call", reply })),
  ]);
  expect(first).toEqual({ kind: "ping", reply: { jsonrpc: "2.0", id: 3, result: {} } });
  expect((await result).result.content).toEqual([{ type: "text", text: "held result" }]);
  expect(messages(relay).filter((message) => message.method === "ping")).toEqual([]);
  expect(relay.failureCode).toBeNull();
  relay.finish();
});

test.each([0, "reconnect"])("relay replays initialize and preserves a pending call: %s", async (id) => {
  const relay = await setup();
  const initial = await post(relay, "initial", "initialize");
  await post(relay, 2, "tools/list");
  const { result } = await pendingCall(relay);
  const first = await Promise.race([
    post(relay, id, "initialize", { protocolVersion: "different" }).then((reply) => ({ kind: "reconnect", reply })),
    result.then((reply) => ({ kind: "call", reply })),
  ]);
  expect(first).toEqual({ kind: "reconnect", reply: { jsonrpc: "2.0", id, result: initial.result } });
  expect((await result).result.content).toEqual([{ type: "text", text: "held result" }]);
  expect(messages(relay).filter((message) => message.method === "initialize")).toHaveLength(1);
  expect(records(relay).filter((entry) => entry.kind === "mcp_request" && entry.message.method === "initialize")).toHaveLength(1);
  expect(records(relay).find((entry) => entry.kind === "relay_reinitialize"))
    .toMatchObject({ rpc_id: id, t: expect.any(Number) });
  expect(records(relay).filter((entry) => entry.kind === "call_ledger")).toHaveLength(1);
  expect(relay.failureCode).toBeNull();
  relay.finish();
});
