import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

export const piObject = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperimentFailure(Code.Protocol, "Pi evidence requires an object");
  return value as JsonObject;
};

export function assertPiExperimentResult(value: unknown): asserts value is JsonObject {
  const result = piObject(value);
  if (!Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean") ||
      Object.keys(result).some((key) => !["content", "isError"].includes(key))) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Pi experiment result requires content and optional boolean isError only");
  }
  for (const block of result.content) {
    if (block?.type === "text" && typeof block.text === "string" && Object.keys(block).every((key) => ["type", "text"].includes(key))) continue;
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string" &&
        Object.keys(block).every((key) => ["type", "data", "mimeType"].includes(key))) continue;
    throw new ExperimentFailure(Code.UnsupportedResult, "Pi experiment supports plain text and image blocks only");
  }
}

type Projection = { tools: JsonObject[]; calls: JsonObject[]; results: JsonObject[]; kind: "anthropic" | "responses" | "chat" | "google" | "bedrock" };
const array = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) throw new ExperimentFailure(Code.Protocol, "Pi provider payload requires an array");
  return value.map(piObject);
};

/** Installed @earendil-works/pi-coding-agent/package.json: 0.85.1,
 * read 2026-11-09. Its node_modules/@earendil-works/pi-ai/dist/api/:
 * anthropic-messages.js convertTools/input_schema, convertToolResult/tool_result;
 * openai-responses-shared.js convertResponsesTools, function_call_output;
 * openai-completions.js toolResultMsg/tool_call_id and imageBlocks;
 * google-shared.js convertTools/functionDeclarations and functionResponse;
 * bedrock-converse-stream.js toolSpec/inputSchema and toolResult/toolUseId.
 * Unknown providers and schema rewrites fail closed, including Google
 * compatibility modes that remove JSON Schema constraints. */
function projection(api: string, payload: JsonObject): Projection {
  if (api === "anthropic-messages") {
    for (const message of array(payload.messages)) for (const part of Array.isArray(message.content) ? array(message.content) : []) {
      if ((part.type === "tool_use" && message.role !== "assistant") || (part.type === "tool_result" && message.role !== "user")) {
        throw new ExperimentFailure(Code.Protocol, "Pi Anthropic tool evidence has a wrong message role");
      }
    }
    return { kind: "anthropic", tools: array(payload.tools),
    calls: array(payload.messages).flatMap((m) => Array.isArray(m.content) ? m.content.filter((c: JsonObject) => c.type === "tool_use") : []),
    results: array(payload.messages).flatMap((m) => Array.isArray(m.content) ? m.content.filter((c: JsonObject) => c.type === "tool_result") : []) };
  }
  if (["openai-responses", "openai-codex-responses"].includes(api)) return { kind: "responses", tools: array(payload.tools),
    calls: array(payload.input).filter((m) => m.type === "function_call"),
    results: array(payload.input).filter((m) => m.type === "function_call_output") };
  if (api === "openai-completions") {
    if (array(payload.messages).some((message) => message.tool_calls !== undefined && message.role !== "assistant")) {
      throw new ExperimentFailure(Code.Protocol, "Pi Chat tool calls have a wrong message role");
    }
    return { kind: "chat", tools: array(payload.tools).map((t) => piObject(t.function)),
    calls: array(payload.messages).flatMap((m) => m.tool_calls === undefined ? [] : array(m.tool_calls)),
    results: array(payload.messages).filter((m) => m.role === "tool") };
  }
  if (["google-generative-ai", "google-vertex", "google-gemini-cli"].includes(api)) {
    const request = payload.request ?? payload;
    const config = request.config ?? request;
    for (const message of array(request.contents)) for (const part of array(message.parts)) {
      if ((part.functionCall && message.role !== "model") || (part.functionResponse && message.role !== "user")) {
        throw new ExperimentFailure(Code.Protocol, "Pi Google tool evidence has a wrong message role");
      }
    }
    return { kind: "google", tools: array(config.tools).flatMap((t) => array(t.functionDeclarations)),
      calls: array(request.contents).flatMap((m) => array(m.parts).filter((p) => p.functionCall).map((p) => piObject(p.functionCall))),
      results: array(request.contents).flatMap((m) => array(m.parts).filter((p) => p.functionResponse).map((p) => piObject(p.functionResponse))) };
  }
  if (api === "bedrock-converse-stream") {
    for (const message of array(payload.messages)) for (const part of array(message.content)) {
      if ((part.toolUse && message.role !== "assistant") || (part.toolResult && message.role !== "user")) {
        throw new ExperimentFailure(Code.Protocol, "Pi Bedrock tool evidence has a wrong message role");
      }
    }
    return { kind: "bedrock", tools: array(piObject(payload.toolConfig).tools).map((t) => piObject(t.toolSpec)),
    calls: array(payload.messages).flatMap((m) => array(m.content).filter((c) => c.toolUse).map((c) => piObject(c.toolUse))),
    results: array(payload.messages).flatMap((m) => array(m.content).filter((c) => c.toolResult).map((c) => piObject(c.toolResult))) };
  }
  throw new ExperimentFailure(Code.ModelUnavailable, `Pi experiment has no final payload decoder for API ${api}`);
}

function same(actual: unknown, expected: unknown, message: string, code = Code.ResultChanged): void {
  if (!isDeepStrictEqual(actual, expected)) throw new ExperimentFailure(code, message);
}

/** The same native converters serialize assistant tool calls beside the
 * result projections below. Checking only results would accept a request
 * that changed the called tool or its arguments after context capture. */
