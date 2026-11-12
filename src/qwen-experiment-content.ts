import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";
import { timestampMs, timestampValid } from "./calendar.js";
import { recordVerifiedDeliveries } from "./experiment-delivery-records.js";

const MAX_NATIVE_TOOL_NAME = 63;
const MCP_TEXT_LIMIT = 500_000;
const MAIN_PROMPT_DELIMITER = "########";

/** Qwen Code 0.24.0, installed bundle read 2026-11-09:
 * chunk-WZAD4ZNJ.js:12-48 normalizes names and hashes changed/long names.
 * The shared inventory allows 64 characters; Qwen's bound is 63. */
export function qwenExperimentToolName(server: string, name: string): string {
  const original = `mcp__${server}__${name}`;
  if (original.length <= MAX_NATIVE_TOOL_NAME && /^[A-Za-z][A-Za-z0-9_-]*$/.test(original)) return original;
  const normalized = original.replace(/[^A-Za-z0-9_-]/g, "_");
  let hash = 2166136261;
  for (let index = 0; index < original.length; index++) hash = Math.imul(hash ^ original.charCodeAt(index), 16777619);
  const suffix = `_${(hash >>> 0).toString(36).padStart(7, "0")}`;
  return normalized.slice(0, MAX_NATIVE_TOOL_NAME - suffix.length) + suffix;
}

function object(value: unknown, code = Code.HarnessLogMissing): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperimentFailure(code, "Qwen evidence requires an object");
  return value as JsonObject;
}

/** Native MCP transforms (chunk-G3PBYAGM.js:6210-6268,6498-6589) add
 * error/media/structured-content text and truncate each text over 500k chars.
 * Accept only the unchanged single-text subset, including empty text.
 * Metadata is refused because native transformTextBlock drops it. */
export function assertQwenExperimentResult(value: unknown): asserts value is JsonObject {
  const result = object(value, Code.UnsupportedResult);
  if (Object.keys(result).some((key) => !["content", "isError"].includes(key)) ||
      (result.isError !== undefined && result.isError !== false) ||
      !Array.isArray(result.content) || result.content.length !== 1) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Qwen preserves only a successful single text result without metadata or structuredContent");
  }
  const block = object(result.content[0], Code.UnsupportedResult);
  if (Object.keys(block).some((key) => key !== "type" && key !== "text") || block.type !== "text" ||
      typeof block.text !== "string" || block.text.length > MCP_TEXT_LIMIT) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Qwen requires an unannotated text block of at most 500000 characters");
  }
}

export interface QwenExperimentEvidenceSource {
  spec: { name: string };
  calls: readonly ExperimentRelayCall[];
  toolDefinitions: readonly JsonObject[] | undefined;
  record: ExperimentRecord;
}

function definitions(source: QwenExperimentEvidenceSource): JsonObject[] {
  if (!source.toolDefinitions?.length) throw new ExperimentFailure(Code.InventoryMismatch, "Qwen experiment has no server inventory");
  const names = new Set<string>();
  return source.toolDefinitions.map((tool) => {
    if (typeof tool.name !== "string" || (tool.description !== undefined && typeof tool.description !== "string")) {
      throw new ExperimentFailure(Code.InventoryMismatch, "Qwen server inventory has invalid metadata");
    }
    const name = qwenExperimentToolName(source.spec.name, tool.name);
    if (names.has(name)) throw new ExperimentFailure(Code.InventoryMismatch, "Qwen server inventory repeats a normalized name");
    names.add(name);
    return { type: "function", function: { name, description: tool.description ?? "",
      parameters: object(tool.inputSchema, Code.InventoryMismatch) } };
  }).sort((left, right) => left.function.name.localeCompare(right.function.name));
}

