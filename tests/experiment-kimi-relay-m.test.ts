import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { assertKimiResult, kimiToolName } from "../src/experiment-kimi-content.js";
import { kimiExperimentToolPattern } from "../src/experiment-kimi-config.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";

const relays: ExperimentHttpRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

async function setup(result: object = { content: [{ type: "text", text: "answer" }] }) {
  const parent = resolve("scratch/session-14c66a93/exp/relay-m-tests");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const script = `import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line); if (m.id === undefined) continue;
      const result = m.method === 'tools/list' ? {tools:[{name:'lookup'}]} : ${JSON.stringify(result)};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    }`;
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, "-e", script],
    env: [], recording: join(cwd, "recordings") }, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async (call) => `native-${call.relay_index}`;
  relay.validateResult = assertKimiResult;
  await relay.start();
  return relay;
}

function records(relay: ExperimentHttpRelay): Record<string, any>[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function rpc(relay: ExperimentHttpRelay, id: number, method: string, params?: object) {
  return new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const request = httpRequest(relay.url, { method: "POST", headers: { Authorization: `Bearer ${relay.token}` } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveResponse({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.once("error", reject);
    request.end(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
  });
}

test.each([
  ["audio", { type: "audio", data: "YWJj", mimeType: "audio/wav" }],
  ["resource_link", { type: "resource_link", name: "fixture", uri: "file:///fixture" }],
  ["resource", { type: "resource", resource: { uri: "file:///fixture", text: "answer" } }],
  ["numeric text", { type: "text", text: 5 }],
  ["missing text", { type: "text" }],
  ["numeric image data", { type: "image", data: 5 }],
  ["numeric image MIME type", { type: "image", data: "YWJj", mimeType: 5 }],
  ["null", null],
])("Kimi refuses %s content at the relay before sending result bytes", async (_label, block) => {
  const result = { content: [{ type: "text", text: "prefix" }, block] };
  const relay = await setup(result);
  expect((await rpc(relay, 1, "tools/list")).status).toBe(200);
  expect(await rpc(relay, 2, "tools/call", { name: "lookup", arguments: {} })).toEqual({ status: 400, body: "" });
  expect(relay.failureCode).toBe(Code.UnsupportedResult);
  expect(relay.calls[0]?.result).toBeUndefined();
  const captured = records(relay);
  expect(captured.find((record) => record.kind === "server_tool_result")?.result).toEqual(result);
  const failureIndex = captured.findIndex((record) => record.kind === "failure");
  const responseIndex = captured.findLastIndex((record) => record.kind === "http_response");
  expect(failureIndex).toBeGreaterThan(-1);
  expect(failureIndex).toBeLessThan(responseIndex);
  expect(captured[responseIndex]).toMatchObject({ status: 400, bytes_base64: "" });
});

test.each([
  ["text", [{ type: "text", text: "answer" }]],
  ["image", [{ type: "image", data: "YWJj", mimeType: "image/png" }]],
  ["default image MIME type", [{ type: "image", data: "YWJj" }]],
])("Kimi relay preserves supported %s content", async (_label, content) => {
  const result = { content };
  const relay = await setup(result);
  expect((await rpc(relay, 1, "tools/list")).status).toBe(200);
  const response = await rpc(relay, 2, "tools/call", { name: "lookup", arguments: {} });
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).result).toEqual(result);
  expect(relay.calls[0]?.result).toEqual(result);
  expect(relay.failureCode).toBeNull();
});

function partialUnauthorizedRequest(relay: ExperimentHttpRelay, authorization?: string): Promise<string> {
  return new Promise((resolveResponse, reject) => {
    const url = new URL(relay.url);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let response = "";
    const timer = setTimeout(() => socket.destroy(), 100);
    socket.once("error", reject);
    socket.on("data", (bytes) => { response += bytes.toString(); socket.destroy(); });
    socket.once("close", () => { clearTimeout(timer); resolveResponse(response); });
    socket.once("connect", () => socket.write([
      "POST /mcp HTTP/1.1", `Host: ${url.host}`, "Content-Length: 1000",
      ...(authorization === undefined ? [] : [`Authorization: ${authorization}`]), "", "partial-private-body",
    ].join("\r\n")));
  });
}

test.each([undefined, "Bearer wrong"])("unauthenticated partial request gets 401 before its body completes: %s", async (authorization) => {
  const relay = await setup();
  let aborted = false;
  relay.onFailure(() => { aborted = true; });
  const response = await partialUnauthorizedRequest(relay, authorization);
  await Bun.sleep(10);
  expect(relay.failureCode).toBeNull();
  expect(aborted).toBe(false);
  expect(response).toMatch(/^HTTP\/1\.1 401 /);
  const captured = records(relay);
  expect(captured.filter((record) => record.kind === "http_request")).toEqual([
    expect.objectContaining({ method: "POST", path: "/mcp", token_matched: false, bytes_base64: "", body_complete: false }),
  ]);
  expect(captured.filter((record) => record.kind === "http_response")).toEqual([]);
  expect(captured.some((record) => record.kind === "server_stdin" || record.kind === "failure")).toBe(false);
  expect((await rpc(relay, 1, "tools/list")).status).toBe(200);
  expect((await rpc(relay, 2, "tools/call", { name: "lookup", arguments: {} })).status).toBe(200);
  relay.finish();
});

test.each([
  ["qa__dev__run", "a__b__c", "mcp__qa_dev_run__a_b_c", "mcp__qa_dev_run__*"],
  ["qa___dev__run_", "a___b__c_", "mcp__qa_dev_run___a_b_c_", "mcp__qa_dev_run___*"],
  ["qa..dev__run", "a..b__c", "mcp__qa_dev_run__a_b_c", "mcp__qa_dev_run__*"],
  ["qa--dev__run", "a--b__c", "mcp__qa--dev_run__a--b_c", "mcp__qa--dev_run__*"],
])("Kimi tool names and profile patterns collapse every underscore run: %s / %s", (server, tool, expectedName, expectedPattern) => {
  expect(kimiToolName(server!, tool!)).toBe(expectedName!);
  expect(kimiExperimentToolPattern(server!)).toBe(expectedPattern!);
});
