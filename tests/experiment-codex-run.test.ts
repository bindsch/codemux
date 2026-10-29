import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { codexCatalog } from "./fixtures/experiment-codex.js";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { launchRunRequest } from "../src/launch.js";
import * as runtime from "../src/cli-runtime.js";
import * as callLog from "../src/call-log.js";
import { assertNoCodexSystemMcp } from "../src/experiment-codex-config.js";
import { CODEX_PROVIDER_ID } from "../src/codex-provider.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { MARKER, respond } from "./fixtures/experiment-mcp.js";
import { minimalPath, runCli } from "./helpers/cli.js";
const contexts: { adapter: CodexAdapter; context: RunContext }[] = [];
afterEach(async () => {
  for (const { adapter, context } of contexts.splice(0)) {
    try { await adapter.cleanupRun(context); } catch { /* A failure fixture remains failed. */ }
  }
});
function setup(resultJson = true, model = "gpt-5.5", clientVersion = "0.165.0") {
  const parent = resolve("scratch/session-14c66a93/exp/synthetic");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "codex-"));
  const home = join(cwd, "operator");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
    client_version: clientVersion, fetched_at: "2026-10-29T00:00:00Z", models: [
      { slug: "gpt-5.5", tool_mode: "direct" }, { slug: "gpt-6-astra", tool_mode: "code_mode_only" },
    ],
  }));
  const specPath = join(cwd, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(cwd, "recordings"),
    accept_harness_prefix: ["codex-wall-time"] }));
  const request: RunRequest = { agent: "codex", prompt: "fixture", model, cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath, resultJson };
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  return { adapter, request, context, experiment: context.experimentCodex! };
}
async function callFixture(experiment: RunContext["experimentCodex"], context: RunContext, requestMeta = false) {
  const relay = experiment!.relay;
  async function post(message: object) {
    const response = await fetch(relay.url, { method: "POST", headers: {
      Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
    }, body: JSON.stringify(message) });
    expect(response.status).toBe(200);
    return response.json();
  }
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  if (!requestMeta) {
    rollout(context);
    experiment!.push(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\n");
  }
  await post({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "bash", arguments: { command: "marker" }, ...(requestMeta ? { _meta: { callId: "call_1" } } : {}) } });
}

function rollout(context: RunContext, output: unknown = [
  { type: "input_text", text: "Wall time: 0.0123 seconds\nOutput:" },
  { type: "input_text", text: MARKER },
]) {
  const sessions = join(context.hermeticHome!.codexHome, "sessions", "2026", "10", "29");
  mkdirSync(sessions, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id: "thread-test" } }, codexCatalog((respond({ id: 1, method: "tools/list" }) as any).result.tools),
    { type: "response_item", payload: { type: "function_call", id: "fc_1", call_id: "call_1",
      name: "mcp__experiment__bash", arguments: '{"command":"marker"}' } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10,
    } } } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output } },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "msg_2",
      content: [{ type: "output_text", text: "finished" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 120, cached_input_tokens: 30, cache_write_input_tokens: 0, output_tokens: 5,
    } } } },
  ].map((line, index) => ({ timestamp: `2026-10-29T00:00:0${index}.000Z`, ...line }));
  writeFileSync(join(sessions, "rollout-2026-10-29T00-00-00-thread-test.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function execEvents(context: RunContext, servedModel?: string) {
  const events = [
    { type: "turn.started" },
    ...(servedModel ? [{ type: "item.completed", item: { type: "error", id: "reroute",
      message: `model rerouted: gpt-6-astra -> ${servedModel} (Unavailable)` } }] : []),
    { type: "item.completed", item: { type: "mcp_tool_call", id: "item_1", server: "experiment",
      tool: "bash", arguments: { command: "marker" }, result: { content: [{ type: "text", text: MARKER }] }, status: "completed" } },
    { type: "item.completed", item: { type: "agent_message", id: "item_2", text: "finished" } },
    { type: "turn.completed", usage: { input_tokens: 220, cached_input_tokens: 50,
      cache_write_input_tokens: 0, output_tokens: 15 } },
  ];
  const wire = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  context.stdoutSink!.push(wire.slice(0, 39));
  context.stdoutSink!.push(wire.slice(39));
  return context.stdoutSink!.finish();
}

test("Codex forwards request-meta IDs before a rollout or thread exists", async () => {
  const { context, experiment } = setup();
  await experiment.prepare("0.165.0");
  await callFixture(experiment, context, true);
  expect(experiment.relay.calls[0]).toMatchObject({ call_id: "call_1", native_call_id_source: "request_meta" });
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((record) => record.kind === "tool_call")).toMatchObject({ native_call_id_source: "request_meta" });
  expect(records.find((record) => record.kind === "mcp_request" && record.relay_index === 0).message.params._meta)
    .toEqual({ callId: "call_1", "codemux/callId": "call_1" });
  rollout(context);
  experiment.push(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\n");
  execEvents(context);
  await experiment.complete();
});

test("a Codex copy error preserves the verified run verdict", async () => {
  const { adapter, context, experiment } = setup();
  await experiment.prepare("0.165.0");
  await callFixture(experiment, context);
  execEvents(context);
  writeFileSync(experiment.recordingPath.replace(/\.jsonl$/, ".codex-rollout.jsonl"), "existing artifact");
  await experiment.complete();
  await adapter.cleanupRun(context);
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.find((record) => record.kind === "harness_log_copy")).toMatchObject({ error: expect.any(String) });
  expect(records.at(-1)).toMatchObject({ kind: "run_end", code: null, error: null });
});

