import { describe, expect, test } from "bun:test";
import { toAnthropicRequest } from "../src/complete/anthropic-request.js";
import { AnthropicStreamTranslator, finishReason, fromAnthropicAnswer } from "../src/complete/anthropic-response.js";
import { CompleteError } from "../src/complete/errors.js";
import { ANTHROPIC_ANSWER, ANTHROPIC_STREAM } from "./helpers/complete-fakes.js";

const TOOLS = [{
  type: "function",
  function: { name: "read_mail", description: "Read a folder", parameters: { type: "object", properties: { folder: { type: "string" } } } },
}];

function refusal(request: Record<string, unknown>): CompleteError {
  try {
    toAnthropicRequest(request);
  } catch (error) {
    if (error instanceof CompleteError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const base = { model: "claude-sonnet-4-5", max_tokens: 256, messages: [{ role: "user", content: "hi" }] };

describe("OpenAI request -> Anthropic Messages", () => {
  test("an eA-shaped agent exchange maps field for field", () => {
    const out = toAnthropicRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      temperature: 0,
      top_p: 0.9,
      stop: "END",
      user: "run-7",
      tools: TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: false,
      messages: [
        { role: "system", content: "You are a mail agent." },
        { role: "developer", content: [{ type: "text", text: "Be brief." }] },
        { role: "user", content: "Archive the inbox." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_0_0", type: "function", function: { name: "read_mail", arguments: "{\"folder\":\"inbox\"}" } }] },
        { role: "tool", tool_call_id: "call_0_0", content: "3 messages" },
        { role: "user", content: "Continue." },
      ],
    });
    expect(out).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      system: [{ type: "text", text: "You are a mail agent." }, { type: "text", text: "Be brief." }],
      temperature: 0,
      top_p: 0.9,
      stop_sequences: ["END"],
      metadata: { user_id: "run-7" },
      tools: [{ name: "read_mail", description: "Read a folder", input_schema: TOOLS[0]!.function.parameters }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      service_tier: "standard_only",
      messages: [
        { role: "user", content: [{ type: "text", text: "Archive the inbox." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_0_0", name: "read_mail", input: { folder: "inbox" } }] },
        // The tool result and the next user turn merge into one user turn.
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_0_0", content: "3 messages" },
          { type: "text", text: "Continue." },
        ] },
      ],
    });
  });

  test("tool_choice, images, max_completion_tokens, stream, and no-op values map", () => {
    expect(toAnthropicRequest({ ...base, tool_choice: "none" })["tool_choice"]).toEqual({ type: "none" });
    expect(toAnthropicRequest({ ...base, tool_choice: "required" })["tool_choice"]).toEqual({ type: "any" });
    expect(toAnthropicRequest({ ...base, tools: TOOLS, tool_choice: { type: "function", function: { name: "x" } }, parallel_tool_calls: true })["tool_choice"])
      .toEqual({ type: "tool", name: "x", disable_parallel_tool_use: false });
    expect(toAnthropicRequest({ ...base, max_tokens: undefined, max_completion_tokens: 9 })["max_tokens"]).toBe(9);
    expect(toAnthropicRequest({ ...base, stream: true, stream_options: { include_usage: true } })["stream"]).toBe(true);
    expect(toAnthropicRequest({ ...base, n: 1, store: false, seed: null, frequency_penalty: 0, presence_penalty: 0, logprobs: false, response_format: { type: "text" } }))
      .toEqual({ model: base.model, max_tokens: 256, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], service_tier: "standard_only" });
    const images = toAnthropicRequest({ ...base, messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "auto" } },
    ] }] })["messages"] as { content: unknown[] }[];
    expect(images[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
    ]);
    const toolText = toAnthropicRequest({ ...base, messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ] })["messages"] as { content: unknown[] }[];
    expect(toolText[1]!.content[0]).toEqual({ type: "text", text: "ok" });
    expect(toolText[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "c", content: "ab" }]);
    // A tool without parameters gets the empty object schema.
    expect((toAnthropicRequest({ ...base, tools: [{ type: "function", function: { name: "noop" } }] })["tools"] as unknown[])[0])
      .toEqual({ name: "noop", input_schema: { type: "object", properties: {} } });
  });

  test("every field that cannot map is refused, naming it", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, seed: 7 }, "seed"],
      [{ ...base, n: 2 }, "n="],
      [{ ...base, logit_bias: { "1": 2 } }, "logit_bias"],
      [{ ...base, response_format: { type: "json_object" } }, "response_format"],
      [{ ...base, frequency_penalty: 0.5 }, "frequency_penalty"],
      [{ ...base, temperature: 1.5 }, "temperature"],
      [{ ...base, max_tokens: undefined }, "max_tokens"],
      [{ ...base, tool_choice: "sometimes" }, "tool_choice"],
      [{ ...base, tool_choice: "none", parallel_tool_calls: false }, "parallel_tool_calls"],
      [{ ...base, tools: [{ type: "web_search" }] }, "tools[0]"],
      [{ ...base, tools: [{ type: "function", function: { name: "f", strict: true } }] }, "strict"],
      [{ ...base, messages: [{ role: "user", content: "a" }, { role: "system", content: "late" }] }, "after the conversation"],
      [{ ...base, messages: [{ role: "user", content: "a", name: "bob" }] }, "name"],
      [{ ...base, messages: [{ role: "function", content: "a" }] }, "role"],
      [{ ...base, messages: [{ role: "user", content: [{ type: "input_audio" }] }] }, "input_audio"],
      [{ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "ftp://x" } }] }] }, "data: or http"],
      [{ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x", detail: "high" } }] }] }, "detail"],
      [{ ...base, messages: [{ role: "assistant", content: null }] }, "empty"],
      [{ ...base, messages: [{ role: "assistant", content: "x", refusal: "no" }] }, "refusal"],
      [{ ...base, messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "[1]" } }] }] }, "JSON object"],
      [{ ...base, messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{" } }] }] }, "JSON object"],
      [{ ...base, messages: [{ role: "assistant", content: null, tool_calls: [{ type: "custom" }] }] }, "function tool call"],
    ];
    for (const [request, needle] of cases) {
      const error = refusal(request);
      expect(error.status).toBe(400);
      expect(error.message).toContain(needle);
    }
  });

  test("malformed shapes are bad requests", () => {
    const cases: Record<string, unknown>[] = [
      { ...base, model: "" },
      { ...base, messages: [] },
      { ...base, messages: ["x"] },
      { ...base, messages: [{ role: "system", content: "only system" }] },
      { ...base, messages: [{ role: "user", content: 5 }] },
      { ...base, messages: [{ role: "user", content: [7] }] },
      { ...base, messages: [{ role: "tool", content: "x" }] },
      { ...base, messages: [{ role: "assistant", content: null, tool_calls: "x" }] },
      { ...base, messages: [{ role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: 1 } }] }] },
      { ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: 3 } }] }] },
      { ...base, stop: [1] },
      { ...base, tools: "x" },
      { ...base, tools: [{ type: "function", function: { name: 3 } }] },
      { ...base, parallel_tool_calls: "yes" },
      { ...base, user: 3 },
      { ...base, max_tokens: 5, max_completion_tokens: 6 },
    ];
    for (const request of cases) {
      const error = refusal(request);
      expect(error.status).toBe(400);
    }
  });
});

