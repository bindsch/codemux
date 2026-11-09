import { describe, expect, test } from "bun:test";
import { assertPiExperimentResult, verifyPiProviderPayload } from "../src/pi-experiment-content.js";
import { verifyPiExperimentEvidence } from "../src/pi-experiment-evidence.js";
import type { JsonObject } from "../src/experiment-server.js";

export const definition = { name: "echo", description: "Return exact bytes", inputSchema: { type: "object", properties: {} } };
export const name = "mcp__test__echo";
export const content = [{ type: "text", text: " exact\nbytes " }];
export const resultMessage = { role: "toolResult", toolCallId: "native-1", toolName: name, content, isError: false };
export const assistant = { role: "assistant", content: [{ type: "toolCall", id: "native-1", name, arguments: {} }] };
export const stdout = `${JSON.stringify({ type: "message_end", message: assistant })}\n${JSON.stringify({ type: "agent_end" })}\n`;
export function payload(api: string, messages: JsonObject[] = [resultMessage]): JsonObject {
  const tool = { name, description: definition.description };
  const results = messages.filter((m) => m.role === "toolResult");
  const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c: JsonObject) => c.type === "toolCall"));
  if (api === "anthropic-messages") return { tools: [{ ...tool, input_schema: definition.inputSchema }],
    messages: [...(calls.length ? [{ role: "assistant", content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments })) }] : []),
      { role: "user", content: results.map((m) => ({ type: "tool_result", tool_use_id: m.toolCallId,
      content: m.content.map((c: JsonObject) => c.text).join("\n"), is_error: m.isError })) }] };
  if (api.includes("responses")) return { tools: [{ ...tool, type: "function", parameters: definition.inputSchema }],
    input: [...calls.map((c) => ({ type: "function_call", call_id: c.id.split("|")[0], name: c.name, arguments: JSON.stringify(c.arguments) })),
      ...results.map((m) => ({ type: "function_call_output", call_id: m.toolCallId.split("|")[0], output: m.content.map((c: JsonObject) => c.text).join("\n") }))] };
  if (api === "openai-completions") return { tools: [{ type: "function", function: { ...tool, parameters: definition.inputSchema } }],
    messages: [...(calls.length ? [{ role: "assistant", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }] : []),
      ...results.map((m) => ({ role: "tool", tool_call_id: m.toolCallId, content: m.content.map((c: JsonObject) => c.text).join("\n") }))] };
  if (api.startsWith("google")) return { config: { tools: [{ functionDeclarations: [{ ...tool, parametersJsonSchema: definition.inputSchema }] }] },
    contents: [...(calls.length ? [{ role: "model", parts: calls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.arguments } })) }] : []),
      { role: "user", parts: results.map((m) => ({ functionResponse: { id: m.toolCallId, name: m.toolName, response: m.isError ? { error: m.content[0].text } : { output: m.content[0].text } } })) }] };
  return { toolConfig: { tools: [{ toolSpec: { ...tool, inputSchema: { json: definition.inputSchema } } }] },
    messages: [...(calls.length ? [{ role: "assistant", content: calls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments } })) }] : []),
      { role: "user", content: results.map((m) => ({ toolResult: { toolUseId: m.toolCallId, status: m.isError ? "error" : "success", content: m.content.map((c: JsonObject) => ({ text: c.text })) } })) }] };
}
export function evidence(messages: JsonObject[] = [assistant, resultMessage]): JsonObject[] {
  return [
    { kind: "tool_inventory", fields: { tools: [definition] } },
    { kind: "tool_call", fields: { call_id: "native-1", name, input: {} } },
    { kind: "server_tool_result", fields: { call_id: "native-1", content, is_error: false } },
    { kind: "model_tool_result", fields: { call_id: "native-1", content, is_error: false } },
    { kind: "model_context", fields: { messages } },
    { kind: "provider_request", fields: { api: "openai-completions", payload: payload("openai-completions", messages) }, t: 1 },
  ];
}
export function source() {
  const records: JsonObject[] = [];
  return { spec: { name: "test" }, calls: [{ relay_index: 1, call_id: "native-1", name: "echo", input: {}, result: { content } }],
    toolDefinitions: [definition], records, record: (kind: string, fields: JsonObject) => { records.push({ kind, fields }); } };
}

