import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";
import { recordVerifiedDeliveries } from "./experiment-delivery-records.js";
import { geminiExperimentArguments, geminiExperimentDefinitions, geminiExperimentObject, geminiExperimentOutput, geminiExperimentToolName } from "./gemini-experiment-content.js";

export interface GeminiExperimentEvidenceSource {
  spec: { name: string };
  calls: readonly ExperimentRelayCall[];
  toolDefinitions: readonly JsonObject[] | undefined;
  record: ExperimentRecord;
}

/** Canonical generator requests, after native MCP conversion and call-ID
 * stripping. This is not an HTTP body capture. Gemini 0.60.0's pinned
 * CodeAssist/Vertex/MLDev serializers preserve these function responses.
 * Installed bundle/chunk-M6NSK26M.js, read 2026-11-09: :331837
 * stripToolCallIdPrefixes precedes LoggingContentGenerator; :310885
 * JSON.stringify(contents) supplies api_request.request_text; :311013
 * gen_ai.tool.definitions records req.config.tools. :289019
 * toVertexGenerateContentRequest copies contents/tools; :265177
 * generateContentParametersToVertex preserves contents; :266529
 * partToMldev$1 copies functionResponse unchanged. BeforeModel's
 * :334547 HookTranslatorGenAIv1 filters non-text parts and is insufficient. */