describe("Anthropic answer -> OpenAI chat completion", () => {
  test("text and tool_use blocks become content and tool_calls with the same ids", () => {
    const out = fromAnthropicAnswer(ANTHROPIC_ANSWER, 1700000000);
    expect(out.body).toEqual({
      anthropic: ANTHROPIC_ANSWER,
      id: "msg_1",
      object: "chat.completion",
      created: 1700000000,
      model: "claude-sonnet-4-5-20250929",
      choices: [{
        index: 0,
        logprobs: null,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Reading the inbox.",
          refusal: null,
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read_mail", arguments: "{\"folder\":\"inbox\"}" } }],
        },
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300, prompt_tokens_details: { cached_tokens: 200 } },
    });
    expect(out.usage).toEqual({ input: 1000, cacheRead: 200, cacheWrite: 0, output: 100, reportedCostUsd: null });
  });

  test("stop reasons map, and one with no equivalent is a 502", () => {
    expect(finishReason("end_turn")).toBe("stop");
    expect(finishReason("stop_sequence")).toBe("stop");
    expect(finishReason("max_tokens")).toBe("length");
    expect(finishReason("refusal")).toBe("content_filter");
    expect(finishReason("pause_turn")).toBe("stop");
    expect(() => finishReason("unknown_reason")).toThrow(CompleteError);
    expect(() => fromAnthropicAnswer({ ...ANTHROPIC_ANSWER, content: [{ type: "thinking", thinking: "x" }] }, 0)).toThrow("thinking");
    expect(() => fromAnthropicAnswer({ ...ANTHROPIC_ANSWER, content: "x" }, 0)).toThrow("content array");
    // A text-free answer keeps content null, as OpenAI does.
    const empty = fromAnthropicAnswer({ ...ANTHROPIC_ANSWER, content: [], stop_reason: "end_turn" }, 0);
    expect((empty.body["choices"] as { message: { content: unknown } }[])[0]!.message.content).toBeNull();
  });

  test("the stream translator emits OpenAI chunks and folds cumulative usage", () => {
    const translator = new AnthropicStreamTranslator(5, true);
    const chunks = ANTHROPIC_STREAM.flatMap((event) => translator.translate(event));
    const deltas = chunks.flatMap((chunk) => (chunk["choices"] as { delta: unknown; finish_reason: unknown }[]));
    expect(deltas[0]!.delta).toEqual({ role: "assistant", content: "", refusal: null });
    expect(deltas[1]!.delta).toEqual({ content: "Hi" });
    expect(deltas[2]!.delta).toEqual({ tool_calls: [{ index: 0, id: "toolu_2", type: "function", function: { name: "read_mail", arguments: "" } }] });
    expect(deltas[3]!.delta).toEqual({ tool_calls: [{ index: 0, function: { arguments: "{\"folder\":" } }] });
    expect(deltas[4]!.delta).toEqual({ tool_calls: [{ index: 0, function: { arguments: "\"inbox\"}" } }] });
    expect(deltas[5]!.finish_reason).toBe("tool_calls");
    const last = chunks[chunks.length - 1]!;
    expect(last["choices"]).toEqual([]);
    expect(last["usage"]).toEqual({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, prompt_tokens_details: { cached_tokens: 0 } });
    expect(chunks.every((chunk) => chunk["id"] === "msg_2" && chunk["model"] === "claude-sonnet-4-5-20250929")).toBe(true);
    expect(translator.finish).toBe("tool_calls");
    // Without include_usage, message_stop is still preserved after the finish.
    const quiet = new AnthropicStreamTranslator(5, false);
    const quietChunks = ANTHROPIC_STREAM.flatMap((event) => quiet.translate(event));
    expect(quietChunks.some((chunk) => "usage" in chunk)).toBe(false);
    expect(quietChunks.at(-1)).toMatchObject({ choices: [], anthropic: { type: "message_stop" } });
    expect(quietChunks.filter((chunk) => (chunk["anthropic"] as { type: string }).type === "content_block_stop"))
      .toHaveLength(2);
  });

  test("the stream translator refuses what it cannot map", () => {
    const translator = new AnthropicStreamTranslator(0, false);
    translator.translate(ANTHROPIC_STREAM[0]!);
    expect(translator.translate({ type: "content_block_start", index: 0, content_block: { type: "text", text: "pre" } }))
      .toHaveLength(1);
    expect(() => translator.translate({ type: "content_block_start", index: 1, content_block: { type: "thinking" } })).toThrow("thinking");
    expect(() => translator.translate({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } })).toThrow("thinking_delta");
    expect(() => translator.translate({ type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: "" } })).toThrow("not a tool_use");
    expect(() => translator.translate({ type: "error", error: { message: "overloaded" } })).toThrow("overloaded");
    expect(() => translator.translate({ type: "mystery" })).toThrow("mystery");
  });
});
