import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { MAX_EXPERIMENT_MESSAGE_BYTES } from "../src/experiment-server.js";
import { readRelayHttpResponse } from "./experiment-relay-http.js";

const relays: ExperimentHttpRelay[] = [];
const clients: ClientRequest[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const client of clients.splice(0)) client.destroy();
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

async function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/relay-close-q");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings") }, cwd, {});
  relays.push(relay);
  await relay.start();
  return relay;
}

function records(relay: ExperimentHttpRelay): any[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test.each([
  { framing: "content-length", size: MAX_EXPERIMENT_MESSAGE_BYTES + 1 },
  { framing: "chunked", size: MAX_EXPERIMENT_MESSAGE_BYTES + 1 },
  { framing: "content-length", size: 4 * MAX_EXPERIMENT_MESSAGE_BYTES },
  { framing: "chunked", size: 4 * MAX_EXPERIMENT_MESSAGE_BYTES },
])("an oversized $framing upload of $size bytes receives the complete 413 response", async ({ framing, size }) => {
  const relay = await setup();
  const body = Buffer.alloc(size, "x");
  const request = httpRequest(relay.url, { method: "POST", headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
    ...(framing === "content-length" ? { "Content-Length": String(body.length) } : { "Transfer-Encoding": "chunked" }),
  } });
  clients.push(request);
  const pending = readRelayHttpResponse(request);
  request.end(body);
  expect(await pending).toMatchObject({ status: 413, body: "", connection: "close" });
  expect(relay.failureCode).toBeNull();
  const captured = records(relay);
  expect(captured.filter((entry) => entry.kind === "http_response")).toEqual([
    expect.objectContaining({ status: 413, bytes_base64: "" }),
  ]);
  expect(captured.find((entry) => entry.kind === "http_request")).toMatchObject({ body_complete: false });
  expect(captured.filter((entry) => entry.kind === "server_stdin")).toHaveLength(0);
});

test("413 draining uses only the time remaining in the original body deadline", async () => {
  const relay = await setup();
  const timeout = globalThis.setTimeout;
  const deadlines: Array<{ delay: number; fire: () => void }> = [];
  const parkedTimers: ReturnType<typeof setTimeout>[] = [];
  let now = Date.now();
  let started!: () => void;
  const bodyStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const clockSpy = spyOn(Date, "now").mockImplementation(() => now);
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: any[]) => void, delay?: number, ...args: any[]
  ) => {
    if (delay !== 30_000 && delay !== 20_000) return timeout(callback, delay, ...args);
    deadlines.push({ delay, fire: () => callback(...args) });
    const timer = timeout(callback, 60_000, ...args);
    parkedTimers.push(timer);
    if (delay === 30_000) started();
    return timer;
  }) as typeof setTimeout);
  try {
    const address = new URL(relay.url);
    const socket = connect({ host: address.hostname, port: Number(address.port), allowHalfOpen: true });
    sockets.push(socket);
    const headers = new Promise<string>((resolveHeaders, reject) => {
      let bytes = "";
      socket.on("data", (chunk) => {
        bytes += chunk.toString();
        if (bytes.includes("\r\n\r\n")) resolveHeaders(bytes);
      });
      socket.once("error", reject);
    });
    const ended = new Promise<void>((resolveEnded, reject) => {
      socket.once("end", resolveEnded);
      socket.once("error", reject);
    });
    socket.write(`POST /mcp HTTP/1.1\r\nHost: ${address.host}\r\nAuthorization: Bearer ${relay.token}\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n`);
    expect(await Promise.race([bodyStarted.then(() => "started"), Bun.sleep(300).then(() => "waiting")])).toBe("started");
    now += 10_000;
    socket.write(`${MAX_EXPERIMENT_MESSAGE_BYTES.toString(16)}\r\n${"x".repeat(MAX_EXPERIMENT_MESSAGE_BYTES)}\r\n`);
    expect(await headers).toContain("413");
    expect(deadlines.map(({ delay }) => delay)).toEqual([30_000, 20_000]);
    now += 20_000;
    deadlines[1]!.fire();
    expect(await Promise.race([ended.then(() => "ended"), Bun.sleep(300).then(() => "waiting")])).toBe("ended");
    expect(relay.failureCode).toBeNull();
  } finally {
    for (const timer of parkedTimers) clearTimeout(timer);
    timerSpy.mockRestore();
    clockSpy.mockRestore();
  }
});

