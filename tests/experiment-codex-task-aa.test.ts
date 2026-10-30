import { expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { ExperimentCodexEvidence } from "../src/experiment-codex.js";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentServer, type JsonObject } from "../src/experiment-server.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

const TIME = "2026-10-29T01:02:03.125Z";
const THREAD = "12345678-1234-4234-8234-123456789abc";
const RESOURCE_NAMES = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const TOOLS = Object.fromEntries(["mcp__experiment", "mcp__experiment.lookup", "functions",
  ...RESOURCE_NAMES.map((name) => `functions.${name}`)].map((name) => [name, "hash"]));
const USAGE = { input_tokens: 4, output_tokens: 1, cached_input_tokens: 0 };
const line = (type: string, payload: JsonObject) => ({ timestamp: TIME, type, payload });
const world = (tools: unknown = TOOLS) => line("world_state", { full: true, state: { top_level_tools: tools } });

function parserFixture() {
  const records: JsonObject[] = [];
  const parser = new CodexRolloutParser(THREAD, "experiment", () => new Set(["lookup"]),
    (kind, fields) => records.push({ kind, ...fields }), () => codexDefinitions(["lookup"]));
  return { parser, records };
}

test("Codex accepts and records only experiment tools and the resource trio in world_state", () => {
  const { parser, records } = parserFixture();
  expect(() => parser.accept(world())).not.toThrow();
  expect(records).toEqual([{ kind: "harness_top_level_tools", tools: TOOLS, t: Date.parse(TIME) / 1000 }]);
});

test.each(["clock.sleep", "apply_patch", "collaboration.list_agents", "functions.request_user_input", "foreign"])(
  "Codex rejects visible %s before any native call", (name) => {
    const { parser, records } = parserFixture();
    expect(() => parser.accept(world({ ...TOOLS, [name]: "hash" })))
      .toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
    expect(records).toHaveLength(1);
    expect(records[0]!.tools[name]).toBe("hash");
    expect(parser.calls).toHaveLength(0);
  });

test.each([undefined, null, [], "invalid", { "mcp__experiment.lookup": 42 }].map((tools) => ({ tools })))(
  "Codex refuses malformed first world_state tools: %j", ({ tools }) => {
    const { parser } = parserFixture();
    const entry = line("world_state", { full: true, state: { top_level_tools: tools } });
    expect(() => parser.accept(entry)).toThrow(expect.objectContaining({ code: "harness_log_missing" }));
  });

test("Codex rechecks a changed top-level inventory after the initial full snapshot", () => {
  const { parser, records } = parserFixture();
  parser.accept(world());
  parser.accept(line("world_state", { full: false, state: { cwd: "/workspace" } }));
  expect(() => parser.accept(line("world_state", { full: false,
    state: { top_level_tools: { ...TOOLS, "clock.sleep": "hash" } } })))
    .toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
  expect(records.filter((record) => record.kind === "harness_top_level_tools")).toHaveLength(2);
});

test.each(RESOURCE_NAMES)("Codex records %s as a harmless harness builtin call", (name) => {
  const { parser, records } = parserFixture();
  const input = name === "read_mcp_resource" ? { server: "experiment", uri: "secret://world" } : { server: "experiment" };
  const harnessOutput = name === "read_mcp_resource" ? "resources/read failed: no resources" : "[]";
  parser.accept(world());
  parser.accept(codexCatalog(["lookup"]));
  parser.accept(line("response_item", { type: "function_call", namespace: "functions", name,
    id: "fc-resource", call_id: "call-resource", arguments: JSON.stringify(input) }));
  parser.accept(line("response_item", { type: "function_call_output", call_id: "call-resource", output: harnessOutput }));
  parser.accept(line("event_msg", { type: "token_count", info: { last_token_usage: USAGE } }));
  expect(() => parser.finish()).not.toThrow();
  expect(parser.calls).toHaveLength(0);
  expect(records.filter((record) => record.kind === "harness_builtin_call")).toEqual([
    { kind: "harness_builtin_call", call_id: "call-resource", name: `functions.${name}`, input, harness_output: harnessOutput },
  ]);
  expect(records.some((record) => record.kind === "model_tool_error")).toBe(false);
});

test.each(["null", "[]", "{invalid", ""])("Codex retains native resource argument errors without failing: %j", (argumentsText) => {
  const { parser, records } = parserFixture();
  parser.accept(world()); parser.accept(codexCatalog(["lookup"]));
  parser.accept(line("response_item", { type: "function_call", namespace: "functions", name: "list_mcp_resources",
    id: "fc-resource", call_id: "call-resource", arguments: argumentsText }));
  parser.accept(line("response_item", { type: "function_call_output", call_id: "call-resource", output: "no resources" }));
  parser.accept(line("event_msg", { type: "token_count", info: { last_token_usage: USAGE } }));
  expect(() => parser.finish()).not.toThrow();
  expect(records.filter((record) => record.kind === "harness_builtin_call")).toHaveLength(1);
});