describe("Pi final provider payload", () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "google-generative-ai", "google-vertex", "google-gemini-cli", "bedrock-converse-stream"]) {
    test(`${api} requires exact inventory and result text`, () => {
      expect(verifyPiProviderPayload("test", [definition], api, payload(api), [resultMessage])).toEqual(["native-1"]);
      const changed = structuredClone(resultMessage); changed.content[0]!.text = "changed";
      expect(() => verifyPiProviderPayload("test", [definition], api, payload(api), [changed])).toThrow("changed");
      expect(() => verifyPiProviderPayload("test", [{ ...definition, description: "changed" }], api, payload(api), [resultMessage])).toThrow("inventory");
    });
    test(`${api} rejects missing, renamed, or changed provider assistant calls`, () => {
      const messages = [assistant, resultMessage];
      expect(verifyPiProviderPayload("test", [definition], api, payload(api, messages), messages)).toEqual(["native-1"]);
      expect(() => verifyPiProviderPayload("test", [definition], api, payload(api), messages)).toThrow("assistant tool calls");
      for (const change of [{ name: "wrong" }, { arguments: { changed: true } }, { id: "foreign" }]) {
        const altered = { ...assistant, content: [{ ...assistant.content[0], ...change }] };
        expect(() => verifyPiProviderPayload("test", [definition], api, payload(api, [altered, resultMessage]), messages)).toThrow("assistant tool call changed");
      }
    });
  }
  test("invalid serialized call arguments fail before accepting evidence", () => {
    const messages = [assistant, resultMessage];
    const malformed = payload("openai-completions", messages);
    malformed.messages[0].tool_calls[0].function.arguments = "broken";
    expect(() => verifyPiProviderPayload("test", [definition], "openai-completions", malformed, messages)).toThrow("invalid JSON");
    malformed.messages[0].tool_calls[0].function.arguments = {};
    expect(() => verifyPiProviderPayload("test", [definition], "openai-completions", malformed, messages)).toThrow("serialized JSON");
    const google = payload("google-generative-ai", messages);
    delete google.contents[0].parts[0].functionCall.id;
    expect(verifyPiProviderPayload("test", [definition], "google-generative-ai", google, messages)).toEqual(["native-1"]);
  });
  test.each(["anthropic-messages", "openai-completions", "google-generative-ai", "bedrock-converse-stream"])("%s rejects missing or exchanged tool-message roles", (api) => {
    const messages = [assistant, resultMessage];
    for (const index of [0, 1]) for (const role of [undefined, "invalid"]) {
      const changed = payload(api, messages);
      const entries = changed.messages ?? changed.contents;
      if (role === undefined) delete entries[index].role;
      else entries[index].role = role;
      expect(() => verifyPiProviderPayload("test", [definition], api, changed, messages)).toThrow();
    }
  });
  test("compares errors, provider call IDs, mixed images, and response composite IDs", () => {
    const failure = { ...resultMessage, isError: true };
    for (const api of ["anthropic-messages", "google-generative-ai", "bedrock-converse-stream"]) {
      expect(verifyPiProviderPayload("test", [definition], api, payload(api, [failure]), [failure])).toEqual(["native-1"]);
    }
    const image = { type: "image", mimeType: "image/png", data: "AA==" };
    const message = { ...resultMessage, content: [...content, image] };
    const anthropic = payload("anthropic-messages");
    anthropic.messages[0].content[0].content = [...content, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }];
    expect(verifyPiProviderPayload("test", [definition], "anthropic-messages", anthropic, [message])).toEqual(["native-1"]);
    const responses = payload("openai-responses");
    responses.input[0].output = [{ type: "input_text", text: content[0]!.text }, { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AA==" }];
    expect(verifyPiProviderPayload("test", [definition], "openai-responses", responses, [{ ...message, toolCallId: "native-1|item-1" }])).toEqual(["native-1|item-1"]);
    const google = payload("google-generative-ai");
    google.contents[0].parts[0].functionResponse.parts = [{ inlineData: { mimeType: "image/png", data: "AA==" } }];
    delete google.contents[0].parts[0].functionResponse.id;
    expect(verifyPiProviderPayload("test", [definition], "google-generative-ai", { request: google }, [message])).toEqual(["native-1"]);
    const bedrock = payload("bedrock-converse-stream");
    bedrock.messages[0].content[0].toolResult.content.push({ image: { format: "png", source: { bytes: { "0": 0 } } } });
    expect(verifyPiProviderPayload("test", [definition], "bedrock-converse-stream", bedrock, [message])).toEqual(["native-1"]);
    expect(() => verifyPiProviderPayload("test", [definition], "openai-completions", payload("openai-completions"), [message])).toThrow("separates");
  });
  test("fails closed on unknown APIs, missing arrays, result omissions and duplicate IDs", () => {
    expect(() => verifyPiProviderPayload("test", [], "new-api", {}, [])).toThrow("decoder");
    expect(() => verifyPiProviderPayload("test", [], "openai-completions", {}, [])).toThrow("array");
    expect(() => verifyPiProviderPayload("test", [definition], "openai-completions", payload("openai-completions", []), [resultMessage])).toThrow("omitted");
    expect(() => verifyPiProviderPayload("test", [definition], "openai-completions", payload("openai-completions", [resultMessage, resultMessage]), [resultMessage, resultMessage])).toThrow("repeats");
  });
  test.each([null, { content: [] , structuredContent: {} }, { content, isError: "yes" }, { content: [{ type: "text", text: "x", annotations: {} }] }, { content: [{ type: "resource" }] }])("refuses unsupported result %j", (result) => {
    expect(() => assertPiExperimentResult(result)).toThrow();
  });
});

