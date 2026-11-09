import { expect, test } from "bun:test";
import { CopilotExperimentEvidence, assertCopilotExperimentResult, copilotExperimentObject } from "../src/copilot-experiment-evidence.js";
import { CopilotExperimentHttp } from "../src/copilot-experiment-http.js";
import { CopilotExperimentRun, type CopilotExperimentRelay } from "../src/copilot-experiment-run.js";
import { CopilotRpcFramer, encodeCopilotRpc } from "../src/session/copilot-rpc-framing.js";
import { experimentFailure } from "../src/experiment-records.js";
import type { ExperimentRelayCall } from "../src/experiment-relay.js";
import type { JsonObject } from "../src/experiment-server.js";

const copilotExperimentId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const copilotDefinition = { name: "echo", description: "Echo exactly", inputSchema: { type: "object", required: ["text"], additionalProperties: false, properties: { text: { type: "string" } } } };
const copilotMetadata = [{ name: "native_echo", mcpServerName: "test", mcpToolName: "echo", description: copilotDefinition.description, input_schema: copilotDefinition.inputSchema }];
const copilotResult = { content: [{ type: "text", text: "literal é🙂\nbytes" }] };
const copilotInput = { text: "literal" };
const copilotSpec = { name: "test", command: "/synthetic/fake-copilot-mcp", args: [], env: [], tool_timeout_seconds: 321 };
const copilotChatResponse = JSON.stringify({ id: "native-response", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "native é🙂" } }] });
const copilotChatStream = 'data: {"id":"native-response","choices":[{"index":0,"delta":{"content":"native é🙂"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

function copilotSource() {
  const records: JsonObject[] = [], calls: ExperimentRelayCall[] = [];
  return { spec: copilotSpec, calls, toolDefinitions: [copilotDefinition], records,
    record(kind: string, fields: JsonObject) { records.push({ kind, ...fields }); } };
}
function copilotPayload(kind: "chat" | "responses" | "anthropic" = "chat", results = true): JsonObject {
  const definition = { name: "native_echo", description: copilotDefinition.description, parameters: copilotDefinition.inputSchema };
  if (kind === "responses") return { tools: [{ type: "function", ...definition }], input: results ? [{ type: "function_call", call_id: "call-1", name: "native_echo", arguments: JSON.stringify(copilotInput) }, { type: "function_call_output", call_id: "call-1", output: copilotResult.content[0]!.text }] : [] };
  if (kind === "anthropic") return { tools: [{ name: definition.name, description: definition.description, input_schema: definition.parameters }], messages: results ? [{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "native_echo", input: copilotInput }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: copilotResult.content[0]!.text }] }] : [] };
  return { tools: [{ type: "function", function: definition }], messages: results ? [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "native_echo", arguments: JSON.stringify(copilotInput) } }] }, { role: "tool", tool_call_id: "call-1", content: copilotResult.content[0]!.text }] : [] };
}
function copilotEvidence() {
  const source = copilotSource(), evidence = new CopilotExperimentEvidence(source, copilotExperimentId);
  evidence.catalog(copilotMetadata);
  const hook = evidence.hook({ sessionId: copilotExperimentId, hookType: "preMcpToolCall", input: {
    serverName: "test", toolName: "echo", toolCallId: "call-1", arguments: copilotInput, _meta: { trace: "kept" },
  } });
  source.calls.push({ relay_index: 1, call_id: "call-1", name: "echo", input: copilotInput, result: copilotResult });
  return { source, evidence, hook };
}

test("Copilot experiment joins native names and IDs to exact final provider bytes", () => {
  for (const kind of ["chat", "responses", "anthropic"] as const) {
    const f = copilotEvidence();
    expect(f.hook).toEqual({ output: { metaToUse: { trace: "kept", "codemux/callId": "call-1" } } });
    const bytes = Buffer.from(JSON.stringify(copilotPayload(kind)));
    f.evidence.commit(f.evidence.request(bytes)); f.evidence.commit(f.evidence.request(bytes)); f.evidence.complete();
    expect(f.source.records.filter((record) => record.kind === "tool_result_delivered")).toHaveLength(1);
    expect(f.source.records.find((record) => record.kind === "copilot_provider_request")?.bytes_base64).toBe(bytes.toString("base64"));
    expect(f.evidence.hook({ sessionId: copilotExperimentId, hookType: "sessionStart" })).toEqual({});
  }
});

