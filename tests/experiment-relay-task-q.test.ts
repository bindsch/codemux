import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";

const relays: ExperimentHttpRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

async function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/relay-task-q");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
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

function post(relay: ExperimentHttpRelay, body: string, authenticated = true) {
  return new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const request = httpRequest(relay.url, { method: "POST", headers: {
      ...(authenticated ? { Authorization: `Bearer ${relay.token}` } : {}), "Content-Type": "application/json",
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveResponse({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

const sequence = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "synthetic" } } },
];

const malformedRequests = [
  { label: "malformed JSON", body: "{" },
  { label: "invalid JSON-RPC envelope", body: JSON.stringify({ jsonrpc: "1.0", id: 0, method: "initialize" }) },
  { label: "non-object JSON-RPC envelope", body: "[]" },
  { label: "invalid request ID", body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "initialize" }) },
  { label: "invalid parameters", body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: [] }) },
];

test.each(malformedRequests)("authenticated $label latches protocol failure before a valid MCP sequence", async ({ body }) => {
  const relay = await setup();
  const failures: Error[] = [];
  relay.onFailure((error) => failures.push(error));
  expect(await post(relay, body)).toEqual({ status: 400, body: "" });
  expect(relay.failureCode).toBe(Code.Protocol);
  expect(failures).toHaveLength(1);
  for (const message of sequence) expect((await post(relay, JSON.stringify(message))).status).toBe(400);
  expect(relay.calls).toHaveLength(0);
  expect(() => relay.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
  await expect(relay.close()).rejects.toMatchObject({ code: Code.Protocol });
  const captured = records(relay);
  expect(captured.filter((entry) => entry.kind === "server_stdin")).toHaveLength(0);
  expect(captured.filter((entry) => entry.kind === "failure")).toEqual([
    expect.objectContaining({ code: Code.Protocol }),
  ]);
  expect(captured.filter((entry) => entry.kind === "http_request")[0]).toMatchObject({
    token_matched: true, bytes_base64: Buffer.from(body).toString("base64"), body_complete: true,
  });
  expect(captured.at(-1)).toMatchObject({ kind: "run_end", code: Code.Protocol, tool_calls: 0 });
});

test("malformed authenticated JSON fails an already validated relay", async () => {
  const relay = await setup();
  for (const message of sequence) {
    expect((await post(relay, JSON.stringify(message))).status).toBe(message.id === undefined ? 202 : 200);
  }
  expect(() => relay.finish()).not.toThrow();
  expect((await post(relay, "{")).status).toBe(400);
  expect(relay.failureCode).toBe(Code.Protocol);
  expect(() => relay.finish()).toThrow(expect.objectContaining({ code: Code.Protocol }));
  expect(relay.calls).toHaveLength(1);
});

test.each(malformedRequests)("unauthenticated $label does not fail the experiment", async ({ body }) => {
  const relay = await setup();
  expect((await post(relay, body, false)).status).toBe(401);
  expect(relay.failureCode).toBeNull();
  for (const message of sequence) {
    expect((await post(relay, JSON.stringify(message))).status).toBe(message.id === undefined ? 202 : 200);
  }
  expect(() => relay.finish()).not.toThrow();
  expect(records(relay).filter((entry) => entry.kind === "failure")).toHaveLength(0);
});
