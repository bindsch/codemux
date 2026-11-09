import type { ExperimentRelayCall } from "../../../src/experiment-relay.js";
import type { JsonObject } from "../../../src/experiment-server.js";

export const definitions = [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
export const call = (): ExperimentRelayCall => ({ relay_index: 0, call_id: "call-1", name: "echo", input: { text: "unchanged" },
  result: { content: [{ type: "text", text: "unchanged" }] } });
export const payload = (kind = "chat", results = true): JsonObject => {
  const schema = { ...definitions[0]!.inputSchema, additionalProperties: false };
  if (kind === "chat") return { tools: [{ type: "function", function: { name: "test_echo", description: "Echo", parameters: schema } }],
    messages: results ? [{ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "test_echo", arguments: '{"text":"unchanged"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "unchanged" }] : [{ role: "user", content: "prompt" }] };
  if (kind === "responses") return { tools: [{ type: "function", name: "test_echo", description: "Echo", parameters: schema }],
    input: results ? [{ type: "function_call", call_id: "call-1", name: "test_echo", arguments: '{"text":"unchanged"}' },
      { type: "function_call_output", call_id: "call-1", output: "unchanged" }] : [] };
  return { tools: [{ name: "test_echo", description: "Echo", input_schema: schema }], messages: [{ role: "assistant", content: results ?
    [{ type: "tool_use", id: "call-1", name: "test_echo", input: { text: "unchanged" } }] : [] },
    { role: "user", content: results ? [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "unchanged" }] }] : [] }] };
};
export const stdout = (isError = false): string => [
  { type: "tool_use", timestamp: 1000, sessionID: "ses_0123456789abcdef", part: { id: "part-1", messageID: "msg1", callID: "call-1", tool: "test_echo",
    state: { status: isError ? "error" : "completed", input: { text: "unchanged" }, [isError ? "error" : "output"]: "unchanged" } } },
  { type: "step_finish", timestamp: 2000, sessionID: "ses_0123456789abcdef", part: { messageID: "msg1", reason: "tool-calls", cost: 0,
    tokens: { input: 10, output: 3, cache: { read: 2, write: 1 } } } },
  { type: "text", timestamp: 3000, sessionID: "ses_0123456789abcdef", part: { text: "done" } },
  { type: "step_finish", timestamp: 4000, sessionID: "ses_0123456789abcdef", part: { messageID: "msg2", reason: "stop", cost: 0,
    tokens: { input: 12, output: 1, cache: { read: 0, write: 0 } } } },
].map((event) => JSON.stringify(event) + "\n").join("");
export function evidence(): JsonObject[] {
  return [
    { kind: "model_turn", fields: { request_id: "1", session_id: "ses_0123456789abcdef" }, t: 1 },
    { kind: "provider_request", fields: { request_id: "1", payload: payload("chat", false) }, t: 2 },
    { kind: "provider_response", fields: { request_id: "1", status: 200 }, t: 3 },
    { kind: "tool_call", fields: { call_id: "call-1", name: "test_echo", input: { text: "unchanged" }, session_id: "ses_0123456789abcdef" }, t: 4 },
    { kind: "model_turn", fields: { request_id: "2", session_id: "ses_0123456789abcdef" }, t: 5 },
    { kind: "provider_request", fields: { request_id: "2", payload: payload() }, t: 6 },
    { kind: "provider_response", fields: { request_id: "2", status: 200 }, t: 7 },
  ];
}
export function source() {
  const records: JsonObject[] = [];
  return { spec: { name: "test" }, calls: [call()], toolDefinitions: definitions,
    record: (kind: string, fields: JsonObject) => { records.push({ kind, fields }); }, records };
}