test("Copilot experiment refuses catalog changes, unknown results and ambiguous IDs", () => {
  expect(() => copilotExperimentObject([])).toThrow("object");
  for (const result of [{ content: [] }, { content: [{ type: "image", data: "x" }] }, { ...copilotResult, extra: true }, { ...copilotResult, isError: "yes" }]) {
    expect(() => assertCopilotExperimentResult(result)).toThrow("one plain text");
  }
  for (const metadata of [null, [], [...copilotMetadata, ...copilotMetadata], [{ ...copilotMetadata[0], name: "", mcpServerName: "foreign" }], [{ ...copilotMetadata[0], input_schema: {} }]]) {
    expect(() => new CopilotExperimentEvidence(copilotSource(), copilotExperimentId).catalog(metadata)).toThrow();
  }
  const f = copilotEvidence();
  expect(() => f.evidence.catalog(copilotMetadata)).toThrow();
  expect(() => f.evidence.hook({ sessionId: "foreign" })).toThrow("different session");
  expect(() => f.evidence.hook({ sessionId: copilotExperimentId, hookType: "preMcpToolCall", input: { toolCallId: "call-1", serverName: "test", toolName: "echo" } })).toThrow("unique");
  expect(() => f.evidence.complete()).toThrow("complete provider");
  for (const mutate of [
    (p: JsonObject) => { p.tools[0].function.parameters = {}; },
    (p: JsonObject) => { p.tools = []; },
    (p: JsonObject) => { p.messages[1].content += "wrapper"; },
    (p: JsonObject) => { p.messages[1].tool_call_id = "other"; },
    (p: JsonObject) => { p.messages.push(p.messages[1]); },
  ]) {
    const payload = copilotPayload(); mutate(payload);
    expect(() => f.evidence.request(Buffer.from(JSON.stringify(payload)))).toThrow();
  }
  expect(() => f.evidence.request(Buffer.from("{}"))).toThrow("no decoder");
  const anthropic = copilotPayload("anthropic"); anthropic.messages[1].content[0].is_error = true;
  expect(() => f.evidence.request(Buffer.from(JSON.stringify(anthropic)))).toThrow("changed");
});

test("Copilot final requests cannot drop or rewrite assistant tool calls", () => {
  for (const kind of ["chat", "responses", "anthropic"] as const) for (const change of ["missing", "name", "id", "arguments"]) {
    const f = copilotEvidence(), payload = copilotPayload(kind);
    if (kind === "chat") {
      const call = payload.messages[0].tool_calls[0];
      if (change === "missing") payload.messages.shift();
      if (change === "name") call.function.name = "changed";
      if (change === "id") call.id = "changed";
      if (change === "arguments") call.function.arguments = JSON.stringify({ text: "changed" });
    } else if (kind === "responses") {
      const call = payload.input[0];
      if (change === "missing") payload.input.shift();
      if (change === "name") call.name = "changed";
      if (change === "id") call.call_id = "changed";
      if (change === "arguments") call.arguments = JSON.stringify({ text: "changed" });
    } else {
      const call = payload.messages[0].content[0];
      if (change === "missing") payload.messages.shift();
      if (change === "name") call.name = "changed";
      if (change === "id") call.id = "changed";
      if (change === "arguments") call.input = { text: "changed" };
    }
    expect(() => f.evidence.request(Buffer.from(JSON.stringify(payload)))).toThrow();
    expect(() => f.evidence.request(Buffer.from(JSON.stringify({ type: "response.create", response: payload })))).toThrow();
  }
});

function copilotHttp() {
  const f = copilotEvidence(), sent: JsonObject[] = [], requests: Request[] = [], failures: Error[] = [];
  const http = new CopilotExperimentHttp({ sessionId: copilotExperimentId, evidence: f.evidence,
    request: async (method, params) => { sent.push({ method, ...params }); return { accepted: true }; },
    fail: (error) => { failures.push(error); }, fetch: async (request) => { requests.push(request); return new Response(copilotChatStream, { headers: { "content-type": "text/event-stream" } }); } });
  const head = { requestId: "request", sessionId: copilotExperimentId, method: "POST", url: "https://synthetic.invalid/chat/completions", headers: { Authorization: ["synthetic-secret"], Host: ["drop"] } };
  return { ...f, http, head, sent, requests, failures };
}

