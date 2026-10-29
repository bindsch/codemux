import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { join, resolve } from "node:path";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { writeKimiExperimentConfig } from "../src/experiment-kimi-config.js";
import { readExperimentSpec, type ExperimentSpec } from "../src/experiment-mcp.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentServer, type JsonObject } from "../src/experiment-server.js";
import { readRelayHttpResponse } from "./experiment-relay-http.js";

const relays: ExperimentHttpRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

function directory() {
  const parent = resolve("scratch/session-14c66a93/exp/tool-timeout-task-t");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "case-"));
}

function specification(cwd: string, extra: Record<string, unknown> = {}) {
  const spec = { name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings"), ...extra };
  const path = join(cwd, "spec.json");
  writeFileSync(path, JSON.stringify(spec));
  return { path, spec };
}

test.each([1, 7200, 86400])("experiment spec accepts a %i-second tool timeout", (seconds) => {
  const { path } = specification(directory(), { tool_timeout_seconds: seconds });
  expect(readExperimentSpec(path).tool_timeout_seconds).toBe(seconds);
});

test.each([null, 0, -1, 1.5, "7200", true, {}, [], 86401, Number.MAX_SAFE_INTEGER].map((seconds) => ({ seconds })))(
  "experiment spec rejects invalid tool timeout $seconds", ({ seconds }) => {
    const { path } = specification(directory(), { tool_timeout_seconds: seconds });
    expect(() => readExperimentSpec(path)).toThrow("tool_timeout_seconds must be a positive integer at most 86400");
  });

test.each([undefined, 1, 86400])("Codex config uses the selected tool timeout: %j", async (seconds) => {
  const cwd = directory();
  const home = join(cwd, "codex");
  mkdirSync(home, { mode: 0o700 });
  const { spec } = specification(cwd, seconds === undefined ? {} : { tool_timeout_seconds: seconds });
  const run = new ExperimentCodexRun(spec as ExperimentSpec, cwd, home, true, {});
  await run.prepare("0.165.0");
  relays.push(run.relay);
  const path = join(home, "config.toml");
  const config = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
  expect(config.mcp_servers.experiment).toMatchObject({
    startup_timeout_sec: 120, tool_timeout_sec: seconds ?? 7200,
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test.each([undefined, 1, 86400])("Kimi's private MCP files use the selected tool timeout: %j", async (seconds) => {
  const cwd = directory();
  const home = join(cwd, "kimi");
  mkdirSync(home, { mode: 0o700 });
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, 'default_model = "fixture"\n[mcp]\nstartup_timeout_ms = 123\ntool_timeout_ms = 456\n[models.fixture]\nprovider = "private"\n');
  const { spec } = specification(cwd, seconds === undefined ? {} : { tool_timeout_seconds: seconds });
  const relay = new ExperimentHttpRelay(spec as ExperimentSpec, cwd, {});
  relays.push(relay);
  await relay.start();
  writeKimiExperimentConfig(relay, home, join(cwd, "agent.md"));
  const milliseconds = (seconds ?? 7200) * 1000;
  const mcp = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"));
  expect(mcp.mcpServers.experiment).toMatchObject({ startupTimeoutMs: 120000, toolTimeoutMs: milliseconds });
  const configText = readFileSync(configPath, "utf8");
  expect(configText).toContain("[mcp]\n");
  expect(Bun.TOML.parse(configText)).toEqual({ default_model: "fixture", models: { fixture: { provider: "private" } },
    mcp: { startup_timeout_ms: 123, tool_timeout_ms: milliseconds } });
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, "mcp.json")).mode & 0o777).toBe(0o600);
});

test("Kimi creates its timeout table when the private TOML config is absent", async () => {
  const cwd = directory();
  const home = join(cwd, "kimi");
  mkdirSync(home, { mode: 0o700 });
  const { spec } = specification(cwd);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  await relay.start();
  writeKimiExperimentConfig(relay, home, join(cwd, "agent.md"));
  expect(Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({ mcp: { tool_timeout_ms: 7200000 } });
});

test("Kimi rejects an invalid MCP timeout table before creating its private MCP endpoint", async () => {
  const cwd = directory();
  const home = join(cwd, "kimi");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "config.toml"), 'mcp = "invalid"\n');
  const { spec } = specification(cwd);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  await relay.start();
  expect(() => writeKimiExperimentConfig(relay, home, join(cwd, "agent.md"))).toThrow("MCP timeout table");
  expect(readFileSync(join(home, "config.toml"), "utf8")).toBe('mcp = "invalid"\n');
});