test.each([true, false])("Codex experiment lifecycle verifies a synthetic rollout and cleans its home: resultJson=%s", async (json) => {
  const { adapter, request, context, experiment } = setup(json);
  await experiment.prepare("0.165.0");
  const privateHome = context.hermeticHome!.home;
  const configPath = join(context.hermeticHome!.codexHome, "config.toml");
  const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as any;
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(config.mcp_servers.experiment).toEqual({ url: experiment.relay.url,
    http_headers: { Authorization: `Bearer ${experiment.relay.token}` }, required: true,
    startup_timeout_sec: 120, tool_timeout_sec: 600, omit_tools_from: ["deferred", "code_mode"] });
  expect(config.model_providers).toBeUndefined();
  const command = adapter.buildRunCommand(request, context);
  expect(command).not.toContain("--ephemeral");
  expect(command).not.toContain("--ignore-user-config");
  expect(command.join(" ")).not.toContain(experiment.relay.token);
  expect(JSON.stringify(adapter.getRunEnv(request, context))).not.toContain(experiment.relay.token);
  expect(command).toContain("features.non_prefixed_mcp_tool_names=false");
  await callFixture(experiment, context);
  rollout(context);
  const stdout = execEvents(context);
  await experiment.complete();
  const result = adapter.processRunResult({ stdout, stderr: "", success: true, exitCode: 0 }, request, context);
  expect(result).toMatchObject({ success: true });
  if (json) expect(JSON.parse(result.stdout).codemux.recording).toBe(experiment.recordingPath);
  else expect(result.stdout).toBe("finished\n");
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.filter((record) => record.kind === "turn")).toHaveLength(2);
  expect(records.filter((record) => record.kind === "tool_call")).toHaveLength(1);
  expect(records.filter((record) => record.kind === "harness_tool_result")).toHaveLength(1);
  expect(records.find((record) => record.kind === "result_comparison").equal).toBe(true);
  const copied = records.filter((record) => record.kind === "harness_log_copy");
  expect(copied).toHaveLength(1);
  const copy = copied[0]!;
  expect(copy).toMatchObject({ harness: "codex", path: experiment.recordingPath.replace(/\.jsonl$/, ".codex-rollout.jsonl") });
  expect(statSync(copy.path).mode & 0o777).toBe(0o600);
  expect(statSync(copy.path).size).toBe(copy.bytes);
  expect(readFileSync(copy.path, "utf8")).toContain('"call_id":"call_1"');
  await adapter.cleanupRun(context);
  expect(existsSync(privateHome)).toBe(false);
  expect(existsSync(copy.path)).toBe(true);
});

