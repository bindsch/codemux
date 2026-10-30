import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { readRelayHttpResponse } from "./experiment-relay-http.js";

const relays: ExperimentHttpRelay[] = [];
const methods = ["resources/list", "resources/templates/list", "resources/read"];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

async function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/relay-task-aa");
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

function dispatched(relay: ExperimentHttpRelay): any[] {
  return records(relay).filter((entry) => entry.kind === "server_stdin")
    .map((entry) => JSON.parse(Buffer.from(entry.bytes_base64, "base64").toString()));
}

async function post(relay: ExperimentHttpRelay, method: string, id?: string | number, authenticated = true) {
  const request = httpRequest(relay.url, { method: "POST", agent: false, headers: {
    Authorization: `Bearer ${authenticated ? relay.token : "wrong-token"}`, "Content-Type": "application/json",
  } });
  const response = readRelayHttpResponse(request);
  request.end(JSON.stringify({ jsonrpc: "2.0", method, ...(id === undefined ? {} : { id }),
    ...(method === "resources/read" ? { params: { uri: "fixture://hidden" } } : {}) }));
  return response;
}

function expectLocalResource(relay: ExperimentHttpRelay, method: string, id: string | number | null, before: number) {
  expect(dispatched(relay)).toEqual([]);
  expect(records(relay).filter((entry) => entry.kind === "mcp_request")).toEqual([]);
  expect(records(relay).filter((entry) => entry.kind === "failure")).toEqual([]);
  expect(relay.failureCode).toBeNull();
  expect(relay.failureError).toBeNull();
  const resources = records(relay).filter((entry) => entry.kind === "relay_resources");
  expect(resources).toHaveLength(1);
  expect(resources[0]).toMatchObject({ method, rpc_id: id });
  expect(typeof resources[0].t).toBe("number");
  expect(resources[0].t).toBeGreaterThanOrEqual(before);
  expect(resources[0].t).toBeLessThanOrEqual(Date.now() / 1000);
}

test.each([
  ["resources/list", 0], ["resources/list", "resource-request"],
  ["resources/templates/list", 0], ["resources/templates/list", "resource-request"],
] as const)("%s returns an exact empty local result with RPC ID %s", async (method, id) => {
  const relay = await setup();
  const before = Date.now() / 1000;
  const response = await post(relay, method, id);
  expect(response.status).toBe(200);
  expect(response.type).toBe("application/json");
  expect(JSON.parse(response.body)).toEqual({ jsonrpc: "2.0", id,
    result: method === "resources/list" ? { resources: [] } : { resourceTemplates: [] } });
  expectLocalResource(relay, method, id, before);
});

test.each([0, "read-request"])("resource reads return the exact local error without failing the run: %s", async (id) => {
  const relay = await setup();
  const before = Date.now() / 1000;
  const response = await post(relay, "resources/read", id);
  expect(response.status).toBe(200);
  expect(response.type).toBe("application/json");
  expect(JSON.parse(response.body)).toEqual({ jsonrpc: "2.0", id, error: { code: -32002, message: "no resources" } });
  expectLocalResource(relay, "resources/read", id, before);
  expect(JSON.parse((await post(relay, "ping", "after-read")).body))
    .toEqual({ jsonrpc: "2.0", id: "after-read", result: {} });
  expect((await post(relay, "tools/list", "inventory")).status).toBe(200);
  relay.finish();
  await relay.close();
  expect(records(relay).find((entry) => entry.kind === "run_end")).toMatchObject({ code: null, error: null });
});

test.each(methods)("resource notifications stay local with no JSON-RPC reply: %s", async (method) => {
  const relay = await setup();
  const before = Date.now() / 1000;
  const response = await post(relay, method);
  expect(response.status).toBe(202);
  expect(response.body).toBe("");
  expectLocalResource(relay, method, null, before);
});

test.each(methods)("unauthenticated resource requests have no resource record or dispatch: %s", async (method) => {
  const relay = await setup();
  const response = await post(relay, method, "unauthenticated", false);
  expect(response.status).toBe(401);
  expect(response.body).toBe("");
  expect(dispatched(relay)).toEqual([]);
  expect(records(relay).filter((entry) => entry.kind === "relay_resources" || entry.kind === "mcp_request")).toEqual([]);
  expect(relay.failureCode).toBeNull();
});