test("Codex requires output evidence for a resource builtin call", () => {
  const { parser } = parserFixture();
  parser.accept(world());
  parser.accept(codexCatalog(["lookup"]));
  parser.accept(line("response_item", { type: "function_call", name: "read_mcp_resource",
    id: "fc-resource", call_id: "call-resource", arguments: "{}" }));
  expect(() => parser.finish({ timedOut: true })).toThrow(expect.objectContaining({ code: "harness_log_missing" }));
});

test.each(RESOURCE_NAMES)("Codex refuses a literal functions prefix in resource call name %s", (name) => {
  for (const namespace of [undefined, "functions"]) {
    const { parser } = parserFixture();
    parser.accept(world()); parser.accept(codexCatalog(["lookup"]));
    expect(() => parser.accept(line("response_item", { type: "function_call", namespace,
      name: `functions.${name}`, id: "fc-resource", call_id: "call-resource", arguments: "{}" })))
      .toThrow(expect.objectContaining({ code: "unknown_tool" }));
  }
});

test("the preserved live rollout is rejected for its visible builtins", () => {
  const path = "scratch/session-14c66a93/exp/probe/recordings/8415a55b-5587-4255-bd7d-d80c22ca40f6.codex-rollout.jsonl";
  const excerpt = JSON.parse(readFileSync(new URL("./fixtures/experiment-codex-world-state-excerpt.json", import.meta.url), "utf8"));
  // Replay the complete preserved rollout when available; retain its native inventory for clean checkouts.
  const lines: JsonObject[] = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((raw) => JSON.parse(raw))
    : [excerpt.world_state];
  const records: JsonObject[] = [];
  const catalog = lines.find((entry) => entry.payload.type === "additional_tools");
  const definitions = catalog ? catalog.payload.tools.find((tool: JsonObject) => tool.name === "mcp__experiment").tools
    .map((tool: JsonObject) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) : codexDefinitions(["bash"]);
  const parser = new CodexRolloutParser(lines[0]!.payload.id ?? excerpt.provenance.source_run_id, "experiment", () => new Set(["bash"]),
    (kind, fields) => records.push({ kind, ...fields }), () => definitions);
  expect(() => { for (const entry of lines) parser.accept(entry); })
    .toThrow(expect.objectContaining({ code: "inventory_mismatch" }));
  const inventory = records.find((record) => record.kind === "harness_top_level_tools")!;
  expect(Object.keys(inventory.tools)).toContain("clock.sleep");
  expect(parser.calls).toHaveLength(0);
  expect(records.some((record) => record.kind === "harness_tool_call")).toBe(false);
});

function homeFixture() {
  const parent = resolve("scratch/session-14c66a93/exp/aa-inventory-fixtures");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const sessions = join(home, "sessions/2026/10/29");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
  writeFileSync(rollout, JSON.stringify(line("session_meta", { id: THREAD })) + "\n");
  return { home, rollout };
}