test.each(["gpt-5.5", "gpt-6-astra"])("%s keeps the experiment tools direct and records the omitted surfaces", async (model) => {
  const { context, experiment } = setup(true, model);
  await experiment.prepare("0.165.0");
  const text = readFileSync(join(context.hermeticHome!.codexHome, "config.toml"), "utf8");
  const table = ["[mcp_servers.experiment]", `url = ${JSON.stringify(experiment.relay.url)}`,
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${experiment.relay.token}`)} }`,
    "required = true", "startup_timeout_sec = 120", "tool_timeout_sec = 600",
    'omit_tools_from = ["deferred", "code_mode"]'].join("\n");
  expect(text).toContain(table);
  expect((Bun.TOML.parse(text) as any).mcp_servers.experiment.omit_tools_from).toEqual(["deferred", "code_mode"]);
  const start = JSON.parse(readFileSync(experiment.recordingPath, "utf8").split("\n")[0]!);
  expect(start).toMatchObject({ kind: "run_start", catalog_override: model === "gpt-6-astra",
    omit_tools_from: ["deferred", "code_mode"] });
});

test("a changed model-bound result fails completion and survives in the recording", async () => {
  const { adapter, context, experiment } = setup();
  await experiment.prepare("0.165.0");
  await callFixture(experiment, context);
  rollout(context, [{ type: "input_text", text: "Wall time: 0.0123 seconds\nOutput:" },
    { type: "input_text", text: "changed" }]);
  execEvents(context);
  await expect(experiment.complete()).rejects.toThrow();
  await expect(adapter.cleanupRun(context)).rejects.toThrow();
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.at(-1).error).toBeTruthy();
  expect(records.find((record) => record.kind === "harness_log_copy")).toMatchObject({ harness: "codex", bytes: expect.any(Number) });
});

test.each([true, false])("Codex cleanup copies a rollout after a prior failure: thread captured=%s", async (thread) => {
  const { adapter, context, experiment } = setup();
  await experiment.prepare("0.165.0");
  if (thread) await callFixture(experiment, context); else rollout(context);
  experiment.relay.fail(new Error("synthetic prior failure"));
  await expect(adapter.cleanupRun(context)).rejects.toThrow("synthetic prior failure");
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const copy = records.find((record) => record.kind === "harness_log_copy");
  expect(copy).toMatchObject({ harness: "codex", bytes: expect.any(Number) });
  expect(readFileSync(copy.path, "utf8")).toContain('"call_id":"call_1"');
  expect(existsSync(context.hermeticHome!.home)).toBe(false);
  expect(records.at(-1)).toMatchObject({ kind: "run_end", error: "synthetic prior failure" });
});

test("programmatic Codex experiment launches refuse no-net before preparing state", async () => {
  const { adapter, request } = setup();
  await expect(launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only",
    cwd: request.cwd, sandboxPolicyOverrides: { noNet: true } })).rejects.toThrow("--sandbox-no-net");
});

test.each(["gpt-5.5", "gpt-6-astra"])("the launcher enforces the Codex floor, delivers stdin, and verifies %s before returning an envelope", async (model) => {
  const { adapter, request, context, experiment } = setup(true, model);
  const servedModel = model === "gpt-6-astra" ? "served-model" : undefined;
  const receipt = spyOn(callLog, "appendCallRecord").mockImplementation(() => {});
  const prepare = spyOn(adapter, "prepareRun").mockReturnValue(context);
  const floor = spyOn(runtime, "assertHarnessSupported").mockImplementation(async (...args) => {
    expect(args[0]).toBe("codex");
    expect(args[7]).toBe("0.165.0");
    expect(() => experiment.relay.url).toThrow("has not started");
    return "0.165.0";
  });
  const run = spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async (_cmd, input, _cwd, _env,
    _autonomy, _options, _timeout, _omissions, sink) => {
    expect(input).toBe(request.prompt);
    const writes: string[] = [];
    let ended = false;
    sink!.start!((value) => { writes.push(value); }, () => { ended = true; }, () => {});
    expect(writes).toEqual([request.prompt]);
    expect(ended).toBe(true);
    if (experiment.relay.catalogUrl) {
      const catalog = await fetch(`${experiment.relay.catalogUrl}?client_version=0.165.0`);
      expect(catalog.status).toBe(200);
    }
    await callFixture(experiment, context);
    rollout(context);
    const stdout = execEvents(context, servedModel);
    await sink!.closeProtocol!();
    return { stdout, stderr: "", success: true, exitCode: 0 };
  });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true,
      requestedAutonomy: "read-only", cwd: request.cwd });
    expect(result).toMatchObject({ success: true });
    expect(JSON.parse(result.stdout).codemux).toMatchObject({ recording: experiment.recordingPath,
      model: servedModel ?? model });
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ model,
      model_effective: servedModel ?? null }));
    expect(existsSync(context.hermeticHome!.home)).toBe(false);
    expect(floor).toHaveBeenCalledTimes(1);
  } finally { run.mockRestore(); floor.mockRestore(); prepare.mockRestore(); receipt.mockRestore(); }
});

