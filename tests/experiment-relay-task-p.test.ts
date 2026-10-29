import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentFailureCode } from "../src/experiment-records.js";
import { MAX_EXPERIMENT_MESSAGE_BYTES } from "../src/experiment-server.js";

const relays: ExperimentHttpRelay[] = [];
const clients: ClientRequest[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

async function setup() {
  mkdirSync("scratch", { recursive: true });
  const cwd = mkdtempSync(resolve("scratch/relay-task-p-"));
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings") }, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async () => "native-call";
  await relay.start();
  return relay;
}

function records(relay: ExperimentHttpRelay): any[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function open(relay: ExperimentHttpRelay, options: { method?: string; headers?: Record<string, string> } = {}) {
  let client!: ClientRequest;
  const response = new Promise<{ status: number; connection?: string; body: string }>((resolveResponse, reject) => {
    client = httpRequest(relay.url, { method: options.method ?? "POST", headers: {
      Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json", ...options.headers,
    } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => resolveResponse({ status: incoming.statusCode!,
        connection: incoming.headers.connection, body: Buffer.concat(chunks).toString() }));
      incoming.once("error", reject);
    });
    client.once("error", reject);
    clients.push(client);
  });
  void response.catch(() => {});
  return { client, response };
}

async function post(relay: ExperimentHttpRelay, message: object) {
  const pending = open(relay);
  pending.client.end(JSON.stringify(message));
  return pending.response;
}

async function list(relay: ExperimentHttpRelay) {
  expect((await post(relay, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
}

test.each([null, false, 0, "", "text", [], ["value"]].map((input) => ({ input })))("tools/call rejects non-object arguments %j before native correlation or dispatch", async ({ input }) => {
  const relay = await setup();
  await list(relay);
  let correlations = 0;
  relay.resolveCallId = async () => { correlations++; return "native-empty"; };
  const result = await post(relay, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bash", arguments: input } });
  expect(result.status).toBe(400);
  expect(relay.failureCode).toBe(ExperimentFailureCode.Protocol);
  expect(correlations).toBe(0);
  expect(relay.calls).toHaveLength(0);
  expect(records(relay).filter((entry) => entry.kind === "server_stdin")).toHaveLength(1);
  expect(records(relay).filter((entry) => entry.kind === "tool_call")).toHaveLength(0);
});

test.each([false, true])("tools/call correlates the exact object dispatched: arguments omitted=%s", async (omitted) => {
  const relay = await setup();
  await list(relay);
  const input = omitted ? {} : { command: "synthetic", nested: { keep: [1, null, false] } };
  let correlated: unknown;
  relay.resolveCallId = async (call, request) => {
    expect(request.params.arguments).toEqual(input);
    expect(call.input).toBe(request.params.arguments);
    correlated = call.input;
    return "native-exact";
  };
  const result = await post(relay, { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "bash", ...(omitted ? {} : { arguments: input }) } });
  expect(result.status).toBe(200);
  expect(correlated).toEqual(input);
  const dispatched = records(relay).filter((entry) => entry.kind === "server_stdin").at(-1);
  const message = JSON.parse(Buffer.from(dispatched.bytes_base64, "base64").toString());
  expect(message.params.arguments).toEqual(input);
  expect(relay.calls[0]?.input).toEqual(message.params.arguments);
});

test("authenticated oversized Content-Length returns 413 before any body bytes arrive", async () => {
  const relay = await setup();
  const pending = open(relay, { headers: { "Content-Length": String(MAX_EXPERIMENT_MESSAGE_BYTES + 1) } });
  pending.client.flushHeaders();
  const result = await Promise.race([pending.response, Bun.sleep(300).then(() => "still waiting")]);
  expect(result).not.toBe("still waiting");
  expect(result).toMatchObject({ status: 413, connection: "close", body: "" });
  expect(records(relay).find((entry) => entry.kind === "http_request")).toMatchObject({ bytes_base64: "", body_complete: false });
  expect(records(relay).filter((entry) => entry.kind === "server_stdin")).toHaveLength(0);
});

test.each(["GET", "PUT", "DELETE"])("authenticated %s returns 405 before an unfinished chunked body is read", async (method) => {
  const relay = await setup();
  const pending = open(relay, { method, headers: { "Transfer-Encoding": "chunked" } });
  pending.client.write("unfinished-body");
  const result = await Promise.race([pending.response, Bun.sleep(300).then(() => "still waiting")]);
  expect(result).not.toBe("still waiting");
  expect(result).toMatchObject({ status: 405, body: "" });
  expect(records(relay).find((entry) => entry.kind === "http_request")).toMatchObject({ bytes_base64: "", body_complete: false });
  expect(records(relay).filter((entry) => entry.kind === "server_stdin")).toHaveLength(0);
});

test("an unfinished chunked body receives 408 and closes its connection at the 30-second deadline", async () => {
  const relay = await setup();
  const timeout = globalThis.setTimeout;
  const deadlines: Array<() => void> = [];
  const parkedTimers: ReturnType<typeof setTimeout>[] = [];
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: any[]) => void, delay?: number, ...args: any[]
  ) => {
    if (delay === undefined || delay < 29_000 || delay > 30_000) return timeout(callback, delay, ...args);
    deadlines.push(() => callback(...args));
    const timer = timeout(callback, 60_000, ...args);
    parkedTimers.push(timer);
    return timer;
  }) as typeof setTimeout);
  try {
    const pending = open(relay, { headers: { "Transfer-Encoding": "chunked" } });
    let socketClosed = false;
    pending.client.once("socket", (socket) => socket.once("close", () => { socketClosed = true; }));
    pending.client.write("unfinished-body");
    const waitUntil = Date.now() + 300;
    while (!deadlines.length && Date.now() < waitUntil) await Bun.sleep(1);
    expect(deadlines).toHaveLength(1);
    clearTimeout(parkedTimers[0]);
    deadlines[0]!();
    expect(await pending.response).toMatchObject({ status: 408, connection: "close", body: "" });
    const closeUntil = Date.now() + 300;
    while (!socketClosed && Date.now() < closeUntil) await Bun.sleep(1);
    expect(socketClosed).toBe(true);
    expect(records(relay).find((entry) => entry.kind === "http_request")).toMatchObject({
      bytes_base64: Buffer.from("unfinished-body").toString("base64"), body_complete: false,
    });
    expect(records(relay).filter((entry) => entry.kind === "server_stdin")).toHaveLength(0);
  } finally {
    for (const timer of parkedTimers) clearTimeout(timer);
    timerSpy.mockRestore();
  }
});