export function verifyGeminiExperimentEvidence(source: GeminiExperimentEvidenceSource, records: JsonObject[], stdout: string): void {
  if (!source.toolDefinitions?.length) throw new ExperimentFailure(Code.InventoryMismatch, "Gemini experiment has no server inventory");
  const expected = geminiExperimentDefinitions(source.spec.name, source.toolDefinitions);
  const calls = new Map<string, ExperimentRelayCall>();
  const wireCalls = new Map<string, ExperimentRelayCall>();
  for (const call of source.calls) {
    if (!call.call_id || calls.has(call.call_id) || !call.result) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini relay call is incomplete or repeated");
    calls.set(call.call_id, call);
    const name = geminiExperimentToolName(source.spec.name, call.name);
    const wireId = call.call_id.startsWith(`${name}__`) ? call.call_id.slice(name.length + 2) : call.call_id;
    if (!wireId || wireCalls.has(wireId)) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini stripped native call IDs collide");
    wireCalls.set(wireId, call);
  }
  const declared = new Set<string>(), completed = new Set<string>(), delivered = new Set<string>();
  const deliveries: { id: string; t: number }[] = [];
  const modelCalls = new Map<string, ExperimentRelayCall>();
  let ended = false, session: string | undefined;
  const events = stdout.split("\n").filter((line) => line.trim()).map((line) => geminiExperimentObject(JSON.parse(line)));
  if (!stdout.endsWith("\n")) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini native stdout is truncated");
  for (const event of events) {
    if (ended) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini emitted events after its terminal result");
    if (event.type === "init") {
      if (session || typeof event.session_id !== "string" || !event.session_id) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini session identity is missing or repeated");
      session = event.session_id;
    } else if (event.type === "tool_use") {
      const call = calls.get(event.tool_id);
      if (!call || event.tool_name !== geminiExperimentToolName(source.spec.name, call.name) ||
          !geminiExperimentArguments(event.parameters, call.input) || declared.has(event.tool_id)) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini stdout call differs from the relay call");
      }
      declared.add(event.tool_id);
    } else if (event.type === "tool_result") {
      if (!declared.has(event.tool_id) || completed.has(event.tool_id) || event.status !== "success") throw new ExperimentFailure(Code.ResultChanged, "Gemini native tool result failed or has no unique call");
      completed.add(event.tool_id);
    } else if (event.type === "result") {
      if (event.status !== "success") throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini native run did not succeed");
      ended = true;
    } else if (event.type === "error" && event.severity !== "warning") throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini emitted an error");
  }
  const spans = new Map<string, JsonObject>();
  for (const record of records) {
    if (record._spanContext?.spanId && record.attributes?.["gen_ai.tool.definitions"] !== undefined) {
      const key = `${record._spanContext.traceId}/${record._spanContext.spanId}`;
      if (spans.has(key)) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini telemetry repeats a generator span");
      spans.set(key, record);
    }
  }
  const responses = new Map<string, JsonObject>();
  for (const record of records) {
    if (record.attributes?.["event.name"] !== "gemini_cli.api_response") continue;
    const key = `${record.spanContext?.traceId}/${record.spanContext?.spanId}`;
    if (responses.has(key)) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini telemetry repeats an API response");
    responses.set(key, record);
  }
  let requests = 0, settledRequests = 0;
  const seenRequests = new Set<string>();
  for (const log of records) {
    const attributes = log.attributes;
    if (attributes?.["event.name"] !== "gemini_cli.api_request") continue;
    const contents: unknown = JSON.parse(attributes.request_text);
    if (!Array.isArray(contents)) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini request contents are missing");
    const parts = contents.flatMap((content) => {
      if (!Array.isArray(content.parts)) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini request has no parts");
      return content.parts.map((part: unknown) => ({ role: content.role, part: geminiExperimentObject(part) }));
    });
    const key = `${log.spanContext?.traceId}/${log.spanContext?.spanId}`;
    const span = spans.get(key);
    if (!span || seenRequests.has(key) || span.attributes["gen_ai.conversation.id"] !== session ||
        span.attributes["gen_ai.prompt.name"] !== attributes.prompt_id || span.attributes["gen_ai.request.model"] !== attributes.model) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini request lacks a unique matching generator span");
    }
    seenRequests.add(key);
    if (attributes.role !== "main") {
      if (parts.some(({ part }) => part.functionCall || part.functionResponse)) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini auxiliary request contains experiment tools");
      continue;
    }
    // An OK generator span is insufficient: runInDevTraceSpan ends an
    // early-returned iterator in finally without an error. Only exhausted
    // loggingStreamWrapper emits api_response (installed Gemini 0.60.0
    // chunk-M6NSK26M.js:287840 and :311033-311058, read 2026-11-09).
    const response = responses.get(key)?.attributes;
    let settled = false;
    if (response) {
      if (response.role !== "main" || response.prompt_id !== attributes.prompt_id || response.status_code !== 200) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini API response does not match its main request");
      const raw: unknown = JSON.parse(response.response_text);
      const chunks = Array.isArray(raw) ? raw : [raw];
      if (!chunks.some((chunk) => chunk && typeof chunk === "object" && Array.isArray(chunk.candidates) &&
          chunk.candidates.some((candidate: JsonObject) => candidate?.content?.role === "model" && Array.isArray(candidate.content.parts) && candidate.content.parts.length > 0))) {
        throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini API response contains no model content");
      }
      settled = span.status?.code === 1;
      if (settled) settledRequests++;
    }
    const tools: unknown = JSON.parse(span.attributes["gen_ai.tool.definitions"]);
    if (!Array.isArray(tools) || tools.some((tool) => Object.keys(tool).some((key) => key !== "functionDeclarations")) ||
        !isDeepStrictEqual(tools.flatMap((tool) => tool.functionDeclarations), expected)) {
      throw new ExperimentFailure(Code.InventoryMismatch, "Gemini model-bound tool inventory changed");
    }
    const nativeCalls = new Set<string>(), nativeResults = new Set<string>();
    for (const { role, part } of parts) {
      for (const kind of ["functionCall", "functionResponse"] as const) {
        if (!part[kind]) continue;
        // Native headless loop uses user tool responses (Gemini 0.60.0
        // gemini-LUNNHKPJ.js:12092 currentMessages, read 2026-11-09).
        if (role !== (kind === "functionCall" ? "model" : "user")) throw new ExperimentFailure(Code.ResultChanged, "Gemini tool content has a missing or changed role");
        const native = geminiExperimentObject(part[kind]);
        const call = wireCalls.get(native.id);
        if (!call || native.name !== geminiExperimentToolName(source.spec.name, call.name)) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini provider request names an unknown call");
        if (kind === "functionCall") {
          if (nativeCalls.has(native.id) || !geminiExperimentArguments(native.args, call.input)) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini provider call arguments changed or repeated");
          nativeCalls.add(native.id);
        } else {
          if (!nativeCalls.has(native.id) || nativeResults.has(native.id) || Object.keys(part).length !== 1 ||
              !isDeepStrictEqual(native, { id: native.id, name: native.name, response: { output: geminiExperimentOutput(call.result!) } })) {
            throw new ExperimentFailure(Code.ResultChanged, "Gemini model-bound tool response changed or lacks its call");
          }
          nativeResults.add(native.id);
          if (settled && !delivered.has(call.call_id!)) {
            const t = Date.now() / 1000;
            source.record("tool_result_delivered", { call_id: call.call_id!, t });
            deliveries.push({ id: call.call_id!, t });
            // Preserve the actual output, including the opted-in wrapper.
            modelCalls.set(call.call_id!, { ...call, result: { content: [{ type: "text", text: native.response.output }] } });
            delivered.add(call.call_id!);
          }
        }
      }
    }
    requests++;
    source.record("gemini_generator_request", { span_id: key, contents, tools, evidence_boundary: "canonical-generator-request" });
  }
  if (!ended || !session || !requests || !settledRequests || spans.size !== seenRequests.size ||
      [...responses.keys()].some((key) => !seenRequests.has(key)) || calls.size !== declared.size || calls.size !== completed.size || calls.size !== delivered.size) {
    throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini experiment lacks complete native calls, successful model delivery, or terminal evidence");
  }
  recordVerifiedDeliveries(source, "gemini", modelCalls, deliveries, "canonical-generator-request");
}