test("Copilot inference bridge preserves Unicode bytes and streams SSE without recording credentials", async () => {
  const f = copilotHttp(); f.http.start(f.head);
  const bytes = Buffer.from(JSON.stringify(copilotPayload()));
  f.http.chunk({ requestId: "request", data: bytes.subarray(0, bytes.length - 3).toString("base64"), binary: true });
  f.http.chunk({ requestId: "request", data: bytes.subarray(bytes.length - 3).toString("base64"), binary: true, end: true });
  await f.http.complete();
  expect(await f.requests[0]!.text()).toBe(bytes.toString("utf8"));
  expect(f.requests[0]!.headers.get("authorization")).toBe("synthetic-secret");
  expect(f.requests[0]!.headers.has("host")).toBe(false);
  expect(f.sent.map((frame) => frame.method)).toEqual(["llmInference.httpResponseStart", "llmInference.httpResponseChunk", "llmInference.httpResponseChunk"]);
  expect(Buffer.from(f.sent[1]!.data, "base64").toString("utf8")).toBe(copilotChatStream);
  expect(JSON.stringify(f.source.records)).not.toContain("synthetic-secret");
  expect(f.failures).toEqual([]); f.http.close();
});

test("Copilot inference bridge rejects unsupported transport, incomplete bodies and protocol changes", async () => {
  const f = copilotHttp();
  for (const head of [{ ...f.head, sessionId: "foreign" }, { ...f.head, parentAgentId: "child" }, { ...f.head, transport: "websocket" }, { ...f.head, method: "GET" }]) expect(() => f.http.start(head)).toThrow();
  expect(() => f.http.chunk({ requestId: "missing", data: "" })).toThrow("no request");
  f.http.start(f.head); expect(() => f.http.start(f.head)).toThrow();
  expect(() => f.http.chunk({ requestId: "request", data: "???", binary: true })).toThrow("base64");
  await expect(f.http.complete()).rejects.toThrow("incomplete");
  f.http.chunk({ requestId: "request", data: "", cancel: true }); await f.http.complete();
  f.http.start(f.head);
  expect(() => f.http.chunk({ requestId: "request", data: "x".repeat(16 * 1024 * 1024 + 1) })).toThrow("16 MiB");
  f.http.close();
  const bad = copilotHttp(); bad.http.start(bad.head);
  bad.http.chunk({ requestId: "request", data: "{}", end: true }); await expect(bad.http.complete()).rejects.toThrow("no decoder");
  expect(bad.requests).toEqual([]); expect(bad.failures).toHaveLength(1);
  expect(() => bad.http.start(bad.head)).toThrow("no decoder"); bad.http.close();
});

function copilotRelay() {
  const source = copilotSource();
  let failure: ReturnType<typeof experimentFailure> | null = null, starts = 0, closes = 0, finishes = 0, terms = 0;
  const listeners = new Set<(error: Error) => void>();
  const relay: CopilotExperimentRelay = { ...source, token: "synthetic-token", url: "http://127.0.0.1:12345/mcp", recordingPath: "synthetic-recording.jsonl",
    get failureError() { return failure; }, start: async () => { starts++; }, finish: () => { finishes++; },
    fail: (error) => { failure ??= experimentFailure(error); for (const listener of listeners) listener(failure); },
    onFailure: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    terminateProtocol: () => { terms++; }, close: async () => { closes++; }, closeSync: () => { closes++; } };
  return { source, relay, state: () => ({ starts, closes, finishes, terms, listeners: listeners.size }) };
}