test("a relay failure aborts protocol capture and its listener is removed after capture", async () => {
  const { request, experiment } = setup();
  await experiment.prepare("0.165.0");
  let aborted = 0;
  let input = "";
  experiment.start((text) => { input += text; }, () => {}, () => { aborted++; });
  expect(input).toBe(request.prompt);
  experiment.relay.fail(new Error("synthetic relay failure"));
  expect(aborted).toBe(1);
  experiment.closeProtocol();
  await expect(experiment.close()).rejects.toThrow("synthetic relay failure");
  expect(aborted).toBe(1);
});

test("a code-mode model selects a custom OpenAI provider and fetches its direct catalog", async () => {
  const { adapter, request, context, experiment } = setup(true, "gpt-6-astra");
  writeFileSync(join(context.hermeticHome!.codexHome, "config.toml"),
    'model_reasoning_effort = "high"\n[features]\nmulti_agent = false\n');
  await experiment.prepare("0.165.0");
  const text = readFileSync(join(context.hermeticHome!.codexHome, "config.toml"), "utf8");
  const config = Bun.TOML.parse(text) as any;
  expect(config.model_provider).toBe("codemux-experiment");
  expect(config.model_provider).not.toBe(CODEX_PROVIDER_ID);
  expect(["openai", "amazon-bedrock", "amazon-bedrock-runtime", "gcp", "ollama", "lmstudio"])
    .not.toContain(config.model_provider);
  expect(config.model_reasoning_effort).toBe("high");
  expect(config.features).toEqual({ multi_agent: false });
  expect(Object.keys(config.model_providers)).toEqual(["codemux-experiment"]);
  const provider = config.model_providers["codemux-experiment"];
  expect(provider).toEqual({ name: "OpenAI", wire_api: "responses", http_headers: { version: "0.165.0" },
    env_http_headers: { "OpenAI-Organization": "OPENAI_ORGANIZATION", "OpenAI-Project": "OPENAI_PROJECT" },
    requires_openai_auth: true, supports_websockets: true, supports_standalone_web_search: true,
    model_catalog_url: experiment.relay.catalogUrl });
  const expectedTable = ["[model_providers.codemux-experiment]", 'name = "OpenAI"', 'wire_api = "responses"',
    'http_headers = { version = "0.165.0" }',
    'env_http_headers = { "OpenAI-Organization" = "OPENAI_ORGANIZATION", "OpenAI-Project" = "OPENAI_PROJECT" }',
    "requires_openai_auth = true", "supports_websockets = true", "supports_standalone_web_search = true",
    `model_catalog_url = ${JSON.stringify(experiment.relay.catalogUrl)}`].join("\n");
  expect(text.includes(expectedTable)).toBe(true);
  expect(Object.hasOwn(provider, "base_url")).toBe(false);
  const fetched = await fetch(`${provider.model_catalog_url}?client_version=0.165.0`);
  expect(fetched.status).toBe(200);
  expect(await fetched.json()).toEqual({ models: [
    { slug: "gpt-5.5", tool_mode: "direct" }, { slug: "gpt-6-astra" },
  ] });
  await callFixture(experiment, context);
  const stdout = execEvents(context, "served-model");
  await experiment.complete();
  const result = adapter.processRunResult({ stdout, stderr: "", success: true, exitCode: 0 }, request, context);
  expect(result.servedModel).toBe("served-model");
  expect(JSON.parse(result.stdout).codemux.model).toBe("served-model");
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records[0]).toMatchObject({ kind: "run_start", catalog_override: true });
  expect(records.find((record) => record.kind === "catalog_override")).toMatchObject({ slug: "gpt-6-astra",
    source_path: join(context.hermeticHome!.codexHome, "..", "..", "..", "models_cache.json"),
    source_fetched_at: "2026-10-29T00:00:00Z", served_models: 2, removed: ["tool_mode"] });
  expect(records.find((record) => record.kind === "catalog_served")).toMatchObject({ client_version: "0.165.0" });
});

