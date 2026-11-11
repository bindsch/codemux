import { describe, expect, test } from "bun:test";
import { assertQwenExperimentResult, qwenExperimentCalls, qwenExperimentToolName, verifyQwenExperimentEvidence } from "../src/qwen-experiment-content.js";
import type { JsonObject } from "../src/experiment-server.js";

const session = "507e1e7c-a25c-4d53-8d5d-f0b929f24a8d";
const name = "mcp__test__echo";
const definition = { name: "echo", description: "Exact echo", inputSchema: {
  type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
} };
const text = " exact\nbytes \t";
const input = { text: "input" };
const content = [{ type: "text", text }];
const call = { id: "call-1", type: "function", function: { name, arguments: JSON.stringify(input) } };
const assistant = { type: "assistant", session_id: session, parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "tool_use", id: "call-1", name, input }] } };
const completion = { type: "user", session_id: session, parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "display only" }] } };
const terminal = { type: "result", session_id: session, subtype: "success", is_error: false, permission_denials: [] };

function stdout(events: JsonObject[] = [assistant, completion, terminal]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function source() {
  const emitted: JsonObject[] = [];
  return { spec: { name: "test" }, toolDefinitions: structuredClone([definition]),
    calls: [{ relay_index: 1, call_id: "call-1", name: "echo", input: structuredClone(input), result: { content: structuredClone(content) } }],
    record: (kind: string, fields: JsonObject) => { emitted.push({ kind, fields }); }, emitted };
}

function evidence(): JsonObject[] {
  const tools = [{ type: "function", function: { name, description: definition.description, parameters: definition.inputSchema } }];
  const log = (id: string, messages: JsonObject[], responseMessage: JsonObject, finish: string): JsonObject => ({
    timestamp: "2026-11-09T12:00:00.000Z", error: null, context: { sessionId: session, promptId: `${session}########0` },
    request: { model: "qwen3-coder-plus", stream: true, tools, messages },
    response: { id, object: "chat.completion", model: "qwen3-coder-plus", choices: [{ index: 0, message: responseMessage, finish_reason: finish }] },
  });
  return structuredClone([
    log("response-1", [{ role: "user", content: "call echo" }], { role: "assistant", content: null, tool_calls: [call] }, "tool_calls"),
    log("response-2", [{ role: "user", content: "call echo" }, { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: "call-1", content }], { role: "assistant", content: "complete" }, "stop"),
  ]);
}

function reject(mutator: (logs: JsonObject[], src: ReturnType<typeof source>, events: JsonObject[]) => void, message?: string): void {
  const logs = evidence(), src = source(), events = structuredClone([assistant, completion, terminal]);
  mutator(logs, src, events);
  expect(() => verifyQwenExperimentEvidence(src, logs, stdout(events))).toThrow(message);
}

describe("Qwen native names and result boundary", () => {
  test("tails complete assistant frames without parsing a partial final frame", () => {
    expect(qwenExperimentCalls(stdout() + "{partial")).toEqual([{ id: "call-1", name, input }]);
    expect(qwenExperimentCalls("{partial")).toEqual([]);
    expect(qwenExperimentCalls(stdout([{ ...assistant, message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }]))).toEqual([]);
  });
  test("rejects malformed, repeated, or unidentifiable complete call frames", () => {
    for (const value of ["{broken}\n", stdout([assistant, assistant]), stdout([{ ...assistant, message: {} }]),
      stdout([{ ...assistant, parent_tool_use_id: "parent" }]),
      stdout([{ ...assistant, message: { role: "assistant", content: [{ type: "tool_use", id: "", name, input }] } }]),
    ]) expect(() => qwenExperimentCalls(value)).toThrow();
  });
  test("retains provider-safe names and deterministically bounds changed names", () => {
    expect(qwenExperimentToolName("test", "echo-name")).toBe("mcp__test__echo-name");
    const long = qwenExperimentToolName("test", "x".repeat(70));
    expect(long).toHaveLength(63);
    expect(long).toMatch(/^mcp__test__x+_[a-z0-9]{7}$/);
    expect(qwenExperimentToolName("test", "a.b")).toMatch(/^mcp__test__a_b_[a-z0-9]{7}$/);
    expect(qwenExperimentToolName("test", "a.b")).not.toBe(qwenExperimentToolName("test", "a_b"));
    expect(qwenExperimentToolName("test", "x".repeat(70))).toBe(long);
  });
  test("preserves one text block including empty text and the native limit", () => {
    for (const value of ["", text, "x".repeat(500_000)]) expect(() => assertQwenExperimentResult({ content: [{ type: "text", text: value }], isError: false })).not.toThrow();
  });
  test.each([null, [], {}, { content: [] }, { content: [...content, ...content] }, { content, isError: true },
    { content, isError: "false" }, { content, structuredContent: {} }, { content, _meta: {} },
    { content: [null] }, { content: [{ type: "image", data: "AA==" }] }, { content: [{ type: "text", text: 1 }] },
    { content: [{ type: "text", text, annotations: {} }] }, { content: [{ type: "text", text: "x".repeat(500_001) }] },
  ].map((result) => [result]))("refuses transformed native result %#", (result) => {
    expect(() => assertQwenExperimentResult(result)).toThrow();
  });
});

describe("Qwen captured OpenAI experiment evidence", () => {
  test("joins stream IDs, exact provider inventory, response calls and delivered bytes", () => {
    const src = source();
    verifyQwenExperimentEvidence(src, evidence(), stdout());
    expect(src.emitted.filter((event) => event.kind === "tool_result_delivered")).toEqual([
      { kind: "tool_result_delivered", fields: { call_id: "call-1", t: Date.parse("2026-11-09T12:00:00.000Z") / 1000 } },
    ]);
    expect(src.emitted.filter((event) => event.kind === "qwen_provider_request")).toHaveLength(2);
    expect(src.emitted.find((event) => event.kind === "model_tool_result")!.fields.output).toBe(text);
  });
  test("accepts native string format and empty text without trusting display output", () => {
    for (const value of [text, ""]) {
      const src = source(), logs = evidence();
      src.calls[0]!.result.content[0]!.text = value;
      logs[1]!.request.messages[2].content = value;
      verifyQwenExperimentEvidence(src, logs, stdout());
    }
  });
  test("counts repeated context delivery once and accepts unordered log files", () => {
    const src = source(), logs = evidence();
    const repeated = structuredClone(logs[1]!); repeated.response.id = "response-3";
    verifyQwenExperimentEvidence(src, [repeated, ...logs.reverse()], stdout());
    expect(src.emitted.filter((event) => event.kind === "tool_result_delivered")).toHaveLength(1);
  });
  test("accepts empty-description schema identity and a zero-call completed run", () => {
    const src = source(), logs = evidence();
    delete (src.toolDefinitions[0] as JsonObject).description;
    for (const log of logs) log.request.tools[0].function.description = "";
    verifyQwenExperimentEvidence(src, logs, stdout());
    src.calls = [];
    logs[0]!.response.choices[0] = { message: { role: "assistant", content: "hello" }, finish_reason: "stop" };
    verifyQwenExperimentEvidence(src, [logs[0]!], stdout([terminal]));
  });
  test("allows non-tool auxiliary logs and native text/thinking/system events", () => {
    const src = source(), logs = evidence();
    const auxiliary = structuredClone(logs[0]!);
    auxiliary.context = { promptId: "title-generation" };
    auxiliary.request.stream = false;
    auxiliary.request.tools = [];
    auxiliary.response.id = "auxiliary";
    auxiliary.response.choices[0] = { message: { role: "assistant", content: "Title" }, finish_reason: "stop" };
    const events = [{ type: "system", session_id: session }, { type: "stream_event", session_id: session },
      { type: "user", session_id: session, message: { role: "user", content: "prompt" } },
      { type: "assistant", session_id: session, message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: "thought" }] } },
      assistant, completion, terminal];
    verifyQwenExperimentEvidence(src, [...logs, auxiliary], stdout(events));
    expect(src.emitted.some((event) => event.kind === "qwen_auxiliary_request")).toBe(true);
  });
  test.each([
    ["missing tools", (logs: JsonObject[]) => { delete logs[0]!.request.tools; }],
    ["foreign tool", (logs: JsonObject[]) => { logs[0]!.request.tools.push({ type: "function", function: { name: "shell" } }); }],
    ["renamed tool", (logs: JsonObject[]) => { logs[0]!.request.tools[0].function.name = "other"; }],
    ["description", (logs: JsonObject[]) => { logs[0]!.request.tools[0].function.description = "changed"; }],
    ["pruned schema", (logs: JsonObject[]) => { delete logs[0]!.request.tools[0].function.parameters.additionalProperties; }],
    ["omitted schema", (logs: JsonObject[]) => { delete logs[0]!.request.tools[0].function.parameters; }],
    ["strict addition", (logs: JsonObject[]) => { logs[0]!.request.tools[0].function.strict = true; }],
  ] as const)("rejects changed inventory: %s", (_label, mutate) => reject(mutate, "inventory"));
  test.each([
    ["no inventory", (_logs: JsonObject[], src: ReturnType<typeof source>) => { src.toolDefinitions = []; }],
    ["bad metadata", (_logs: JsonObject[], src: ReturnType<typeof source>) => { (src.toolDefinitions[0] as JsonObject).description = 1; }],
    ["duplicate names", (_logs: JsonObject[], src: ReturnType<typeof source>) => { src.toolDefinitions.push(src.toolDefinitions[0]!); }],
    ["bad schema", (_logs: JsonObject[], src: ReturnType<typeof source>) => { (src.toolDefinitions[0] as JsonObject).inputSchema = null; }],
    ["missing relay result", (_logs: JsonObject[], src: ReturnType<typeof source>) => { delete (src.calls[0] as JsonObject).result; }],
    ["missing relay ID", (_logs: JsonObject[], src: ReturnType<typeof source>) => { delete (src.calls[0] as JsonObject).call_id; }],
    ["duplicate relay ID", (_logs: JsonObject[], src: ReturnType<typeof source>) => { src.calls.push(src.calls[0]!); }],
    ["unknown relay name", (_logs: JsonObject[], src: ReturnType<typeof source>) => { src.calls[0]!.name = "foreign"; }],
  ] as const)("rejects incomplete source: %s", (_label, mutate) => reject(mutate));
  test.each([
    ["changed input", (logs: JsonObject[]) => { logs[0]!.response.choices[0].message.tool_calls[0].function.arguments = "{}"; }],
    ["unknown response call", (logs: JsonObject[]) => { logs[0]!.response.choices[0].message.tool_calls[0].id = "foreign"; }],
    ["malformed arguments", (logs: JsonObject[]) => { logs[0]!.response.choices[0].message.tool_calls[0].function.arguments = "{"; }],
    ["nonserialized arguments", (logs: JsonObject[]) => { logs[0]!.response.choices[0].message.tool_calls[0].function.arguments = {}; }],
    ["duplicate response call", (logs: JsonObject[]) => { logs[0]!.response.choices[0].message.tool_calls.push(call); }],
    ["wrong call role", (logs: JsonObject[]) => { logs[1]!.request.messages[1].role = "user"; }],
    ["unknown role", (logs: JsonObject[]) => { logs[1]!.request.messages[0].role = "unknown"; }],
    ["legacy function", (logs: JsonObject[]) => { logs[1]!.request.messages[0].function_call = { name: "shell" }; }],
    ["legacy response function", (logs: JsonObject[]) => { logs[1]!.response.choices[0].message.function_call = { name: "shell" }; }],
    ["invalid call shape", (logs: JsonObject[]) => { logs[1]!.request.messages[1].tool_calls = {}; }],
    ["duplicate context call", (logs: JsonObject[]) => { logs[1]!.request.messages[1].tool_calls.push(call); }],
    ["missing provider call", (logs: JsonObject[]) => { logs[1]!.request.messages.splice(1, 1); }],
    ["result before call", (logs: JsonObject[]) => { logs[1]!.request.messages.reverse(); }],
    ["changed result bytes", (logs: JsonObject[]) => { logs[1]!.request.messages[2].content = text.trim(); }],
    ["wrong result role", (logs: JsonObject[]) => { logs[1]!.request.messages[2].role = "user"; }],
    ["duplicate result", (logs: JsonObject[]) => { logs[1]!.request.messages.push(logs[1]!.request.messages[2]); }],
    ["missing result", (logs: JsonObject[]) => { logs[1]!.request.messages.pop(); }],
    ["missing producing response", (logs: JsonObject[]) => { logs.shift(); }],
    ["missing delivery request", (logs: JsonObject[]) => { logs.pop(); }],
  ] as const)("rejects incomplete native joins: %s", (_label, mutate) => reject(mutate));
  test.each([
    ["failed request", (logs: JsonObject[]) => { logs[0]!.error = { message: "failed" }; }],
    ["reconstructed fallback", (logs: JsonObject[]) => { delete logs[0]!.request.stream; }],
    ["nonstreaming main", (logs: JsonObject[]) => { logs[0]!.request.stream = false; }],
    ["no messages", (logs: JsonObject[]) => { delete logs[0]!.request.messages; }],
    ["missing response", (logs: JsonObject[]) => { delete logs[0]!.response; }],
    ["missing choices", (logs: JsonObject[]) => { logs[0]!.response.choices = []; }],
    ["no model", (logs: JsonObject[]) => { delete logs[0]!.request.model; }],
    ["duplicate response", (logs: JsonObject[]) => { logs.push(logs[0]!); }],
    ["missing timestamp", (logs: JsonObject[]) => { delete logs[0]!.timestamp; }],
    ["impossible calendar date", (logs: JsonObject[]) => { logs[0]!.timestamp = "2026-02-30T00:00:00Z"; }],
    ["unfinished response", (logs: JsonObject[]) => { logs[0]!.response.choices[0].finish_reason = null; }],
    ["failed response role", (logs: JsonObject[]) => { logs[0]!.response.choices[0].message.role = "user"; }],
    ["missing prompt", (logs: JsonObject[]) => { delete logs[0]!.context.promptId; }],
    ["wrong session", (logs: JsonObject[]) => { logs[0]!.context.sessionId = "foreign"; }],
    ["foreign prompt", (logs: JsonObject[]) => { logs[0]!.context.promptId = "foreign"; }],
    ["empty logs", (logs: JsonObject[]) => { logs.length = 0; }],
  ] as const)("rejects unsettled logs: %s", (_label, mutate) => reject(mutate));
  test.each([
    ["missing terminal", (events: JsonObject[]) => { events.pop(); }],
    ["after terminal", (events: JsonObject[]) => { events.push(assistant); }],
    ["missing session", (events: JsonObject[]) => { delete events[0]!.session_id; }],
    ["wrong session", (events: JsonObject[]) => { events[1]!.session_id = "foreign"; }],
    ["subagent", (events: JsonObject[]) => { events[0]!.parent_tool_use_id = "parent"; }],
    ["wrong message role", (events: JsonObject[]) => { events[0]!.message.role = "user"; }],
    ["missing content", (events: JsonObject[]) => { delete events[0]!.message.content; }],
    ["wrong tool role", (events: JsonObject[]) => { events[0]!.type = "user"; events[0]!.message.role = "user"; }],
    ["duplicate native use", (events: JsonObject[]) => { events.splice(1, 0, assistant); }],
    ["failed result", (events: JsonObject[]) => { events[1]!.message.content[0].is_error = true; }],
    ["missing result", (events: JsonObject[]) => { events.splice(1, 1); }],
    ["unknown block", (events: JsonObject[]) => { events[0]!.message.content.push({ type: "unknown" }); }],
    ["failed terminal", (events: JsonObject[]) => { events[2]!.is_error = true; }],
    ["permission denial", (events: JsonObject[]) => { events[2]!.permission_denials = [{}]; }],
    ["unknown event", (events: JsonObject[]) => { events[0]!.type = "unknown"; }],
  ] as const)("rejects invalid stdout: %s", (_label, mutate) => reject((_logs, _src, events) => mutate(events)));
  test("rejects malformed and incomplete stdout lines", () => {
    for (const output of ["", stdout().trimEnd(), "{broken}\n", "null\n"]) {
      expect(() => verifyQwenExperimentEvidence(source(), evidence(), output)).toThrow();
    }
  });
});
