import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";
import { parseClineResultEnvelope } from "./result-envelope/cline.js";
import { timestampMs, timestampValid } from "./calendar.js";

// Cline cli-v3.0.74, inspected 2026-11-09: native calls and final content projection.
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/agent.ts#L54-L130
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/llms/ai-sdk-format.ts#L544-L577
export function clineObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ExperimentFailure(Code.Protocol, "Cline evidence requires an object");
  return value as JsonObject;
}
export function clineExperimentToolName(server: string, name: string): string { return `mcp__${server}__${name}`; }

export function assertClineExperimentResult(result: JsonObject): void {
  const block = result.content?.[0];
  if ((result.isError !== undefined && result.isError !== false) || Object.keys(result).some((key) => !["content", "isError"].includes(key)) ||
      !Array.isArray(result.content) || result.content.length !== 1 || !block || block.type !== "text" || typeof block.text !== "string" ||
      Object.keys(block).some((key) => !["type", "text"].includes(key)) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(block.text)) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Cline experiment requires one successful unannotated text result");
  }
}

function nativeDefinitions(name: string, tools: readonly JsonObject[]): JsonObject[] {
  return tools.map((tool) => ({ ...tool, name: clineExperimentToolName(name, tool.name), description: tool.description ?? "" }));
}

/** The custom provider uses OpenAI Chat Completions. Verify the actual body
 * after Cline's message builder and the AI SDK provider's conversion. */
export function verifyClineWireRequest(payload: unknown, definitions: readonly JsonObject[], calls: ReadonlyMap<string, ExperimentRelayCall>, serverName?: string): string[] {
  const capture = clineObject(payload);
  if (capture.truncated || capture.method !== "POST" || typeof capture.body !== "string") throw new ExperimentFailure(Code.HarnessLogMissing, "Cline lacks a complete native wire request");
  const body = clineObject(JSON.parse(capture.body));
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) => tool?.type !== "function" || !tool.function)) throw new ExperimentFailure(Code.InventoryMismatch, "Cline advertised a native non-function tool");
  const actual = tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters }));
  if (!isDeepStrictEqual(actual, definitions)) throw new ExperimentFailure(Code.InventoryMismatch, "Cline final model-bound definitions changed");
  if (!Array.isArray(body.messages)) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline wire request has no messages");
  const present = new Set<string>(), delivered = new Set<string>();
  for (const message of body.messages) {
    if (message?.role === "assistant") for (const tool of message.tool_calls ?? []) {
      const call = calls.get(tool.id);
      if (!call || !serverName || tool.type !== "function" || tool.function?.name !== clineExperimentToolName(serverName, call.name) ||
          typeof tool.function.arguments !== "string" || !isDeepStrictEqual(JSON.parse(tool.function.arguments), call.input) || present.has(tool.id)) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Cline model-bound call identity or arguments changed");
      }
      present.add(tool.id);
    }
    if (message?.role === "tool") {
      const call = calls.get(message.tool_call_id);
      if (!call?.result || !present.has(message.tool_call_id) || delivered.has(message.tool_call_id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Cline model-bound result lacks a unique native call");
      assertClineExperimentResult(call.result);
      if (message.content !== call.result.content[0].text) throw new ExperimentFailure(Code.ResultChanged, "Cline final model-bound result changed or was truncated");
      delivered.add(message.tool_call_id);
    }
  }
  if (present.size !== delivered.size) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline wire request lacks a result for an included tool call");
  return [...delivered];
}

type Source = { spec: { name: string }; calls: readonly ExperimentRelayCall[]; toolDefinitions: readonly JsonObject[] | undefined; record: ExperimentRecord };

/** Require native hook events and final wire evidence independently. Cline
 * deliberately ignores hook/capture failures, so neither is optional here. */