describe("Pi experiment evidence joins", () => {
  test("matches relay IDs, model context, final payloads, stdout and terminal evidence", () => {
    const s = source(); const events = evidence(); events.push(events.at(-1)!);
    verifyPiExperimentEvidence(s, events, stdout);
    expect(s.records.filter((r) => r.kind === "tool_result_delivered")).toEqual([{ kind: "tool_result_delivered", fields: { call_id: "native-1", t: 1 } }]);
  });
  test.each([
    ["inventory", (r: JsonObject[]) => { r[0]!.fields.tools = []; }],
    ["duplicate inventory", (r: JsonObject[]) => { r.push(r[0]!); }],
    ["call identity", (r: JsonObject[]) => { r[1]!.fields.input = { changed: true }; }],
    ["duplicate call", (r: JsonObject[]) => { r.push(r[1]!); }],
    ["server bytes", (r: JsonObject[]) => { r[2]!.fields.content = []; }],
    ["context bytes", (r: JsonObject[]) => { r[4]!.fields.messages[1].content = []; }],
    ["context shape", (r: JsonObject[]) => { r[4]!.fields.messages = {}; }],
    ["missing context call", (r: JsonObject[]) => { r[4]!.fields.messages.shift(); }],
    ["altered provider call", (r: JsonObject[]) => { r[5]!.fields.payload.messages[0].tool_calls[0].function.name = "wrong"; }],
    ["missing provider call", (r: JsonObject[]) => { r[5]!.fields.payload.messages.shift(); }],
    ["missing context", (r: JsonObject[]) => { r.splice(4, 1); }],
    ["unknown event", (r: JsonObject[]) => { r.push({ kind: "unknown", fields: {} }); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const records = structuredClone(evidence()); mutate(records);
    expect(() => verifyPiExperimentEvidence(source(), records, stdout)).toThrow();
  });
  test("requires relay completeness, inventory, terminal and unique stdout declarations", () => {
    expect(() => verifyPiExperimentEvidence({ ...source(), toolDefinitions: [] }, [], stdout)).toThrow("inventory");
    expect(() => verifyPiExperimentEvidence({ ...source(), calls: [{ relay_index: 1, name: "echo", input: {} }] }, [], stdout)).toThrow("incomplete");
    expect(() => verifyPiExperimentEvidence(source(), evidence(), "")).toThrow("terminal");
    expect(() => verifyPiExperimentEvidence(source(), evidence(), stdout + stdout)).toThrow("repeats");
  });
});