function post(relay: ExperimentHttpRelay, message: JsonObject) {
  const request = http.request(relay.url, { method: "POST", agent: false, headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
  } });
  const response = readRelayHttpResponse(request);
  request.end(JSON.stringify(message));
  return response;
}

test("a held tool response survives an injected short HTTP socket timeout", async () => {
  const cwd = directory();
  const { spec } = specification(cwd);
  spec.args = ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, "-e", `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const m = JSON.parse(line);
      const result = m.method === 'tools/list' ? { tools: [{ name: 'wait', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'held response' }] };
      if (m.method === 'tools/call') await Bun.sleep(120);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    }`];
  const createServer = http.createServer;
  let server!: http.Server;
  const create = spyOn(http, "createServer").mockImplementation(((...args: any[]) => {
    server = createServer(...args);
    // This 20 ms inactivity limit represents the transport's five-second default.
    server.timeout = 20;
    return server;
  }) as typeof http.createServer);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async () => "held-call";
  try { await relay.start(); } finally { create.mockRestore(); }
  expect((await post(relay, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  const response = await post(relay, { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "wait", arguments: {} } }).catch((error) => error);
  expect(response).toMatchObject({ status: 200 });
  expect(JSON.parse(response.body).result).toEqual({ content: [{ type: "text", text: "held response" }] });
  expect(server.timeout).toBe(0);
  expect(server.requestTimeout).toBe(0);
  expect(server.headersTimeout).toBe(120000);
  expect(server.keepAliveTimeout).toBe(86400000);
  expect(relay.failureError).toBeNull();
  relay.finish();
  await relay.close();
  const records = readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.at(-1)).toMatchObject({ kind: "run_end", model_tool_errors: 0, error: null });
});

test("stdio permits 256 held requests and still rejects duplicates and overflow", async () => {
  const cwd = directory();
  const { spec } = specification(cwd);
  spec.args = ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, "-e", `
    import { createInterface } from 'node:readline';
    const held = [];
    for await (const line of createInterface({ input: process.stdin })) {
      const m = JSON.parse(line);
      if (m.id !== undefined) held.push(m.id);
      else for (const id of held.splice(0)) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\\n');
    }`];
  const errors: Error[] = [];
  const server = new ExperimentServer(spec, cwd, {}, () => {}, (error) => errors.push(error));
  server.start();
  const pending: Promise<JsonObject | undefined>[] = [];
  try {
    for (let id = 0; id < 256; id++) pending.push(server.request({ jsonrpc: "2.0", id, method: "ping" }));
    expect(() => server.request({ jsonrpc: "2.0", id: 0, method: "ping" })).toThrow("duplicate id");
    expect(() => server.request({ jsonrpc: "2.0", id: 256, method: "ping" })).toThrow("outstanding requests");
    await server.request({ jsonrpc: "2.0", method: "release" });
    expect(await Promise.all(pending)).toHaveLength(256);
    expect(errors).toHaveLength(0);
  } finally {
    for (const request of pending) void request.catch(() => {});
    await server.close();
  }
});

test("relay run_end counts model_tool_error records without changing their fields", async () => {
  const cwd = directory();
  const { spec } = specification(cwd);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  relay.record("model_tool_error", { name: "first", message: "unsupported call" });
  relay.record("other", { model_tool_errors: 99 });
  relay.record("model_tool_error", { name: "second", message: "another unsupported call" });
  await relay.close();
  const records = readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.filter((record) => record.kind === "model_tool_error")).toMatchObject([
    { name: "first", message: "unsupported call" }, { name: "second", message: "another unsupported call" },
  ]);
  expect(records.at(-1)).toMatchObject({ kind: "run_end", model_tool_errors: 2, error: null });
});