function requireInventory(actual: unknown, expected: JsonObject[]): void {
  if (!Array.isArray(actual) || !isDeepStrictEqual([...actual].sort((left, right) =>
    String(left?.function?.name).localeCompare(String(right?.function?.name))), expected)) {
    // Qwen's unconditional relaxSchemaForFunctionCalling removes keywords
    // (chunk-CF5KXZZX.js:91-139); parameterless schemas may disappear
    // (chunk-2FQM443D.js:312-367). Never reproduce or silently accept this.
    throw new ExperimentFailure(Code.InventoryMismatch, "Qwen model-bound inventory or original input schema changed");
  }
}

function relayCalls(source: QwenExperimentEvidenceSource): Map<string, ExperimentRelayCall> {
  const calls = new Map<string, ExperimentRelayCall>();
  for (const call of source.calls) {
    if (!call.call_id || calls.has(call.call_id) || !call.result) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen relay call is incomplete or repeats its native ID");
    }
    if (!source.toolDefinitions!.some((tool) => tool.name === call.name)) {
      throw new ExperimentFailure(Code.UnknownTool, "Qwen relay call names an unknown tool");
    }
    assertQwenExperimentResult(call.result);
    calls.set(call.call_id, call);
  }
  return calls;
}

function matchCall(source: QwenExperimentEvidenceSource, calls: Map<string, ExperimentRelayCall>, id: unknown,
  name: unknown, input: unknown): string {
  const call = typeof id === "string" ? calls.get(id) : undefined;
  if (!call || name !== qwenExperimentToolName(source.spec.name, call.name) || !isDeepStrictEqual(input, call.input)) {
    throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen native tool call identity, name, or arguments differ from the relay");
  }
  return call.call_id!;
}

