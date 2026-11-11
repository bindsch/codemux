import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertClineExperimentResult, clineObject, verifyClineExperimentEvidence, verifyClineToolsNoneCaptures, verifyClineWireRequest } from "../src/cline-experiment-content.js";
import { CLINE_DISABLED_NATIVE_TOOLS, assertClineToolIsolation, assertClineToolVersion, clineToolsNoneSettings } from "../src/cline-experiment-policy.js";
import { createClineExperimentPlugin, clineExperimentPluginSource, clineExperimentCaptureEnv } from "../src/cline-experiment-plugin.js";
import { ClineExperimentRun, installClineToolsNone, readClineCaptures, type ClineExperimentRelay } from "../src/cline-experiment-run.js";
import { experimentFailure, ExperimentRecording, type ExperimentRecord } from "../src/experiment-records.js";
import type { JsonObject } from "../src/experiment-server.js";
import type { ExperimentRelayCall } from "../src/experiment-relay.js";

const definition = { name: "echo", description: "  exact description  ", inputSchema: { type: "object", $schema: "https://json-schema.org/draft/2020-12/schema", properties: { value: { type: "array" } } } };
const nativeDefinition = { ...definition, name: "mcp__test__echo" };
const input = { value: "[1]" };
const result = { content: [{ type: "text", text: "  marker\n" }] };
const metrics = { inputTokens: 12, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 };
const message = { id: "native-message-1", content: [{ type: "tool-call", toolCallId: "native-call-1", toolName: nativeDefinition.name, input }], metrics };
const stdout = JSON.stringify({ type: "run_result", finishReason: "completed", text: "answer", usage: metrics }) + "\n";
const spec = { name: "test", command: "/synthetic/fixture-server", args: [], env: [] };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture() {
  const records: JsonObject[] = [];
  const calls: ExperimentRelayCall[] = [{ relay_index: 1, call_id: "native-call-1", name: "echo", input: clone(input), result: clone(result) }];
  const source = { spec, calls, toolDefinitions: [clone(definition)], record: ((kind, fields) => { records.push({ kind, fields }); }) as ExperimentRecord };
  const evidence: JsonObject[] = [
    { kind: "ready", fields: { tools: [nativeDefinition] }, t: 1 },
    { kind: "request", fields: { run_id: "run-1", iteration: 1, tools: [nativeDefinition], messages: [] }, t: 2 },
    { kind: "turn", fields: { run_id: "run-1", iteration: 1, message }, t: 3 },
    { kind: "dispatch", fields: { call_id: "native-call-1", name: nativeDefinition.name, input }, t: 4 },
    { kind: "result", fields: { call_id: "native-call-1", content: result.content }, t: 5 },
    { kind: "request", fields: { run_id: "run-1", iteration: 2, tools: [nativeDefinition], messages: [] }, t: 6 },
    { kind: "turn", fields: { run_id: "run-1", iteration: 2, message: { id: "native-message-2", content: [{ type: "text", text: "answer" }], metrics } }, t: 7 },
  ];
  const body = (results: boolean) => ({ model: "fixture", tools: [{ type: "function", function: { name: nativeDefinition.name, description: definition.description, parameters: definition.inputSchema } }],
    messages: results ? [{ role: "assistant", content: null, tool_calls: [{ type: "function", id: "native-call-1", function: { name: nativeDefinition.name, arguments: JSON.stringify(input) } }] },
      { role: "tool", tool_call_id: "native-call-1", content: result.content[0]!.text }] : [{ role: "user", content: "prompt" }] });
  const captures: JsonObject[] = [1, 2].map((iteration) => ({ captureStage: "wire_request", mode: "full", attempt: 1, timestamp: `2026-11-09T00:00:0${iteration}.000Z`,
    correlation: { runId: "run-1", iteration }, payload: { url: "https://secret:password@example.test/v1?key=private", method: "POST", body: JSON.stringify(body(iteration === 2)) } }));
  return { source, evidence: clone(evidence), captures, records, body };
}
async function rig(fn: (home: string) => unknown | Promise<unknown>) {
  const parent = join(process.cwd(), "scratch", "fix", "cline-native-fixtures"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "run-"));
  try { await fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("Cline final model-bound evidence", () => {
  test("rejects a normalized impossible calendar date in native evidence", () => {
    const f = fixture(); f.captures[0]!.timestamp = "2026-02-30T00:00:00Z";
    expect(() => verifyClineExperimentEvidence(f.source, f.evidence, f.captures, stdout)).toThrow("native request correlation");
  });
  test("omitted server descriptions match empty native descriptions throughout delivery evidence", () => {
    const f = fixture(); delete (f.source.toolDefinitions[0] as JsonObject).description;
    for (const event of f.evidence) for (const tool of event.fields.tools ?? []) tool.description = "";
    for (const capture of f.captures) {
      const body = JSON.parse(capture.payload.body); body.tools[0].function.description = "";
      capture.payload.body = JSON.stringify(body);
    }
    verifyClineExperimentEvidence(f.source, f.evidence, f.captures, stdout);
    expect(f.records.filter((r) => r.kind === "tool_result_delivered")).toHaveLength(1);
  });
  test("accepts exact definitions including whitespace/$schema, arguments and final text", () => {
    const f = fixture(); verifyClineExperimentEvidence(f.source, f.evidence, f.captures, stdout);
    expect(f.records.filter((r) => r.kind === "turn")).toHaveLength(2);
    expect(f.records.filter((r) => r.kind === "turn_usage")[0]!.fields.usage).toEqual({ input: 8, output: 2, cache_read: 3, cache_write: 1 });
    expect(f.records.filter((r) => r.kind === "tool_result_delivered")).toHaveLength(1);
    expect(clineObject({ x: 1 })).toEqual({ x: 1 });
    expect(() => clineObject([])).toThrow("object");
  });
  test("requires result delivery in a later request of the same native run", () => {
    const f = fixture(); f.captures[0]!.payload.body = JSON.stringify(f.body(true));
    expect(() => verifyClineExperimentEvidence(f.source, f.evidence, f.captures, stdout)).toThrow("follow its native call");
  });
  test.each(["extra-tool", "schema", "description", "result", "arguments", "missing-result", "duplicate-result", "unknown-call", "missing-messages", "truncated"])("rejects final wire %s", (kind) => {
    const f = fixture(), payload = clone(f.captures[1]!.payload), body = JSON.parse(payload.body);
    if (kind === "extra-tool") body.tools.push({ type: "image_generation" });
    if (kind === "schema") delete body.tools[0].function.parameters.$schema;
    if (kind === "description") body.tools[0].function.description = "exact description";
    if (kind === "result") body.messages[1].content += "...truncated";
    if (kind === "arguments") body.messages[0].tool_calls[0].function.arguments = '{"value":[1]}';
    if (kind === "missing-result") body.messages.pop();
    if (kind === "duplicate-result") body.messages.push(body.messages[1]);
    if (kind === "unknown-call") body.messages[0].tool_calls[0].id = "other";
    if (kind === "missing-messages") delete body.messages;
    if (kind === "truncated") payload.truncated = true;
    payload.body = JSON.stringify(body);
    expect(() => verifyClineWireRequest(payload, [nativeDefinition], new Map(f.source.calls.map((c) => [c.call_id!, c])), "test")).toThrow();
  });
  test.each(["ready", "request", "turn", "dispatch", "result", "wire", "terminal", "time", "usage", "unknown", "repeat-ready", "repeat-turn", "bad-id", "bad-attempt", "bad-run", "incomplete-call"])("requires complete %s evidence", (kind) => {
    const f = fixture(); let output = stdout;
    if (["ready", "request", "turn", "dispatch", "result"].includes(kind)) f.evidence = f.evidence.filter((e) => e.kind !== kind);
    if (kind === "wire") f.captures.pop();
    if (kind === "terminal") output = "";
    if (kind === "time") f.evidence[0]!.t = "bad";
    if (kind === "usage") f.evidence[2]!.fields.message.metrics.inputTokens = 0;
    if (kind === "unknown") f.evidence.push({ kind: "failure", fields: {}, t: 8 });
    if (kind === "repeat-ready") f.evidence.push(f.evidence[0]!);
    if (kind === "repeat-turn") f.evidence.push(f.evidence[2]!);
    if (kind === "bad-id") f.evidence[3]!.fields.call_id = "unknown";
    if (kind === "bad-attempt") f.captures[0]!.attempt = 0;
    if (kind === "bad-run") f.evidence[1]!.fields.run_id = "";
    if (kind === "incomplete-call") delete f.source.calls[0]!.result;
    expect(() => verifyClineExperimentEvidence(f.source, f.evidence, f.captures, output)).toThrow();
  });
  test("refuses missing inventory, changed return, repeated native IDs and native tools-none leaks", () => {
    const f = fixture(); f.source.toolDefinitions = [];
    expect(() => verifyClineExperimentEvidence(f.source, f.evidence, f.captures, stdout)).toThrow("inventory");
    for (const field of ["content", "call_id"]) {
      const g = fixture(); g.evidence[4]!.fields[field] = "bad";
      expect(() => verifyClineExperimentEvidence(g.source, g.evidence, g.captures, stdout)).toThrow();
    }
    const g = fixture(); g.evidence[2]!.fields.message.content.push(g.evidence[2]!.fields.message.content[0]);
    expect(() => verifyClineExperimentEvidence(g.source, g.evidence, g.captures, stdout)).toThrow("reused");
    expect(() => verifyClineToolsNoneCaptures([])).toThrow("wire evidence");
    expect(() => verifyClineToolsNoneCaptures(f.captures)).toThrow("definitions");
    const empty = { captureStage: "wire_request", payload: { method: "POST", body: '{"messages":[{"role":"user","content":"p"}]}' } };
    verifyClineToolsNoneCaptures([{ captureStage: "ai_sdk_prompt" }, empty]);
  });
  test.each([{}, { content: [] }, { content: [{ type: "image", data: "a" }] }, { ...result, isError: true },
    { content: [{ type: "text", text: "x", annotations: {} }] }, { ...result, structuredContent: {} }, { content: [{ type: "text", text: "\ud800" }] }] as JsonObject[])("rejects unsupported result %j", (value) => {
    expect(() => assertClineExperimentResult(value)).toThrow("one successful");
  });
  test("records obey reserved-field validation", async () => rig((home) => {
    const f = fixture(), recording = new ExperimentRecording({ ...spec, recording: join(home, "records") }, home, {});
    try { verifyClineExperimentEvidence({ ...f.source, record: recording.record }, f.evidence, f.captures, stdout); }
    finally { recording.close({ code: null, error: null }); }
    expect(readFileSync(recording.recordingPath, "utf8")).toContain("tool_result_delivered");
  }));
});

describe("Cline independent native tool policy", () => {
  test("enumerates native tools, preserves unrelated settings, and rejects malformed settings", () => {
    assertClineToolVersion("3.0.74");
    for (const version of [undefined, null, "3.0.73", "3.0.75"]) expect(() => assertClineToolVersion(version)).toThrow("verified Cline 3.0.74");
    const settings = clineToolsNoneSettings({ theme: "dark", disabledTools: ["extra"], tools: { other: true } });
    expect(settings).toMatchObject({ theme: "dark", tools: { other: true, web_search: { enabled: false } } });
    expect(settings.disabledTools).toContain("submit_and_exit"); expect(settings.disabledTools).toContain("team_finalize_outcome");
    expect((settings.disabledTools as string[]).length).toBe(CLINE_DISABLED_NATIVE_TOOLS.length + 1);
    expect(clineToolsNoneSettings().disabledTools).toHaveLength(CLINE_DISABLED_NATIVE_TOOLS.length);
    for (const value of [{ disabledTools: [1] }, { tools: [] }, { tools: null }]) expect(() => clineToolsNoneSettings(value)).toThrow("valid");
  });
  test("keeps rules but rejects project, global, agent-package and symlink tool sources", async () => rig((home) => {
    const cwd = join(home, "workspace"), configDir = join(home, "config"); mkdirSync(cwd); mkdirSync(configDir);
    const options = { cwd, home, configDir, providerId: "codemux-override" };
    writeFileSync(join(cwd, "AGENTS.md"), "ordinary rules"); assertClineToolIsolation(options);
    expect(() => assertClineToolIsolation({ ...options, providerId: "openai" })).toThrow("override");
    for (const path of [join(cwd, ".cline", "plugins"), join(configDir, "agents"), join(home, ".agents", "plugins"), join(home, "Documents", "Cline", "Plugins")]) {
      mkdirSync(path, { recursive: true }); expect(() => assertClineToolIsolation(options)).toThrow("channel"); rmSync(path, { recursive: true });
    }
    symlinkSync("/missing-target", join(configDir, "plugins")); expect(() => assertClineToolIsolation(options)).toThrow("channel");
    assertClineToolIsolation({ ...options, checkGlobal: false });
  }));
});

describe("Cline native plugin", () => {
  async function setup(overrides: { tools?: JsonObject[]; result?: JsonObject } = {}) {
    const records: JsonObject[] = [], tools: JsonObject[] = []; let disposed = false;
    const transport = { async request(method: string, params?: JsonObject) {
      if (method === "tools/list") return { tools: overrides.tools ?? [clone(definition)] };
      if (method === "tools/call") { expect(params?._meta["codemux/callId"]).toBe("native-call-1"); return overrides.result ?? clone(result); }
      return {};
    }, async notify() {}, async close() { disposed = true; } };
    const plugin = createClineExperimentPlugin({ name: "test", timeoutMs: 1000, transport, record: (kind, fields) => { records.push({ kind, fields }); } });
    let dispose: (() => Promise<void>) | undefined;
    await plugin.setup({ registerTool: (tool) => { tools.push(tool); } }, { onDispose: (fn) => { dispose = fn; } });
    return { plugin, records, tools, dispose: async () => { await dispose?.(); return disposed; } };
  }
  test("registers exact definitions, restores string arguments, returns native content and disposes", async () => {
    const h = await setup();
    expect(h.tools[0]).toMatchObject(nativeDefinition); expect(h.tools[0]!.resultPolicy).toBeUndefined();
    expect(h.plugin.hooks.beforeModel({ snapshot: { runId: "run-1", iteration: 1 }, request: { tools: [{ name: "run_commands" }], messages: [] } })).toEqual({ tools: [nativeDefinition] });
    h.plugin.hooks.afterModel({ snapshot: { runId: "run-1", iteration: 1 }, assistantMessage: clone(message) });
    expect(h.plugin.hooks.beforeTool({ toolCall: { toolCallId: "native-call-1", toolName: nativeDefinition.name }, input: { value: [1] } })).toEqual({ input });
    expect(await h.tools[0]!.execute(input, { toolCallId: "native-call-1", signal: new AbortController().signal })).toEqual(result.content);
    expect(await h.dispose()).toBe(true);
    expect(h.records.map((r) => r.kind)).toContain("result");
  });
  test("omitted MCP descriptions use the native empty-string default", async () => {
    const h = await setup({ tools: [{ name: definition.name, inputSchema: definition.inputSchema }] });
    expect(h.tools[0]!.description).toBe("");
    h.plugin.hooks.afterModel({ snapshot: { runId: "run-1", iteration: 1 }, assistantMessage: clone(message) });
    expect(await h.tools[0]!.execute(input, { toolCallId: "native-call-1" })).toEqual(result.content);
    expect(await h.dispose()).toBe(true);
  });
  test("stops native model tools, unknown calls, malformed assistant messages, and setup omissions", async () => {
    const h = await setup();
    expect(h.plugin.hooks.beforeModel({ request: { modelTools: [{ name: "image_generation" }] } })).toMatchObject({ stop: true });
    expect(h.plugin.hooks.beforeTool({ toolCall: { toolCallId: "unknown" } })).toMatchObject({ stop: true });
    expect(h.plugin.hooks.afterModel({ assistantMessage: {} })).toMatchObject({ stop: true });
    const bad = clone(message); bad.content[0]!.toolName = "run_commands";
    expect(h.plugin.hooks.afterModel({ assistantMessage: bad })).toMatchObject({ stop: true });
    const p = createClineExperimentPlugin({ name: "test", timeoutMs: 1, record() {} });
    expect(p.hooks.beforeModel({ request: {} })).toMatchObject({ stop: true });
    await expect(h.tools[0]!.execute(input, { toolCallId: "unknown" })).rejects.toThrow("unchanged native");
  });
  test("rejects unsupported definitions/results and repeated IDs", async () => {
    for (const tools of [[], [{ ...definition, description: null }], [{ ...definition, inputSchema: {} }], [{ ...definition, annotations: {} }], [definition, definition]]) {
      await expect(setup({ tools })).rejects.toThrow();
    }
    const h = await setup({ result: { content: [] } });
    const context = { snapshot: { runId: "run-1", iteration: 1 }, assistantMessage: clone(message) };
    h.plugin.hooks.afterModel(context);
    expect(h.plugin.hooks.afterModel(context)).toMatchObject({ stop: true });
    await expect(h.tools[0]!.execute(input, { toolCallId: "native-call-1" })).rejects.toThrow("one successful");
  });
  test("tools-none mode works without transport and generated plugin contains no key", async () => {
    const plugin = createClineExperimentPlugin({ timeoutMs: 1, record() {} });
    await plugin.setup({ registerTool() { throw new Error("no tools"); } }, {});
    expect(plugin.hooks.beforeModel({ snapshot: {}, request: {} })).toEqual({ tools: [] });
    const source = clineExperimentPluginSource("/private/evidence", 1000, { url: "http://127.0.0.1:1/mcp", name: "test" });
    expect(new Bun.Transpiler({ loader: "js" }).transformSync(source)).toContain("export");
    expect(source).toContain("CODEMUX_CLINE_EXPERIMENT_TOKEN");
    expect(clineExperimentCaptureEnv("/private")).toMatchObject({ CLINE_CAPTURE_PROVIDER_REQUEST: "full", CLINE_CAPTURE_WIRE: "true" });
  });
});

describe("Cline owned carrier", () => {
  function host(home: string) {
    const f = fixture(); let failure: ReturnType<typeof experimentFailure> | null = null, starts = 0, finishes = 0, closes = 0, terms = 0;
    const listeners = new Set<() => void>();
    const relay: ClineExperimentRelay = { ...f.source, token: "synthetic-token", url: "http://127.0.0.1:12345/mcp", recordingPath: join(home, "recording.jsonl"),
      get failureError() { return failure; }, async start() { starts++; }, finish() { finishes++; },
      fail(error) { failure ??= experimentFailure(error); for (const listener of listeners) listener(); },
      noteRunOutcome() {},
      onFailure(listener) { const fn = () => listener(failure!); listeners.add(fn); return () => { listeners.delete(fn); }; },
      async close() { closes++; }, closeSync() { closes++; }, terminateProtocol() { terms++; } };
    const run = new ClineExperimentRun(spec, home, home, {}, "literal prompt", relay);
    const write = () => {
      writeFileSync(run.evidencePath, f.evidence.map((event) => JSON.stringify(event) + "\n").join(""));
      f.captures.forEach((capture, i) => writeFileSync(join(run.captureDir, `${i}.provider-request.json`), JSON.stringify(capture)));
    };
    return { ...f, relay, run, write, state: () => ({ starts, finishes, closes, terms, listeners: listeners.size }) };
  }
  test("prepares once, verifies native evidence, retains redacted payloads and closes", async () => rig(async (home) => {
    const h = host(home); expect(h.run.isPrepared).toBe(false);
    await Promise.all([h.run.prepare(), h.run.prepare()]); expect(h.run.isPrepared).toBe(true); h.write();
    expect(h.state().starts).toBe(1); expect(h.run.env.CODEMUX_CLINE_EXPERIMENT_TOKEN).toBe("synthetic-token");
    expect(h.run.recordingPath).toEndWith("recording.jsonl"); expect(readFileSync(h.run.pluginPath, "utf8")).not.toContain("synthetic-token");
    let prompt = "", ended = false; h.run.start((text) => { prompt = text; }, () => { ended = true; }, () => {});
    expect([prompt, ended]).toEqual(["literal prompt", true]);
    h.run.push(stdout); expect(h.run.hasOutput).toBe(true); expect(h.run.keptBytes()).toBe(Buffer.byteLength(stdout));
    expect(h.run.finish()).toBe(stdout); h.run.push("ignored"); expect(h.run.capturedOutput).toBe(stdout);
    await Promise.all([h.run.complete(), h.run.complete()]); expect(h.state().finishes).toBe(1);
    expect(h.run.scanSurface()).toContain("marker"); expect(h.run.scanSurface()).not.toContain("password");
    const call = h.source.calls[0]!;
    expect(await h.relay.resolveCallId!(call, { params: { _meta: { "codemux/callId": "native-call-1" } } })).toBe("native-call-1");
    await expect(h.relay.resolveCallId!(call, {})).rejects.toThrow("matching native");
    await Promise.all([h.run.close(), h.run.close()]); h.run.closeSync(); expect(h.state()).toMatchObject({ closes: 2, listeners: 0 });
  }));
  test.each(["timeout", "abort", "truncated", "missing", "bad-json"])("retains failure for %s", async (kind) => rig(async (home) => {
    const h = host(home); await h.run.prepare(); h.write();
    if (kind === "timeout") h.run.terminateProtocol();
    if (kind === "abort") h.run.finish({ timedOut: false, aborted: true });
    if (kind === "truncated") writeFileSync(h.run.evidencePath, "{}");
    if (kind === "missing") rmSync(h.run.evidencePath);
    if (kind === "bad-json") writeFileSync(h.run.evidencePath, "bad\n");
    await expect(h.run.complete()).rejects.toThrow();
    let aborted = false; h.run.start(() => { throw new Error("unexpected write"); }, () => {}, () => { aborted = true; });
    expect(aborted).toBe(true); await h.run.close();
  }));
  test("handles startup failure, protocol interrupts, and relay cancellation", async () => rig(async (home) => {
    const h = host(home); h.relay.start = async () => { throw new Error("startup failed"); };
    await expect(h.run.prepare()).rejects.toThrow("startup failed"); expect(h.run.isPrepared).toBe(false); h.run.interruptBeforeEvidence();
    expect(h.state().terms).toBe(1); await h.run.close();
    const child = join(home, "child"); mkdirSync(child); const g = host(child); await g.run.prepare();
    let aborted = false; g.run.start(() => {}, () => {}, () => { aborted = true; }); g.relay.fail(new Error("server ended"));
    expect(aborted).toBe(true); await g.run.close();
  }));
  test("installs tools-none, verifies final capture, and rejects missing custom provider", async () => rig((home) => {
    expect(() => installClineToolsNone(home, "openai")).toThrow("override");
    const installed = installClineToolsNone(home, "codemux-override");
    expect(() => installed.verify()).toThrow("wire evidence");
    writeFileSync(join(installed.captureDir, "empty.provider-request.json"), JSON.stringify({ captureStage: "wire_request", payload: { method: "POST", body: '{"messages":[]}' } }));
    installed.verify(); expect(installed.env.CLINE_CAPTURE_DIR).toBe(installed.captureDir);
    expect(readClineCaptures(installed.captureDir)).toHaveLength(1);
  }));
  test("standalone generated plugin executes in a fake native CLI process", async () => rig(async (home) => {
    const h = host(home); await h.run.prepare();
    const script = `import {writeFileSync} from 'node:fs';
      const definition=${JSON.stringify(definition)}, result=${JSON.stringify(result)}, message=${JSON.stringify(message)}, captures=${JSON.stringify(h.captures)};
      globalThis.fetch=async(_url,init)=>{const frame=JSON.parse(init.body);if(frame.id===undefined)return new Response(null,{status:202});return Response.json({jsonrpc:'2.0',id:frame.id,result:frame.method==='tools/list'?{tools:[definition]}:frame.method==='tools/call'?result:{}})};
      const plugin=(await import(${JSON.stringify(pathToFileURL(h.run.pluginPath).href)})).default;const tools=[];
      await plugin.setup({registerTool:t=>tools.push(t)},{});
      const ctx=i=>({snapshot:{runId:'run-1',iteration:i},request:{tools:[],messages:[]}});
      plugin.hooks.beforeModel(ctx(1)); plugin.hooks.afterModel({...ctx(1),assistantMessage:message});
      const restored=plugin.hooks.beforeTool({toolCall:message.content[0]}); await tools[0].execute(restored.input,{toolCallId:'native-call-1'});
      plugin.hooks.beforeModel(ctx(2));plugin.hooks.afterModel({...ctx(2),assistantMessage:{id:'native-message-2',content:[{type:'text',text:'answer'}],metrics:message.metrics}});
      captures.forEach((capture,i)=>writeFileSync(${JSON.stringify(h.run.captureDir)}+'/'+i+'.provider-request.json',JSON.stringify(capture)));
      console.log(${JSON.stringify(stdout.trim())});`;
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", script], { env: { ...process.env, ...h.run.env }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    h.run.push(child.stdout.toString()); h.run.finish(); await h.run.complete(); await h.run.close();
    expect(h.records.some((record) => record.kind === "tool_result_delivered")).toBe(true);
  }));
});