function transport(status = 413) {
  const request = new EventEmitter() as ClientRequest;
  const response = Object.assign(new EventEmitter(), { statusCode: status, headers: {}, complete: false }) as IncomingMessage;
  const pending = readRelayHttpResponse(request);
  return { request, response, pending };
}

function uploadError(code: string) { return Object.assign(new Error(`upload failed: ${code}`), { code }); }
function finish(response: IncomingMessage, complete = true) {
  response.complete = complete;
  response.emit("end");
  response.emit("close");
}

test.each(["EPIPE", "ECONNRESET"])("a %s upload error during a 413 still requires the complete response", async (code) => {
  const { request, response, pending } = transport();
  request.emit("response", response);
  request.emit("error", uploadError(code));
  response.emit("data", Buffer.from("rejected"));
  finish(response);
  request.emit("close");
  expect(await pending).toMatchObject({ status: 413, body: "rejected" });
});

test("multiple upload errors after a complete 413 stay handled through client close", async () => {
  const { request, response, pending } = transport();
  request.emit("response", response);
  finish(response);
  for (const code of ["EPIPE", "EPIPE", "ECONNRESET"]) request.emit("error", uploadError(code));
  request.emit("close");
  expect(await pending).toMatchObject({ status: 413, body: "" });
});

test.each(["EPIPE", "ECONNRESET"])("a %s upload error before any response is rejected", async (code) => {
  const { request, pending } = transport();
  const error = uploadError(code);
  const rejection = pending.catch((failure) => failure);
  request.emit("error", error);
  request.emit("close");
  expect(await rejection).toBe(error);
});

test.each(["EPIPE", "ECONNRESET", "ETIMEDOUT"])("a %s upload error cannot replace a non-413 response", async (code) => {
  const { request, response, pending } = transport(200);
  const error = uploadError(code);
  const rejection = pending.catch((failure) => failure);
  request.emit("response", response);
  finish(response);
  request.emit("error", error);
  request.emit("close");
  expect(await rejection).toBe(error);
});

test("an unrelated upload error is rejected after 413 headers", async () => {
  const { request, response, pending } = transport();
  const error = uploadError("ETIMEDOUT");
  const rejection = pending.catch((failure) => failure);
  request.emit("response", response);
  request.emit("error", error);
  finish(response);
  request.emit("close");
  expect(await rejection).toBe(error);
});

test.each(["end", "close", "aborted"])("an incomplete 413 is rejected on response %s despite an upload error", async (event) => {
  const { request, response, pending } = transport();
  const rejection = pending.catch((failure) => failure);
  request.emit("response", response);
  request.emit("error", uploadError("EPIPE"));
  response.emit(event);
  request.emit("close");
  expect(await rejection).toMatchObject({ message: expect.stringMatching(/incomplete|aborted/) });
});

test("a response error is rejected even after 413 headers", async () => {
  const { request, response, pending } = transport();
  const error = uploadError("ECONNRESET");
  const rejection = pending.catch((failure) => failure);
  request.emit("response", response);
  response.emit("error", error);
  request.emit("close");
  expect(await rejection).toBe(error);
});

test("client close without any response is rejected", async () => {
  const { request, pending } = transport();
  const rejection = pending.catch((failure) => failure);
  request.emit("close");
  expect(await rejection).toMatchObject({ message: "experiment relay closed without an HTTP response" });
});