test.each([
  ...RESOURCE_NAMES.map((name) => ({ name, change: undefined as JsonObject | undefined })),
  ...[{ server: "foreign" }, { tool: "lookup" }, { arguments: { changed: true } }, { call_id: "different" },
    { error: { message: "changed" } }, { status: "completed" }].map((change) => ({ name: "read_mcp_resource", change })),
  { name: "list_mcp_resources", change: { result: { content: [{ type: "text", text: "changed" }] } } },
])("Codex verifies native resource exec evidence against the rollout: %j", ({ name, change }) => {
  const { home, rollout } = homeFixture();
  const input = { server: "experiment", ...(name === "read_mcp_resource" ? { uri: "secret://world" } : {}) };
  const read = name === "read_mcp_resource";
  const output = read ? "resources/read failed: no resources" : JSON.stringify({ server: "experiment",
    [name === "list_mcp_resources" ? "resources" : "resourceTemplates"]: [] });
  appendFileSync(rollout, [world(), codexCatalog(["lookup"]), line("response_item", { type: "function_call",
    namespace: "functions", name, id: "fc-resource", call_id: "call-resource", arguments: JSON.stringify(input) }),
  line("response_item", { type: "function_call_output", call_id: "call-resource", output }),
  line("event_msg", { type: "token_count", info: { last_token_usage: USAGE } })]
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const records: JsonObject[] = [];
  const evidence = new ExperimentCodexEvidence({ spec: { name: "experiment", accept_harness_prefix: ["codex-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: codexDefinitions(["lookup"]), calls: [],
    record: (kind, fields) => records.push({ kind, ...fields }) });
  evidence.accept({ type: "thread.started", thread_id: THREAD });
  evidence.accept({ type: "item.completed", item: { type: "mcp_tool_call", id: "item-0", server: "experiment", tool: name,
    arguments: input, status: read ? "failed" : "completed", result: read ? null : {
      content: [{ type: "text", text: output }], structured_content: null }, error: read ? { message: output } : null, ...change } });
  if (change) expect(() => evidence.finish(home)).toThrow(expect.objectContaining({ code: "result_changed" }));
  else expect(() => evidence.finish(home)).not.toThrow();
  expect(records.filter((record) => record.kind === "harness_builtin_call")).toMatchObject([
    { call_id: "call-resource", name: `functions.${name}`, input, harness_output: output },
  ]);
});

test.each(["pass", "leak", "missing"])(
  "Codex blocks metadata-based first dispatch until inventory passes: %s", async (mode) => {
    const { home, rollout } = homeFixture();
    const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
    let dispatches = 0;
    const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => {
      if (message.method === "tools/call") dispatches++;
      return { jsonrpc: "2.0", id: message.id, result: message.method === "tools/list"
        ? { tools: codexDefinitions(["lookup"]) } : { content: [{ type: "text", text: "ok" }] } };
    });
    const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath, args: [], env: [],
      recording: join(home, "records") }, home, {});
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: home, callIdTimeoutMs: 600,
      onFailure: (error) => relay.fail(error) });
    relay.resolveCallId = (call, message) => evidence.resolveCallId(call, message);
    let aborted = false;
    relay.onFailure(() => { aborted = true; });
    const post = async (id: number, method: string, params?: JsonObject) => {
      const response = await fetch(relay.url, { method: "POST", headers: {
        Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
      }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      await response.text();
      return response.status;
    };
    try {
      await relay.start();
      expect(await post(1, "tools/list")).toBe(200);
      evidence.accept({ type: "thread.started", thread_id: THREAD });
      const pending = post(2, "tools/call", { name: "lookup", arguments: {}, _meta: { callId: "native" } });
      await Bun.sleep(30);
      expect(dispatches).toBe(0);
      if (mode !== "missing") appendFileSync(rollout, JSON.stringify(world(mode === "leak"
        ? { ...TOOLS, "clock.sleep": "hash" } : TOOLS)) + "\n");
      expect(await pending).toBe(mode === "pass" ? 200 : 400);
      expect(dispatches).toBe(mode === "pass" ? 1 : 0);
      expect(relay.failureCode).toBe(mode === "pass" ? null : mode === "leak" ? Code.InventoryMismatch : Code.HarnessLogMissing);
      expect(aborted).toBe(mode !== "pass");
    } finally {
      evidence.stop(); await relay.close().catch(() => {});
      request.mockRestore(); start.mockRestore();
    }
  });

test("Codex exiting during its first inventory wait reports harness_log_missing", async () => {
  const { home } = homeFixture();
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  let dispatches = 0;
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => {
    if (message.method === "tools/call") dispatches++;
    return { jsonrpc: "2.0", id: message.id, result: { tools: codexDefinitions(["lookup"]) } };
  });
  const run = new ExperimentCodexRun({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(home, "records"), accept_harness_prefix: ["codex-wall-time"] }, home, home, true, {});
  let pending: Promise<Response> | undefined;
  try {
    await run.prepare();
    const post = (id: number, method: string, params?: JsonObject) => fetch(run.relay.url, { method: "POST", headers: {
      Authorization: `Bearer ${run.relay.token}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const listed = await post(1, "tools/list"); await listed.text();
    run.push(JSON.stringify({ type: "thread.started", thread_id: THREAD }) + "\n");
    pending = post(2, "tools/call", { name: "lookup", arguments: {}, _meta: { callId: "native" } });
    const deadline = Date.now() + 1000;
    while (!run.relay.calls.length && Date.now() < deadline) await Bun.sleep(1);
    expect(run.relay.calls).toHaveLength(1);
    await expect(run.complete()).rejects.toMatchObject({ code: Code.HarnessLogMissing });
    expect(dispatches).toBe(0);
  } finally {
    await run.close().catch(() => {});
    await pending?.then((response) => response.text()).catch(() => {});
    request.mockRestore(); start.mockRestore();
  }
});