function serializedCall(source: QwenExperimentEvidenceSource, calls: Map<string, ExperimentRelayCall>, value: unknown): string {
  const call = object(value, Code.CallIdUnresolved);
  const fn = object(call.function, Code.CallIdUnresolved);
  if (call.type !== "function" || typeof fn.arguments !== "string") {
    throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen provider call requires serialized JSON arguments");
  }
  let input: unknown;
  try { input = JSON.parse(fn.arguments); }
  catch { throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen provider call arguments contain invalid JSON"); }
  return matchCall(source, calls, call.id, fn.name, input);
}

/** Complete stream-json assistant frames expose callId before tool dispatch
 * (chunk-6XRR4RYH.js:652-674). The host can tail a partial final line. */
export function qwenExperimentCalls(stdout: string): { id: string; name: string; input: unknown }[] {
  const calls: { id: string; name: string; input: unknown }[] = [];
  const ids = new Set<string>();
  for (const line of stdout.slice(0, stdout.lastIndexOf("\n") + 1).split("\n").filter((entry) => entry.trim())) {
    let event: JsonObject;
    try { event = object(JSON.parse(line)); }
    catch { throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native stdout contains invalid JSON"); }
    if (event.type !== "assistant") continue;
    if (event.message?.role !== "assistant" || !Array.isArray(event.message.content)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen assistant frame has invalid content");
    }
    for (const block of event.message.content) {
      if (block?.type !== "tool_use") continue;
      if (event.parent_tool_use_id != null || typeof block.id !== "string" || !block.id ||
          typeof block.name !== "string" || !block.name || !Object.hasOwn(block, "input") || ids.has(block.id)) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen assistant call has a missing or repeated native identity");
      }
      ids.add(block.id);
      calls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return calls;
}

function stdoutEvidence(source: QwenExperimentEvidenceSource, calls: Map<string, ExperimentRelayCall>, stdout: string): string {
  if (!stdout.endsWith("\n")) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native stdout is truncated");
  let session: string | undefined, ended = false;
  const declared = new Set<string>(), completed = new Set<string>();
  for (const line of stdout.split("\n").filter((entry) => entry.trim())) {
    let event: JsonObject;
    try { event = object(JSON.parse(line)); }
    catch { throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native stdout contains invalid JSON"); }
    if (ended) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen emitted events after its terminal result");
    if (typeof event.session_id !== "string" || !event.session_id || (session && event.session_id !== session)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native session identity is missing or changed");
    }
    session = event.session_id;
    if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) {
      throw new ExperimentFailure(Code.UnknownTool, "Qwen emitted unexpected subagent evidence");
    }
    if (event.type === "assistant" || event.type === "user") {
      const message = object(event.message);
      if (message.role !== event.type) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native message role changed");
      if (event.type === "user" && typeof message.content === "string") continue;
      if (!Array.isArray(message.content)) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native message content is missing");
      for (const value of message.content) {
        const block = object(value);
        if (block.type === "tool_use") {
          if (event.type !== "assistant") throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen tool use has the wrong role");
          const id = matchCall(source, calls, block.id, block.name, block.input);
          if (declared.has(id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen stdout repeats a native call");
          declared.add(id);
        } else if (block.type === "tool_result") {
          if (event.type !== "user" || !declared.has(block.tool_use_id) || completed.has(block.tool_use_id) || block.is_error !== false) {
            throw new ExperimentFailure(Code.ResultChanged, "Qwen native result failed, repeated, or lacks its call");
          }
          // BaseJsonOutputAdapter chooses display text and truncates at 64 KiB
          // (chunk-6XRR4RYH.js:37-46,752-788,1014-1057). It proves completion,
          // never the bytes delivered to the model.
          completed.add(block.tool_use_id);
        } else if (block.type !== "text" && block.type !== "thinking") {
          throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen emitted an unsupported native content block");
        }
      }
    } else if (event.type === "result") {
      if (event.subtype !== "success" || event.is_error !== false || (event.permission_denials?.length ?? 0) > 0) {
        throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen native run did not succeed");
      }
      ended = true;
    } else if (!["system", "stream_event"].includes(event.type)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen emitted an unsupported native event");
    }
  }
  if (!session || !ended || declared.size !== calls.size || completed.size !== calls.size) {
    throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen lacks complete native calls, results, or terminal evidence");
  }
  return session;
}

function assistantCalls(source: QwenExperimentEvidenceSource, calls: Map<string, ExperimentRelayCall>, message: JsonObject): string[] {
  if (message.function_call !== undefined) throw new ExperimentFailure(Code.UnknownTool, "Qwen provider emitted an unsupported legacy function call");
  if (message.tool_calls === undefined) return [];
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
    throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen provider assistant tool calls have an invalid role or shape");
  }
  return message.tool_calls.map((call: unknown) => serializedCall(source, calls, call));
}

function requestResults(source: QwenExperimentEvidenceSource, calls: Map<string, ExperimentRelayCall>, messages: JsonObject[]): string[] {
  const declared = new Set<string>(), results: string[] = [];
  for (const value of messages) {
    const message = object(value);
    if (!["system", "user", "assistant", "tool"].includes(message.role) || message.function_call !== undefined) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen provider request contains an unsupported message role or legacy function call");
    }
    for (const id of assistantCalls(source, calls, message)) {
      if (declared.has(id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen provider request repeats a call ID");
      declared.add(id);
    }
    if (message.role === "tool" || message.tool_call_id !== undefined) {
      const call = calls.get(message.tool_call_id);
      if (message.role !== "tool" || !call || !declared.has(message.tool_call_id) || results.includes(message.tool_call_id)) {
        throw new ExperimentFailure(Code.ResultChanged, "Qwen provider result lacks a unique preceding call or tool role");
      }
      const text = call.result!.content[0].text;
      // Single text -> functionResponse.output (SNPYTKXI:68921-68973) ->
      // one OpenAI text part, or string mode; empty text becomes ""
      // (2FQM443D:565-571,648-678). Preserve every character.
      const content = text === "" ? "" : [{ type: "text", text }];
      if (!isDeepStrictEqual(message.content, content) && message.content !== text) {
        throw new ExperimentFailure(Code.ResultChanged, "Qwen model-bound tool result text changed");
      }
      results.push(message.tool_call_id);
    }
  }
  if (declared.size !== results.length) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen provider request contains a call without its result");
  return results;
}

/** Native --openai-logging evidence, Qwen Code 0.24.0, read 2026-11-09.
 * chunk-XMAIUTED.js:1643-1648 sets stream; :1915 captures the final built
 * OpenAI request immediately before execution. LoggingContentGenerator
 * (loggingContentGenerator-DEOANG3F.js:961-970) uses that capture. Its
 * non-OpenAI fallback (:1170-1210) omits stream, so require stream:true.
 * The logger writes {timestamp,request,response,error,context} unchanged
 * (chunk-JFEWKEKG.js:211-241). A successful exhausted stream writes the
 * consolidated response (:1080-1113); response conversion is
 * chunk-2FQM443D.js:383-453. No HTTP interception or auth override is used. */
export function verifyQwenExperimentEvidence(source: QwenExperimentEvidenceSource, records: JsonObject[], stdout: string): void {
  const expected = definitions(source);
  const calls = relayCalls(source);
  const session = stdoutEvidence(source, calls, stdout);
  const produced = new Set<string>(), delivered = new Set<string>(), responses = new Set<string>();
  const deliveries: { id: string; t: number }[] = [];
  let mainRequests = 0;
  for (const value of records) {
    const log = object(value), request = object(log.request), response = object(log.response);
    const context = object(log.context);
    const t = typeof log.timestamp === "string" && timestampValid(log.timestamp) ? timestampMs(log.timestamp) / 1000 : NaN;
    if (!Number.isFinite(t) || log.error !== null || typeof request.stream !== "boolean" || typeof request.model !== "string" || !request.model ||
        !Array.isArray(request.messages) || !Array.isArray(response.choices) || response.choices.length !== 1 ||
        typeof response.id !== "string" || !response.id || responses.has(response.id)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen log lacks a unique successful captured streaming request");
    }
    responses.add(response.id);
    const choice = object(response.choices[0]), message = object(choice.message);
    if (message.role !== "assistant" || !["stop", "tool_calls"].includes(choice.finish_reason)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen provider response did not settle successfully");
    }
    if (typeof context.promptId !== "string" || !context.promptId) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen log has no prompt identity");
    const isMain = context.promptId === session || context.promptId.startsWith(session + MAIN_PROMPT_DELIMITER);
    if (!isMain) {
      if ((request.tools?.length ?? 0) > 0 || request.messages.some((entry: JsonObject) =>
        entry.role === "tool" || entry.role === "function" || entry.function_call !== undefined ||
        entry.tool_calls !== undefined || entry.tool_call_id !== undefined) || message.tool_calls !== undefined || message.function_call !== undefined) {
        throw new ExperimentFailure(Code.UnknownTool, "Qwen auxiliary request contains tools");
      }
      source.record("qwen_auxiliary_request", { request, response, context, t });
      continue;
    }
    if (request.stream !== true) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen main request is not a captured streaming request");
    if (context.sessionId !== session) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen provider session identity changed");
    requireInventory(request.tools, expected);
    const resultIds = requestResults(source, calls, request.messages);
    for (const id of assistantCalls(source, calls, message)) {
      if (produced.has(id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen provider responses repeat a native call");
      produced.add(id);
    }
    for (const id of resultIds) {
      if (!delivered.has(id)) {
        source.record("tool_result_delivered", { call_id: id, t });
        deliveries.push({ id, t });
        delivered.add(id);
      }
    }
    mainRequests++;
    source.record("qwen_provider_request", { request, response, context, evidence_boundary: "captured-openai-request", t });
  }
  if (!mainRequests || produced.size !== calls.size || delivered.size !== calls.size) {
    throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen lacks complete model-call and successful result-delivery evidence");
  }
  recordVerifiedDeliveries(source, "qwen", calls, deliveries, "captured-openai-request");
}