function verifyPiProviderCalls(projected: Projection, messages: JsonObject[]): void {
  const expected = messages.filter((m) => m.role === "assistant")
    .flatMap((m) => array(m.content).filter((c) => c.type === "toolCall"));
  if (expected.length !== projected.calls.length) {
    throw new ExperimentFailure(Code.CallIdUnresolved, "Pi provider omitted or added assistant tool calls");
  }
  for (const [index, call] of expected.entries()) {
    const actual = projected.calls[index]!;
    let id = actual.id, name = actual.name, input = actual.input;
    let expectedId = call.id;
    if (projected.kind === "anthropic" || projected.kind === "bedrock") {
      expectedId = String(call.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      if (projected.kind === "bedrock") id = actual.toolUseId;
    } else if (projected.kind === "google") {
      input = actual.args;
      if (id === undefined) expectedId = undefined;
    } else {
      const fn = projected.kind === "chat" ? piObject(actual.function) : actual;
      name = fn.name;
      if (projected.kind === "responses") { id = actual.call_id; expectedId = String(call.id).split("|")[0]; }
      if (typeof fn.arguments !== "string") throw new ExperimentFailure(Code.Protocol, "Pi provider call arguments are not serialized JSON");
      try { input = JSON.parse(fn.arguments); }
      catch { throw new ExperimentFailure(Code.Protocol, "Pi provider call arguments contain invalid JSON"); }
    }
    same({ id, name, input }, { id: expectedId, name: call.name, input: call.arguments },
      "Pi provider assistant tool call changed", Code.CallIdUnresolved);
  }
}

/** Conversion evidence read 2026-11-09 from the installed files above:
 * Anthropic convertContentBlocks joins text with "\n" and emits source.type:"base64";
 * Responses convertToolResultOutput emits input_text/input_image and strips
 * the suffix after "|" from toolCallId. Chat emits role:"tool" and moves images
 * into a later user message. Google uses response.output/error plus optional
 * parts.inlineData. Bedrock convertToolResultContent uses text/image blocks;
 * normalizeToolCallId restricts IDs to [a-zA-Z0-9_-] and 64 characters.
 * Checks the actual native request, not just an earlier context snapshot.
 * Native wrappers are compared exactly. No invented result headers, image
 * placeholders, dropped blocks, or rewritten text bytes are accepted. */
export function verifyPiProviderPayload(server: string, definitions: readonly JsonObject[], api: string,
  payload: unknown, messages: JsonObject[]): string[] {
  const projected = projection(api, piObject(payload));
  const expectedTools = definitions.map((t) => ({ name: `mcp__${server}__${t.name}`, description: t.description, schema: t.inputSchema }));
  const actualTools = projected.tools.map((t) => ({ name: t.name, description: t.description,
    schema: t.input_schema ?? t.parameters ?? t.parametersJsonSchema ?? t.inputSchema?.json }));
  same(actualTools, expectedTools, "Pi provider tool inventory differs from the experiment server", Code.InventoryMismatch);
  verifyPiProviderCalls(projected, messages);
  const results = messages.filter((m) => m.role === "toolResult");
  if (results.length !== projected.results.length) throw new ExperimentFailure(Code.HarnessLogMissing, "Pi provider omitted or duplicated tool results");
  const delivered: string[] = [];
  for (const [index, message] of results.entries()) {
    assertPiExperimentResult({ content: message.content, isError: message.isError });
    const parts = message.content as JsonObject[];
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    const images = parts.filter((p) => p.type === "image");
    const result = projected.results[index]!;
    const id = String(message.toolCallId);
    switch (projected.kind) {
      case "anthropic": {
        same(result.tool_use_id, id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), "Pi Anthropic call ID changed");
        const content = images.length ? parts.map((p) => p.type === "text" ? p :
          { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } }) : text;
        same(result.content, content, "Pi Anthropic tool result changed");
        same(result.is_error, message.isError, "Pi Anthropic error status changed");
        break;
      }
      case "responses": {
        same(result.call_id, id.split("|")[0], "Pi Responses call ID changed");
        const output = images.length ? [...(text.length ? [{ type: "input_text", text }] : []),
          ...images.map((p) => ({ type: "input_image", detail: "auto", image_url: `data:${p.mimeType};base64,${p.data}` }))] : text;
        same(result.output, output, "Pi Responses tool result changed");
        break;
      }
      case "chat":
        same(result.tool_call_id, id, "Pi Chat call ID changed");
        if (images.length) throw new ExperimentFailure(Code.UnsupportedResult, "Pi Chat separates result images from their call IDs");
        same(result.content, text, "Pi Chat tool result changed");
        break;
      case "google":
        same(result.name, message.toolName, "Pi Google result tool name changed");
        if (result.id !== undefined) same(result.id, id, "Pi Google call ID changed");
        same(result.response, message.isError ? { error: text } : { output: text }, "Pi Google tool result changed");
        same(result.parts ?? [], images.map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.data } })), "Pi Google images changed");
        break;
      case "bedrock":
        same(result.toolUseId, id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), "Pi Bedrock call ID changed");
        same(result.status, message.isError ? "error" : "success", "Pi Bedrock error status changed");
        same(result.content, parts.map((p) => p.type === "text" ? { text: p.text } :
          { image: { format: p.mimeType === "image/jpg" ? "jpeg" : p.mimeType.split("/")[1], source: { bytes: Object.fromEntries([...Buffer.from(p.data, "base64")].map((n, i) => [i, n])) } } }),
        "Pi Bedrock tool result changed");
    }
    delivered.push(id);
  }
  if (new Set(delivered).size !== delivered.length) throw new ExperimentFailure(Code.Protocol, "Pi provider repeats a tool call ID");
  return delivered;
}