test("a catalog override must be fetched before the first native function call", async () => {
  const { context, experiment } = setup(true, "gpt-6-astra");
  await experiment.prepare("0.165.0");
  await fetch(experiment.relay.url, { method: "POST", headers: { Authorization: `Bearer ${experiment.relay.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  rollout(context);
  let error: unknown;
  try { experiment.push(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\n"); }
  catch (failure) { error = failure; }
  expect(error ?? experiment.relay.failureError).toMatchObject({ code: "code_mode" });
  // Fetching after the call was observed cannot turn this failed run into success.
  await fetch(`${experiment.relay.catalogUrl}?client_version=0.165.0`);
  await expect(experiment.complete()).rejects.toMatchObject({ code: "code_mode" });
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.some((record) => record.kind === "harness_tool_call")).toBe(false);
});

test.each(["gpt-5.5", "gpt-6-astra"].flatMap((model) => ["0.164.0", null, undefined].map((version) => ({ model, version }))))(
  "refuses unmatched or unknown detected versions before relay startup: %j", async ({ model, version }) => {
  const { experiment } = setup(true, model);
  await expect(experiment.prepare(version)).rejects.toMatchObject({ code: "code_mode" });
  expect(() => experiment.relay.url).toThrow("has not started");
});

test.each(["config", "provider"])("requires -m even when a %s default exists, before compatibility probing", async (source) => {
  const { request } = setup();
  const home = join(request.cwd!, "operator");
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\n');
  delete request.model;
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic", ...(source === "provider" ? {
    CODEMUX_CODEX_PROVIDER_BASE_URL: "https://provider.example/v1", CODEMUX_CODEX_PROVIDER_API_KEY: "synthetic",
    CODEMUX_CODEX_PROVIDER_MODEL: "gpt-5.5",
  } : {}) }, home);
  const floor = spyOn(runtime, "assertHarnessSupported").mockImplementation(async () => { throw new Error("unexpected probe"); });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd });
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("model_required");
    expect(result.stderr).toContain("explicit --model");
    expect(floor).not.toHaveBeenCalled();
  } finally { floor.mockRestore(); }
});

test.each(["missing", "slug", "unreadable"])("refuses %s real cache before compatibility probing and names its path", async (kind) => {
  const { request } = setup();
  const home = join(request.cwd!, "isolated-operator");
  const codexHome = join(home, ".codex");
  const cachePath = join(codexHome, "models_cache.json");
  mkdirSync(codexHome, { recursive: true });
  if (kind === "slug") writeFileSync(cachePath, JSON.stringify({ client_version: "0.165.0",
    fetched_at: "2026-10-29T00:10:00Z", models: [{ slug: "other", tool_mode: "code_mode_only" }] }));
  if (kind === "unreadable") mkdirSync(cachePath);
  const adapter = new CodexAdapter({ HOME: home, CODEX_API_KEY: "synthetic" }, home);
  const floor = spyOn(runtime, "assertHarnessSupported").mockImplementation(async () => { throw new Error("unexpected probe"); });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd });
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe(kind === "slug" ? "model_unavailable" : "code_mode");
    expect(result.stderr).toContain(cachePath);
    if (kind === "slug") {
      expect(result.stderr).toContain("account's catalog");
      expect(result.stderr).toContain("2026-10-29T00:10:00Z");
      expect(result.stderr).toContain("other");
      expect(result.stderr).toContain("Codex itself");
    }
    expect(existsSync(join(codexHome, ".codemux-hermetic"))).toBe(false);
    expect(floor).not.toHaveBeenCalled();
  } finally { floor.mockRestore(); }
});

test.each(["code_mode", "code_mode_only"])("refuses a provider override with a %s catalog override before preparing state", async (mode) => {
  const { request } = setup(true, "gpt-6-astra");
  const home = join(request.cwd!, "provider-operator");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({ client_version: "0.165.0",
    models: [{ slug: request.model, tool_mode: mode }] }));
  const adapter = new CodexAdapter({ HOME: home,
    CODEMUX_CODEX_PROVIDER_BASE_URL: "https://provider.example/v1", CODEMUX_CODEX_PROVIDER_API_KEY: "synthetic",
    CODEMUX_CODEX_PROVIDER_MODEL: request.model }, home);
  for (const action of [() => adapter.validateRunRequest(request), () => adapter.prepareRun(request),
    () => adapter.buildRunCommand(request)]) {
    let failure: unknown;
    try { action(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "code_mode" });
    expect((failure as Error).message).toContain("provider override");
    expect((failure as Error).message).toContain("codemux-experiment");
  }
  const floor = spyOn(runtime, "assertHarnessSupported").mockImplementation(async () => { throw new Error("unexpected probe"); });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd });
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("code_mode");
    expect(floor).not.toHaveBeenCalled();
    expect(existsSync(join(codexHome, ".codemux-hermetic"))).toBe(false);
  } finally { floor.mockRestore(); }
});

test("a direct-mode experiment keeps the ordinary provider override", async () => {
  const { request } = setup();
  const home = join(request.cwd!, "operator");
  const adapter = new CodexAdapter({ HOME: home,
    CODEMUX_CODEX_PROVIDER_BASE_URL: "https://provider.example/v1", CODEMUX_CODEX_PROVIDER_API_KEY: "synthetic",
    CODEMUX_CODEX_PROVIDER_MODEL: request.model }, home);
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  const experiment = context.experimentCodex!;
  await experiment.prepare("0.165.0");
  const text = readFileSync(join(context.hermeticHome!.codexHome, "config.toml"), "utf8");
  const config = Bun.TOML.parse(text) as any;
  expect(config.model_provider).toBe(CODEX_PROVIDER_ID);
  expect(config.model).toBe(request.model);
  expect(Object.keys(config.model_providers)).toEqual([CODEX_PROVIDER_ID]);
  expect(config.mcp_servers.experiment.url).toBe(experiment.relay.url);
  expect(experiment.relay.catalogUrl).toBeUndefined();
  expect(text).not.toContain("codemux-experiment");
  await callFixture(experiment, context);
  execEvents(context);
  await experiment.complete();
});

test("the launch passes the detected version to catalog preflight before capture", async () => {
  const { adapter, request, context, experiment } = setup(true, "gpt-6-astra");
  const prepare = spyOn(adapter, "prepareRun").mockReturnValue(context);
  const floor = spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.166.0");
  const capture = spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => { throw new Error("unexpected capture"); });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd: request.cwd });
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("code_mode");
    expect(JSON.parse(result.stdout).codemux.recording).toBeNull();
    expect(experiment.startedRecordingPath).toBeUndefined();
    expect(result.stderr).toContain(join(request.cwd!, "operator", ".codex", "models_cache.json"));
    expect(capture).not.toHaveBeenCalled();
    expect(() => experiment.relay.url).toThrow("has not started");
  } finally { prepare.mockRestore(); floor.mockRestore(); capture.mockRestore(); }
});

test.each(["run", "check"])("%s rejects Codex experiment no-net before installation checks", async (command) => {
  const { request } = setup();
  const result = await runCli([command, "-a", "codex", "--hermetic", "--tools", "none",
    "--experiment-mcp", request.experimentMcp!, "--sandbox-no-net",
    ...(command === "run" ? ["-p", "fixture"] : [])], { PATH: minimalPath() });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--sandbox-no-net");
  expect(result.stderr).not.toContain("not installed");
});

test("Codex paired experiment check refuses before installation or a paid probe", async () => {
  const { request } = setup();
  const result = await runCli(["check", "-a", "codex", "--hermetic", "--tools", "none",
    "--experiment-mcp", request.experimentMcp!], { PATH: minimalPath() });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("supports run only");
  expect(result.stderr).not.toContain("not installed");
});

test.each([
  ["", false], ['model = "fixture"', false], ["[mcp_servers]", false],
  ['[mcp_servers.foreign]\ncommand = "server"', true],
  ['[profiles.custom.mcp_servers.foreign]\ncommand = "server"', true],
  ['mcp_servers = []', true], ['broken = [', true], ["#".repeat(1024 * 1024 + 1), true],
])("system MCP preflight bounds and validates external configuration case %#", (text, refused) => {
  const parent = resolve("scratch/session-14c66a93/exp/system-config-fixtures");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "case-"));
  const path = join(directory, "config.toml");
  expect(() => assertNoCodexSystemMcp(path)).not.toThrow();
  writeFileSync(path, text as string);
  if (refused) expect(() => assertNoCodexSystemMcp(path)).toThrow(path);
  else expect(() => assertNoCodexSystemMcp(path)).not.toThrow();
});

test("system MCP preflight refuses unreadable non-file config", () => {
  const path = resolve("scratch/session-14c66a93/exp/system-config-directory");
  mkdirSync(path, { recursive: true });
  expect(() => assertNoCodexSystemMcp(path)).toThrow(path);
});
