import { describe, expect, test } from "bun:test";
import { assertGeminiExperimentResult, geminiExperimentDefinitions, geminiExperimentOutput, geminiExperimentToolName, parseGeminiExperimentTelemetry } from "../src/gemini-experiment-content.js";
import { verifyGeminiExperimentEvidence, type GeminiExperimentEvidenceSource } from "../src/gemini-experiment-evidence.js";
import type { JsonObject } from "../src/experiment-server.js";

export const geminiDefinition = { name: "echo", description: "Return text", inputSchema: { type: "object", properties: {} } };
export const geminiResult = { content: [{ type: "text", text: 'literal {"x": "\\\\"}\n😀' }, { type: "text", text: "second" }] };
export const geminiNativeId = "mcp_test_echo__native-1";
export function geminiSource() {
  const records: JsonObject[] = [];
  return { spec: { name: "test" }, calls: [{ relay_index: 1, name: "echo", input: {}, call_id: geminiNativeId, result: geminiResult }],
    toolDefinitions: [geminiDefinition], record: (kind: string, fields: JsonObject) => { records.push({ kind, ...fields }); }, records };
}
export function geminiEvents(): JsonObject[] {
  return [{ type: "init", session_id: "session-one" }, { type: "tool_use", tool_name: "mcp_test_echo", tool_id: geminiNativeId, parameters: {} },
    { type: "tool_result", tool_id: geminiNativeId, status: "success", output: "display is not evidence" },
    { type: "message", role: "assistant", content: "done" }, { type: "result", status: "success", stats: { input_tokens: 100, cached: 10, output_tokens: 20 } }];
}
export function geminiStdout(events = geminiEvents()): string { return events.map((event) => JSON.stringify(event) + "\n").join(""); }
export function geminiTelemetry(): JsonObject[] {
  const span = { _spanContext: { traceId: "trace", spanId: "span" }, status: { code: 1 }, attributes: {
    "gen_ai.tool.definitions": JSON.stringify([{ functionDeclarations: geminiExperimentDefinitions("test", [geminiDefinition]) }]),
    "gen_ai.conversation.id": "session-one", "gen_ai.prompt.name": "prompt", "gen_ai.request.model": "configured-model" } };
  const contents = [{ role: "model", parts: [{ functionCall: { id: "native-1", name: "mcp_test_echo", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { id: "native-1", name: "mcp_test_echo", response: { output: geminiExperimentOutput(geminiResult) } } }] }];
  return [{ attributes: { "event.name": "unrelated" } }, span,
    { spanContext: { traceId: "trace", spanId: "span" }, attributes: { "event.name": "gemini_cli.api_request", role: "main", prompt_id: "prompt", model: "configured-model", request_text: JSON.stringify(contents) } },
    { spanContext: { traceId: "trace", spanId: "span" }, attributes: { "event.name": "gemini_cli.api_response", role: "main", prompt_id: "prompt", status_code: 200,
      response_text: '[{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]}}]}]' } }];
}

describe("Gemini native experiment evidence", () => {
  test("joins native stdout, exact inventory, canonical response bytes and span identity", () => {
    const source = geminiSource();
    const text = geminiTelemetry().map((record) => JSON.stringify(record, null, 2)).join("\n");
    verifyGeminiExperimentEvidence(source, parseGeminiExperimentTelemetry(text), geminiStdout());
    expect(source.records.filter((r) => r.kind === "tool_result_delivered")).toHaveLength(1);
    expect(source.records.at(-1)?.evidence_boundary).toBe("canonical-generator-request");
  });
  test("pins native naming, schema insertion, collisions and unmodified server properties", () => {
    expect(geminiExperimentToolName("mcp_test", "a/b")).toBe("mcp_test_a_b");
    expect(geminiExperimentToolName("test", "x".repeat(100))).toHaveLength(63);
    const defs = geminiExperimentDefinitions("test", [geminiDefinition]);
    expect(defs[0]?.parametersJsonSchema.properties.wait_for_previous.type).toBe("boolean");
    expect(() => geminiExperimentDefinitions("test", [{ ...geminiDefinition, inputSchema: { type: "object", properties: { wait_for_previous: {} } } }])).toThrow("reserves");
    expect(() => geminiExperimentDefinitions("test", [geminiDefinition, geminiDefinition])).toThrow("collide");
    expect(() => geminiExperimentDefinitions("test", [{ inputSchema: {} }])).toThrow("name");
    expect(geminiExperimentDefinitions("test", [{ name: "array", inputSchema: { type: "array" } }])[0]?.parametersJsonSchema).toEqual({ type: "array" });
    expect(geminiExperimentDefinitions("test", [{ name: "empty", inputSchema: { type: "object" } }])[0]?.description).toBe("");
  });
  test.each([
    { content: [] }, { content: [{ type: "text", text: "</untrusted_context>" }] }, { content: [{ type: "image", data: "x" }] },
    { ...geminiResult, isError: true }, { ...geminiResult, structuredContent: {} }, { content: [{ type: "text", text: "x", annotations: {} }] },
    { content: [null] }, { content: ["bad"] },
  ])("refuses native lossy result forms before delivery %#", (result) => expect(() => assertGeminiExperimentResult(result)).toThrow("plain text"));
  test("parses pretty concatenated JSON with escapes and bounds damaged frames", () => {
    expect(parseGeminiExperimentTelemetry(' {"x":"\\\"}\\\\["}\n{"y":[]} ')).toHaveLength(2);
    for (const text of ['[]', '{', '{"x":[]', '{"x":undefined}', '{"x":' + '['.repeat(129)]) expect(() => parseGeminiExperimentTelemetry(text)).toThrow();
    expect(() => parseGeminiExperimentTelemetry("{}\n".repeat(10001))).toThrow("10000");
  });
  test.each(["result", "extra-result-text", "inventory", "arguments", "identity", "span", "session", "duplicate-span", "duplicate-request", "missing-log", "missing-call", "no-parts", "not-array", "result-before-call", "duplicate-result", "failed-span", "auxiliary-tools"])("rejects %s evidence", (kind) => {
    const records = geminiTelemetry(), span = records[1]!, log = records[2]!;
    const contents = JSON.parse(log.attributes.request_text);
    if (kind === "result") contents[1].parts[0].functionResponse.response.output += "changed";
    if (kind === "extra-result-text") contents[1].parts[0].text = "unrecorded addition";
    if (kind === "inventory") span.attributes["gen_ai.tool.definitions"] = "[]";
    if (kind === "arguments") contents[0].parts[0].functionCall.args = { changed: true };
    if (kind === "identity") contents[0].parts[0].functionCall.id = "foreign";
    if (kind === "span") log.spanContext.spanId = "missing";
    if (kind === "session") span.attributes["gen_ai.conversation.id"] = "foreign";
    if (kind === "duplicate-span") records.push(span);
    if (kind === "duplicate-request") records.push(log);
    if (kind === "missing-log") records.splice(2, 1);
    if (kind === "missing-call") contents.shift();
    if (kind === "no-parts") delete contents[0].parts;
    if (kind === "result-before-call") contents.reverse();
    if (kind === "duplicate-result") contents.push(contents[1]);
    if (kind === "failed-span") span.status.code = 2;
    if (kind === "auxiliary-tools") log.attributes.role = "utility_summarizer";
    log.attributes.request_text = JSON.stringify(kind === "not-array" ? {} : contents);
    expect(() => verifyGeminiExperimentEvidence(geminiSource(), records, geminiStdout())).toThrow();
  });
  test.each(["missing-init", "repeated-init", "missing-result", "failed-result", "after-result", "repeated-call", "failed-tool", "error", "truncated", "unknown-call", "wrong-args"])("rejects native %s", (kind) => {
    const events = geminiEvents();
    if (kind === "missing-init") events.shift();
    if (kind === "repeated-init") events.splice(1, 0, events[0]!);
    if (kind === "missing-result") events.pop();
    if (kind === "failed-result") events.at(-1)!.status = "error";
    if (kind === "after-result") events.push({ type: "message" });
    if (kind === "repeated-call") events.splice(2, 0, events[1]!);
    if (kind === "failed-tool") events[2]!.status = "error";
    if (kind === "error") events.splice(1, 0, { type: "error", severity: "error" });
    if (kind === "unknown-call") events[1]!.tool_id = "foreign";
    if (kind === "wrong-args") events[1]!.parameters = [];
    expect(() => verifyGeminiExperimentEvidence(geminiSource(), geminiTelemetry(), kind === "truncated" ? geminiStdout(events).trim() : geminiStdout(events))).toThrow();
  });
  test("refuses incomplete relay identity and accepts unrelated utility text only", () => {
    const source = geminiSource();
    expect(() => verifyGeminiExperimentEvidence({ ...source, toolDefinitions: undefined }, [], "")).toThrow("inventory");
    expect(() => verifyGeminiExperimentEvidence({ ...source, calls: [{ ...source.calls[0]!, result: undefined }] }, [], "")).toThrow("incomplete");
    expect(() => verifyGeminiExperimentEvidence({ ...source, calls: [...source.calls, { ...source.calls[0]!, call_id: "native-1" }] }, [], "")).toThrow("collide");
    const records = geminiTelemetry();
    records.push({ ...records[1], _spanContext: { traceId: "trace", spanId: "utility" } });
    records.push({ spanContext: { traceId: "trace", spanId: "utility" }, attributes: { ...records[2]!.attributes, role: "utility", request_text: '[{"role":"user","parts":[{"text":"summary"}]}]' } });
    verifyGeminiExperimentEvidence(source as GeminiExperimentEvidenceSource, records, geminiStdout());
  });
  test("rejects a generator span whose request log is missing", () => {
    const records = geminiTelemetry();
    records.push({ ...records[1], _spanContext: { traceId: "trace", spanId: "orphan" },
      attributes: { ...records[1]!.attributes, "gen_ai.tool.definitions": "[]" } });
    expect(() => verifyGeminiExperimentEvidence(geminiSource(), records, geminiStdout())).toThrow("lacks complete");
  });
  test.each(["missing", "failed", "empty", "wrong-prompt", "wrong-role", "duplicate", "successful-text-retry", "failed-span-text-retry"])("requires settled response evidence: %s", (kind) => {
    const records = geminiTelemetry(), response = records[3]!;
    if (kind === "missing" || kind.endsWith("text-retry")) records.pop();
    if (kind === "failed") response.attributes.status_code = 500;
    if (kind === "empty") response.attributes.response_text = "[]";
    if (kind === "wrong-prompt") response.attributes.prompt_id = "other";
    if (kind === "wrong-role") response.attributes.role = "utility";
    if (kind === "duplicate") records.push(response);
    if (kind.endsWith("text-retry")) {
      if (kind === "failed-span-text-retry") records[1]!.status.code = 2;
      records.push({ ...records[1], status: { code: 1 }, _spanContext: { traceId: "trace", spanId: "retry" } },
        { ...records[2], spanContext: { traceId: "trace", spanId: "retry" }, attributes: { ...records[2]!.attributes, request_text: '[{"role":"user","parts":[{"text":"retry"}]}]' } },
        { ...response, spanContext: { traceId: "trace", spanId: "retry" } });
    }
    expect(() => verifyGeminiExperimentEvidence(geminiSource(), records, geminiStdout())).toThrow();
  });
  test.each(["call-role", "result-role", "missing-call-role", "missing-result-role"])("rejects %s semantic mutation", (kind) => {
    const records = geminiTelemetry(), log = records[2]!;
    const contents = JSON.parse(log.attributes.request_text);
    const index = kind.includes("call") ? 0 : 1;
    if (kind.startsWith("missing")) delete contents[index].role;
    else contents[index].role = index === 0 ? "user" : "model";
    log.attributes.request_text = JSON.stringify(contents);
    expect(() => verifyGeminiExperimentEvidence(geminiSource(), records, geminiStdout())).toThrow("role");
  });
});
