import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUtf8FileBounded } from "./file-io.js";
import { parseGeminiExperimentTelemetry } from "./gemini-experiment-content.js";

export const GEMINI_MAX_TELEMETRY_BYTES = 32 * 1024 * 1024;

/** Installed Gemini 0.60.0 chunk-M6NSK26M.js:285134 reads these env
 * settings; :288195 telemetryOutfile selects local exporters. Read
 * 2026-11-09. No collector or cloud telemetry is enabled by this helper. */
export function geminiTelemetryEnvironment(path: string): Record<string, string> {
  return { GEMINI_TELEMETRY_ENABLED: "true", GEMINI_TELEMETRY_TRACES_ENABLED: "true",
    GEMINI_TELEMETRY_TARGET: "local", GEMINI_TELEMETRY_LOG_PROMPTS: "true", GEMINI_TELEMETRY_USE_COLLECTOR: "false",
    GEMINI_TELEMETRY_USE_CLI_AUTH: "false", GEMINI_TELEMETRY_OUTFILE: path, OTEL_TRACES_SAMPLER: "always_on",
    OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: String(GEMINI_MAX_TELEMETRY_BYTES),
    OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: String(GEMINI_MAX_TELEMETRY_BYTES), OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT: String(GEMINI_MAX_TELEMETRY_BYTES) };
}

export function prepareGeminiTelemetry(home: string): string {
  const path = join(home, "codemux-telemetry.json");
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  return path;
}

/** Raw modelVersion has provenance unlike the fallback statistics key.
 * Installed Gemini 0.60.0 chunk-M6NSK26M.js:310987 generateContent and
 * :311050 loggingStreamWrapper serialize response.modelVersion directly;
 * :276899 ApiResponseEvent retains response_text. Read 2026-11-09.
 * All completed main requests must agree. Missing provider fields, damaged
 * evidence, foreign sessions and model switches yield unknown, never the
 * requested model or log.attributes.model (which can be a fallback). */
export function geminiTelemetryServedModel(path: string | undefined, sessionId: string | null): string | null {
  if (!path || !sessionId) return null;
  try {
    const records = parseGeminiExperimentTelemetry(readUtf8FileBounded(path,
      { maxBytes: GEMINI_MAX_TELEMETRY_BYTES, label: "Gemini local telemetry", noFollow: true }));
    const nativeSpans = records.filter((record) => record._spanContext?.spanId && record.attributes?.["gen_ai.tool.definitions"] !== undefined);
    const spans = new Map(nativeSpans.map((record) => [`${record._spanContext.traceId}/${record._spanContext.spanId}`, record]));
    if (spans.size !== nativeSpans.length) return null;
    const requests = new Set(records.filter((record) => record.attributes?.["event.name"] === "gemini_cli.api_request" && record.attributes.role === "main")
      .map((record) => `${record.spanContext?.traceId}/${record.spanContext?.spanId}`));
    const models = new Set<string>(), seen = new Set<string>();
    let responses = 0;
    for (const record of records) {
      const attributes = record.attributes;
      if (attributes?.["event.name"] !== "gemini_cli.api_response" || attributes.role !== "main") continue;
      const key = `${record.spanContext?.traceId}/${record.spanContext?.spanId}`;
      const span = spans.get(key);
      if (!span || !requests.has(key) || seen.has(key) || span.status?.code !== 1 || attributes.status_code !== 200 ||
          span.attributes["gen_ai.conversation.id"] !== sessionId || span.attributes["gen_ai.prompt.name"] !== attributes.prompt_id) return null;
      seen.add(key);
      const raw: unknown = JSON.parse(attributes.response_text);
      const chunks = Array.isArray(raw) ? raw : [raw];
      let reported = false;
      for (const chunk of chunks) {
        if (!chunk || typeof chunk !== "object") return null;
        if (!Object.hasOwn(chunk, "modelVersion")) continue;
        const model = chunk.modelVersion;
        if (typeof model !== "string" || !model.trim() || model.trim() !== model || model.length > 1024 || /[\x00-\x1f\x7f]/.test(model)) return null;
        models.add(model); reported = true;
      }
      if (!reported) return null;
      responses++;
    }
    return responses > 0 && requests.size === seen.size && models.size === 1 ? [...models][0]! : null;
  } catch { return null; }
}