export function verifyClineExperimentEvidence(source: Source, evidence: JsonObject[], captures: JsonObject[], stdout: string): void {
  if (!source.toolDefinitions?.length) throw new ExperimentFailure(Code.InventoryMismatch, "Cline experiment lacks its server inventory");
  const definitions = nativeDefinitions(source.spec.name, source.toolDefinitions);
  const calls = new Map<string, ExperimentRelayCall>();
  for (const call of source.calls) {
    if (!call.call_id || calls.has(call.call_id) || !call.result) throw new ExperimentFailure(Code.CallIdUnresolved, "Cline relay calls are incomplete or repeated");
    calls.set(call.call_id, call);
  }
  const requests = new Set<string>(), turns = new Set<string>(), messages = new Set<string>();
  const native = new Set<string>(), dispatched = new Set<string>(), returned = new Set<string>();
  const origins = new Map<string, { run: string; iteration: number }>();
  let ready = false;
  const key = (fields: JsonObject) => {
    if (typeof fields.run_id !== "string" || !fields.run_id || !Number.isSafeInteger(fields.iteration) || fields.iteration < 1) throw new ExperimentFailure(Code.Protocol, "Cline evidence lacks native run/iteration correlation");
    return `${fields.run_id}:${fields.iteration}`;
  };
  const match = (id: unknown, name: unknown, input: unknown) => {
    const call = typeof id === "string" ? calls.get(id) : undefined;
    if (!call || name !== clineExperimentToolName(source.spec.name, call.name) || !isDeepStrictEqual(input, call.input)) throw new ExperimentFailure(Code.CallIdUnresolved, "Cline native call differs from relay arguments");
    return call;
  };
  for (const event of evidence) {
    const fields = clineObject(event.fields);
    if (!Number.isFinite(event.t)) throw new ExperimentFailure(Code.Protocol, "Cline evidence lacks a timestamp");
    source.record("cline_plugin_evidence", { event_kind: event.kind, evidence: fields, t: event.t });
    switch (event.kind) {
      case "ready":
        if (ready || !isDeepStrictEqual(fields.tools, definitions)) throw new ExperimentFailure(Code.InventoryMismatch, "Cline plugin registered a different inventory");
        ready = true; break;
      case "request": {
        const id = key(fields);
        if (!ready || requests.has(id) || !isDeepStrictEqual(fields.tools, definitions)) throw new ExperimentFailure(Code.InventoryMismatch, "Cline native request has an invalid inventory or identity");
        requests.add(id); break;
      }
      case "turn": {
        const id = key(fields), message = clineObject(fields.message), metrics = clineObject(message.metrics);
        if (!requests.has(id) || turns.has(id) || typeof message.id !== "string" || !message.id || messages.has(message.id) || !Array.isArray(message.content)) throw new ExperimentFailure(Code.MessageIdMissing, "Cline native turn is missing or repeated");
        const counts = [metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens, metrics.cacheWriteTokens];
        if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || counts[0] < counts[2] + counts[3]) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline native turn lacks consistent token counts");
        const usage = { input: counts[0] - counts[2] - counts[3], output: counts[1], cache_read: counts[2], cache_write: counts[3] };
        turns.add(id); messages.add(message.id);
        source.record("turn", { message_id: message.id, usage, tool_calls: [], t: event.t });
        source.record("turn_usage", { message_id: message.id, usage, t: event.t });
        for (const part of message.content) if (part.type === "tool-call") {
          const call = match(part.toolCallId, part.toolName, part.input);
          if (native.has(part.toolCallId)) throw new ExperimentFailure(Code.CallIdUnresolved, "Cline reused a native call ID");
          native.add(part.toolCallId);
          origins.set(part.toolCallId, { run: fields.run_id, iteration: fields.iteration });
          source.record("turn_call", { message_id: message.id, call_id: part.toolCallId, name: call.name, t: event.t });
        }
        break;
      }
      case "dispatch":
        match(fields.call_id, fields.name, fields.input);
        if (!native.has(fields.call_id) || dispatched.has(fields.call_id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Cline dispatch lacks a unique preceding native call");
        dispatched.add(fields.call_id); break;
      case "result":
        if (!dispatched.has(fields.call_id) || returned.has(fields.call_id) || !isDeepStrictEqual(fields.content, calls.get(fields.call_id)?.result?.content)) throw new ExperimentFailure(Code.ResultChanged, "Cline plugin returned a changed or repeated result");
        returned.add(fields.call_id); break;
      default: throw new ExperimentFailure(Code.Protocol, "Cline plugin failed or emitted unknown evidence");
    }
  }
  const wired = new Set<string>(), delivered = new Set<string>(), attempts = new Set<string>();
  for (const capture of captures) {
    if (capture.captureStage !== "wire_request") continue;
    const correlation = clineObject(capture.correlation), id = key({ run_id: correlation.runId, iteration: correlation.iteration });
    const attempt = `${id}:${capture.attempt}`;
    if (!requests.has(id) || capture.mode !== "full" || !Number.isSafeInteger(capture.attempt) || capture.attempt < 1 || attempts.has(attempt) || typeof capture.timestamp !== "string" || !timestampValid(capture.timestamp)) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline wire capture lacks native request correlation");
    attempts.add(attempt); wired.add(id);
    for (const callId of verifyClineWireRequest(capture.payload, definitions, calls, source.spec.name)) {
      const origin = origins.get(callId);
      if (!origin || origin.run !== correlation.runId || origin.iteration >= correlation.iteration) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline result delivery must follow its native call in the same run");
      if (!delivered.has(callId)) source.record("tool_result_delivered", { call_id: callId, t: timestampMs(capture.timestamp) / 1000 });
      delivered.add(callId);
    }
    source.record("tool_inventory", { tools: definitions.map((tool) => tool.name), equal: true });
  }
  if (!ready || !requests.size || requests.size !== turns.size || requests.size !== wired.size ||
      [native, dispatched, returned, delivered].some((set) => set.size !== calls.size) || parseClineResultEnvelope(stdout)?.finishReason !== "completed") {
    throw new ExperimentFailure(Code.HarnessLogMissing, "Cline experiment lacks complete native turns, calls, final wire delivery, or terminal evidence");
  }
}

/** Reusable tools-none verification for run and ACP: at least one actual
 * provider request must carry no function or native tools and no tool calls. */
export function verifyClineToolsNoneCaptures(captures: JsonObject[]): void {
  let count = 0;
  for (const capture of captures) if (capture.captureStage === "wire_request") {
    verifyClineWireRequest(capture.payload, [], new Map()); count++;
  }
  if (!count) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline tools-none lacks final native wire evidence");
}