test.each([false, true])("Copilot experiment native RPC lifecycle binds terminal evidence (aborted=%p)", async (nativeAborted) => {
  const f = copilotRelay();
  const run = new CopilotExperimentRun(copilotSpec, "/synthetic", {}, "literal prompt", { workingDirectory: "/synthetic" }, f.relay,
    async () => new Response(copilotChatResponse));
  let ended = false, aborted = false, requestId = 1000;
  const replies = new Map<number, (value: JsonObject) => void>(), writes: JsonObject[] = [];
  const feed = (message: JsonObject) => run.push(Buffer.from(encodeCopilotRpc({ jsonrpc: "2.0", ...message })).toString("utf8"));
  const call = (method: string, params: JsonObject) => new Promise<JsonObject>((resolve) => {
    const id = requestId++; replies.set(id, resolve); feed({ id, method, params });
  });
  const event = (type: string, data: JsonObject = {}) => feed({ method: "session.event", params: { sessionId: run.sessionId, event: { type, data } } });
  let requestWork: Promise<void> | undefined;
  await run.prepare(); await expect(run.prepare()).rejects.toThrow("already");
  run.start((text) => {
    const message = new CopilotRpcFramer().push(Buffer.from(text))[0] as JsonObject; writes.push(message);
    if (!message.method) { replies.get(message.id)!(message.result); replies.delete(message.id); return; }
    const result = message.method === "session.create" ? { sessionId: run.sessionId }
      : message.method === "session.tools.getCurrentMetadata" ? { tools: copilotMetadata }
      : message.method === "session.usage.getMetrics" ? { modelMetrics: { model: { usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 } } } }
      : message.method.startsWith("llmInference.httpResponse") ? { accepted: true } : { success: true };
    queueMicrotask(() => feed({ id: message.id, result }));
    if (message.method === "session.send") requestWork = (async () => {
      expect(message.params.prompt).toBe("literal prompt");
      const hook = await call("hooks.invoke", { sessionId: run.sessionId, hookType: "preMcpToolCall", input: { serverName: "test", toolName: "echo", toolCallId: "call-1", arguments: copilotInput } });
      const id = await f.relay.resolveCallId!({ relay_index: 1, name: "echo", input: copilotInput }, { params: { _meta: hook.output.metaToUse } });
      f.source.calls.push({ relay_index: 1, call_id: id, name: "echo", input: copilotInput, result: copilotResult });
      await call("llmInference.httpRequestStart", { requestId: "model", sessionId: run.sessionId, method: "POST", url: "https://synthetic.invalid/model", headers: {} });
      await call("llmInference.httpRequestChunk", { requestId: "model", data: JSON.stringify(copilotPayload()), end: true });
    })();
    if (message.method === "llmInference.httpResponseChunk" && message.params.end) queueMicrotask(() => {
      event("assistant.message", { content: "complete", model: "metadata-only" }); event("session.idle", { aborted: nativeAborted });
    });
  }, () => { ended = true; }, () => { aborted = true; });
  for (let i = 0; i < 100 && !ended && !aborted; i++) await Bun.sleep(1);
  await requestWork;
  if (nativeAborted) {
    expect([ended, aborted]).toEqual([false, true]); expect(run.usage).toBeUndefined(); run.finish();
    await expect(run.complete()).rejects.toThrow("aborted"); await run.close(); return;
  }
  expect([ended, aborted]).toEqual([true, false]);
  expect(run.usage).toMatchObject({ input_tokens: 5, output_tokens: 3, cached_input_tokens: 2, total_tokens: 10 });
  expect(writes.find((write) => write.method === "session.create")?.params).toMatchObject({ hooks: true, availableTools: ["mcp:*"], enableConfigDiscovery: false });
  expect(writes.find((write) => write.method === "session.create")?.params.mcpServers.test.timeout).toBe(321000);
  expect(run.finish()).toContain("complete"); expect(run.keptBytes()).toBeGreaterThan(0);
  expect(run.capturedOutput).toContain(run.sessionId); expect(run.recordingPath).toBe("synthetic-recording.jsonl");
  await run.complete(); await run.close(); run.closeSync();
  expect(f.state()).toMatchObject({ starts: 1, closes: 2, finishes: 1, listeners: 0 });
  await expect(f.relay.resolveCallId!({ relay_index: 1, name: "echo", input: {} }, {})).rejects.toThrow("native hook");
});

test.each([true, false])("Copilot canceled delivery cannot satisfy a retry lacking the result (retry carries result=%p)", async (retryCarriesResult) => {
  const f = copilotEvidence(), failures: Error[] = [];
  let fetches = 0;
  const http = new CopilotExperimentHttp({ sessionId: copilotExperimentId, evidence: f.evidence,
    request: async () => ({ accepted: true }), fail: (error) => { failures.push(error); },
    fetch: async (request) => {
      fetches++;
      if (fetches > 1) return new Response(copilotChatResponse);
      return await new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("canceled", "AbortError")), { once: true }));
    } });
  const head = { requestId: "retry", sessionId: copilotExperimentId, method: "POST", url: "https://synthetic.invalid/model", headers: {} };
  http.start(head); http.chunk({ requestId: "retry", data: JSON.stringify(copilotPayload()), end: true });
  http.chunk({ requestId: "retry", data: "", cancel: true });
  http.start(head); http.chunk({ requestId: "retry", data: JSON.stringify(copilotPayload("chat", retryCarriesResult)) });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  http.chunk({ requestId: "retry", data: "", end: true });
  await http.complete(); expect(fetches).toBe(2); expect(failures).toEqual([]);
  if (retryCarriesResult) f.evidence.complete(); else expect(() => f.evidence.complete()).toThrow("complete provider");
  http.close();
});

test("Copilot provider proof retains call-before-result order and Anthropic roles", () => {
  for (const kind of ["chat", "responses", "anthropic"] as const) {
    const f = copilotEvidence(), payload = copilotPayload(kind);
    (payload.input ?? payload.messages).reverse();
    expect(() => f.evidence.request(Buffer.from(JSON.stringify(payload)))).toThrow();
  }
  for (const role of [undefined, "assistant", "system"]) {
    const f = copilotEvidence(), payload = copilotPayload("anthropic");
    payload.messages[1].role = role;
    expect(() => f.evidence.request(Buffer.from(JSON.stringify(payload)))).toThrow("wrong role");
  }
});

test.each(["start", "body"])("Copilot canceled HTTP %s acknowledgment cannot send frames to a reused request ID", async (heldFrame) => {
  const f = copilotEvidence(), sent: JsonObject[] = [], failures: Error[] = [];
  let release!: () => void, blocked!: () => void, held = false;
  const acknowledgment = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { blocked = resolve; });
  const http = new CopilotExperimentHttp({ sessionId: copilotExperimentId, evidence: f.evidence,
    request: async (method, params) => {
      sent.push({ method, ...params });
      if (!held && (heldFrame === "start" ? method.endsWith("Start") : Boolean(params.data))) {
        held = true; blocked(); await acknowledgment;
      }
      return { accepted: true };
    }, fail: (error) => { failures.push(error); }, fetch: async () => new Response(copilotChatResponse) });
  const head = { requestId: "reused", sessionId: copilotExperimentId, method: "POST", url: "https://synthetic.invalid/model", headers: {} };
  http.start(head); http.chunk({ requestId: "reused", data: JSON.stringify(copilotPayload()), end: true });
  await reached;
  http.chunk({ requestId: "reused", cancel: true }); http.start(head);
  const sentBeforeRelease = sent.length; release();
  await expect(http.complete()).rejects.toThrow("incomplete");
  expect(sent).toHaveLength(sentBeforeRelease); expect(failures).toEqual([]);
  expect(f.source.records.filter((record) => record.kind === "tool_result_delivered")).toHaveLength(0);
  http.chunk({ requestId: "reused", data: JSON.stringify(copilotPayload()), end: true });
  await http.complete(); f.evidence.complete(); expect(failures).toEqual([]); http.close();
});

test.each(["chat", "responses", "anthropic"] as const)("Copilot HTTP200 %s API error cannot satisfy delivery through a catalog-only retry", async (kind) => {
  const f = copilotEvidence(), failures: Error[] = [];
  let responses = 0;
  const success = kind === "chat" ? JSON.parse(copilotChatResponse) : kind === "responses"
    ? { id: "response", status: "completed", output: [] } : { id: "response", type: "message", stop_reason: "end_turn", content: [] };
  const http = new CopilotExperimentHttp({ sessionId: copilotExperimentId, evidence: f.evidence,
    request: async () => ({ accepted: true }), fail: (error) => { failures.push(error); }, fetch: async () => {
      responses++; return new Response(responses === 1 ? 'event: error\ndata: {"type":"error","error":{"message":"failed"}}\n\n' : JSON.stringify(success));
    } });
  for (const hasResult of [true, false]) {
    http.start({ requestId: "retry", sessionId: copilotExperimentId, method: "POST", url: "https://synthetic.invalid/model", headers: {} });
    http.chunk({ requestId: "retry", data: JSON.stringify(copilotPayload(kind, hasResult)), end: true }); await http.complete();
  }
  expect(failures).toEqual([]); expect(() => f.evidence.complete()).toThrow("complete provider");
  expect(f.source.records.filter((record) => record.kind === "tool_result_delivered")).toHaveLength(0); http.close();
});

test("Copilot experiment refuses missing lifecycle evidence and records transport failures", async () => {
  const f = copilotRelay(), run = new CopilotExperimentRun(copilotSpec, "/synthetic", {}, "prompt", { workingDirectory: "/synthetic" }, f.relay);
  expect(() => run.start(() => {}, () => {}, () => {})).toThrow("prepared");
  await run.prepare();
  let aborted = false;
  run.start(() => {}, () => {}, () => { aborted = true; });
  run.push("bad framing\r\n\r\n");
  expect(aborted).toBe(true);
  run.terminateProtocol(); run.finish({ timedOut: false, aborted: true });
  await expect(run.complete()).rejects.toThrow();
  run.closeSync(); expect(f.state().terms).toBe(1);
});
