/** Tables follow the SDK commits cited in openai-response.ts and anthropic-shape.ts. */
import { describe, expect, test } from "bun:test";
import { openAIChoices, OpenAIStreamShape } from "../src/complete/openai-response.js";
import { AnthropicStreamTranslator, fromAnthropicAnswer } from "../src/complete/anthropic-response.js";
import { usageFromAnthropic, usageFromOpenAI } from "../src/complete/usage.js";
import { ANTHROPIC_ANSWER, OPENAI_ANSWER } from "./helpers/complete-fakes.js";

type Json = Record<string, unknown>;
const functionCall = { name: "f", arguments: "{}" };
const tools = [
  { id: "", type: "function", function: functionCall },
  { id: "c", type: "custom", custom: { name: "python", input: "print(1)" } },
];
const audio = { id: "a", data: "AAAA", transcript: "hi", expires_at: 1 };
const annotation = { type: "url_citation", url_citation: { start_index: 0, end_index: 1, title: "title", url: "https://example.test" } };
const logprob = { token: "a", logprob: -1, bytes: [97], top_logprobs: [{ token: "a", logprob: -1, bytes: [97] }] };
const moderation = {
  input: { type: "error", code: "unavailable", message: "unavailable" },
  output: { type: "moderation_results", model: "moderation", results: [] },
};
const message = (fields: Json = {}) => ({ role: "assistant", ...fields });
const answer = (fields: Json = {}) => ({ ...OPENAI_ANSWER, choices: [{ index: 0, finish_reason: "stop", message: message(fields) }] });
const chunk = (delta: Json = {}, fields: Json = {}) => ({
  id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
  choices: [{ index: 0, delta }], ...fields,
});

describe("OpenAI published optional and nullable fields", () => {
  const fields: [string, unknown, (value: unknown) => Json, boolean][] = [];
  for (const [field, value] of Object.entries({ content: "", refusal: "no", annotations: [annotation], audio, function_call: functionCall, tool_calls: tools })) {
    fields.push([`message.${field}`, value, (v) => answer({ [field]: v }), false]);
  }
  for (const [field, value] of Object.entries({ content: "", refusal: "no", role: "assistant", audio, function_call: functionCall, tool_calls: [{ index: 0, ...tools[0] }] })) {
    fields.push([`delta.${field}`, value, (v) => chunk({ [field]: v }), true]);
  }
  for (const [field, value] of Object.entries({ metadata: { study: "test" }, moderation, service_tier: "default", system_fingerprint: "fp", usage: OPENAI_ANSWER.usage })) {
    fields.push([`completion.${field}`, value, (v) => ({ ...answer(), [field]: v }), false]);
    if (field !== "metadata") fields.push([`chunk.${field}`, value, (v) => chunk({}, { [field]: v }), true]);
  }
  fields.push(["chunk.obfuscation", "abc", (v) => chunk({}, { obfuscation: v }), true]);
  fields.push(["chunk.choice.finish_reason", "stop", (v) => chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: v }] }), true]);
  for (const stream of [false, true]) {
    const makeChoice = (fields: Json) => stream
      ? chunk({}, { choices: [{ index: 0, delta: {}, ...fields }] })
      : { ...answer(), choices: [{ index: 0, message: message(), finish_reason: "stop", ...fields }] };
    fields.push([`${stream ? "chunk" : "completion"}.choice.logprobs`, { content: [logprob], refusal: null }, (v) => makeChoice({ logprobs: v }), stream]);
    for (const field of ["content", "refusal"]) {
      fields.push([`${stream ? "chunk" : "completion"}.logprobs.${field}`, [logprob], (v) => makeChoice({ logprobs: { [field]: v } }), stream]);
    }
    fields.push([`${stream ? "chunk" : "completion"}.token.bytes`, [97],
      (v) => makeChoice({ logprobs: { content: [{ ...logprob, bytes: v }] } }), stream]);
    fields.push([`${stream ? "chunk" : "completion"}.top_logprob.bytes`, [97],
      (v) => makeChoice({ logprobs: { content: [{ ...logprob, top_logprobs: [{ token: "a", logprob: -1, bytes: v }] }] } }), stream]);
  }
  for (const [field, value] of Object.entries(audio)) {
    fields.push([`delta.audio.${field}`, value, (v) => chunk({ audio: { [field]: v } }), true]);
  }
  for (const field of ["name", "arguments"]) {
    fields.push([`delta.function_call.${field}`, "x", (v) => chunk({ function_call: { [field]: v } }), true]);
    fields.push([`delta.tool.function.${field}`, "x", (v) => chunk({ tool_calls: [{ index: 0, function: { [field]: v } }] }), true]);
  }
  for (const [field, value] of Object.entries({ id: "c", type: "function", function: functionCall })) {
    fields.push([`delta.tool.${field}`, value, (v) => chunk({ tool_calls: [{ index: 0, [field]: v }] }), true]);
  }
  for (const [name, value, make, stream] of fields) {
    for (const [state, v] of [["omitted", undefined], ["null", null], ["value", value]]) {
      test(`${name}: ${state}`, () => {
        const body = JSON.parse(JSON.stringify(make(v))) as Json;
        expect(() => openAIChoices(body, stream)).not.toThrow();
      });
    }
  }
  for (const tool of tools) {
    test(`whole ${tool.type} tool call preserves its payload`, () => {
      const body = answer({ tool_calls: [tool] });
      expect(openAIChoices(body)[0]!["message"]).toEqual(message({ tool_calls: [tool] }));
    });
  }
  for (const role of ["developer", "system", "user", "assistant", "tool"]) {
    test(`published stream role ${role}`, () => expect(() => openAIChoices(chunk({ role }), true)).not.toThrow());
  }
  test("empty lists, role-only messages, and integer indexes have no extra restrictions", () => {
    expect(openAIChoices({ ...answer(), choices: [] })).toEqual([]);
    expect(() => openAIChoices(answer())).not.toThrow();
    expect(() => openAIChoices({ choices: [{ index: -1, message: message() }] })).not.toThrow();
  });
  test("audio expiry after a finish reason and moderation-only chunks remain valid", () => {
    const shape = new OpenAIStreamShape();
    shape.observe(chunk({ audio }, { choices: [{ index: 0, delta: { audio }, finish_reason: "stop" }] }));
    shape.observe(chunk({ audio: { expires_at: 2 } }));
    shape.observe(chunk({}, { choices: [], moderation, usage: null }));
    shape.observe(chunk({}, { choices: [], usage: OPENAI_ANSWER.usage }));
    expect(() => shape.finish()).not.toThrow();
  });
  test("optional finish reasons do not invalidate a closed, accounted stream", () => {
    for (const choices of [[], [{ index: 0, delta: {}, finish_reason: null }], [{ index: 0, delta: {} }]]) {
      const shape = new OpenAIStreamShape();
      shape.observe(chunk({}, { choices, usage: OPENAI_ANSWER.usage }));
      expect(() => shape.finish()).not.toThrow();
    }
  });
  for (const bad of [{ tool_calls: false }, { tool_calls: [{ id: "c", type: "custom", custom: { name: "x", input: 7 } }] },
    { tool_calls: [{ id: "c", type: "unknown" }] }, { function_call: { name: null, arguments: "{}" } }, { content: 1 }]) {
    test(`reject forbidden whole field ${JSON.stringify(bad)}`, () => expect(() => openAIChoices(answer(bad))).toThrow());
  }
  for (const bad of [{ role: "unknown" }, { function_call: { arguments: 1 } },
    { tool_calls: [{ index: 0, function: { name: false } }] }, { tool_calls: [{ index: null }] }]) {
    test(`reject forbidden delta ${JSON.stringify(bad)}`, () => expect(() => openAIChoices(chunk(bad), true)).toThrow());
  }
});

describe("usage optional fields follow the published response types", () => {
  const promptFields = ["audio_tokens", "cache_write_tokens", "cached_tokens", "image_tokens", "text_tokens"];
  const completionFields = ["accepted_prediction_tokens", "audio_tokens", "reasoning_tokens", "rejected_prediction_tokens", "text_tokens"];
  for (const [detail, fields] of [["prompt_tokens_details", promptFields], ["completion_tokens_details", completionFields]] as const) {
    for (const field of fields) {
      for (const value of [undefined, null, 0]) {
        test(`OpenAI ${detail}.${field} = ${String(value)}`, () => {
          const usage = usageFromOpenAI({ ...OPENAI_ANSWER.usage, [detail]: { [field]: value } });
          expect(usage?.inputKnown).not.toBe(false);
          expect(usage?.priceKnown).not.toBe(false);
        });
      }
    }
    for (const value of [undefined, null]) {
      test(`OpenAI ${detail} = ${String(value)}`, () => expect(usageFromOpenAI({ ...OPENAI_ANSWER.usage, [detail]: value })?.inputKnown).not.toBe(false));
    }
  }
  const usage = { input_tokens: 10, output_tokens: 2 };
  for (const field of ["cache_creation", "cache_creation_input_tokens", "cache_read_input_tokens", "inference_geo", "output_tokens_details", "server_tool_use", "service_tier", "speed"]) {
    for (const value of [undefined, null]) {
      test(`Anthropic usage.${field} = ${String(value)}`, () => {
        const parsed = usageFromAnthropic({ ...usage, [field]: value });
        expect(parsed.inputKnown).not.toBe(false);
        expect(parsed.priceKnown).not.toBe(false);
      });
    }
  }
});

describe("Anthropic Messages optional fields and native variants", () => {
  for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens_details", "server_tool_use"]) {
    for (const value of [undefined, null]) {
      test(`message_delta.usage.${field} = ${String(value)}`, () => {
        const translator = new AnthropicStreamTranslator(1, true);
        translator.translate({ type: "message_start", message: ANTHROPIC_ANSWER });
        translator.translate({ type: "message_delta", delta: {}, usage: { output_tokens: 5, [field]: value } });
        translator.translate({ type: "message_stop" });
        expect(translator.complete).toBe(true);
        expect(translator.priceKnown).toBe(true);
        expect(translator.usage.input).toBe(1000);
      });
    }
  }
  for (const field of ["container", "diagnostics", "stop_details", "stop_reason", "stop_sequence"]) {
    for (const value of [undefined, null]) {
      test(`message.${field} = ${String(value)}`, () => {
        const body = { ...ANTHROPIC_ANSWER, [field]: value };
        expect(fromAnthropicAnswer(body, 1).body["anthropic"]).toEqual(body);
      });
    }
  }
  for (const field of ["container", "stop_details", "stop_reason", "stop_sequence"]) {
    for (const value of [undefined, null]) {
      test(`message_delta.${field} = ${String(value)}`, () => {
        const translator = new AnthropicStreamTranslator(1, true);
        translator.translate({ type: "message_start", message: ANTHROPIC_ANSWER });
        const event = { type: "message_delta", delta: { [field]: value }, usage: { output_tokens: 5 } };
        expect(translator.translate(event)[0]!["anthropic"]).toEqual(event);
        translator.translate({ type: "message_stop" });
        expect(translator.complete).toBe(true);
      });
    }
  }
  for (const [block, field] of [[{ type: "text", text: "x" }, "citations"],
    [{ type: "tool_use", id: "", name: "", input: {} }, "caller"],
    [{ type: "tool_use", id: "", name: "", input: {} }, "toolset_name"]] as const) {
    for (const value of [undefined, null]) {
      test(`${block.type}.${field} = ${String(value)}`, () => expect(() => fromAnthropicAnswer({ ...ANTHROPIC_ANSWER, content: [{ ...block, [field]: value }] }, 1)).not.toThrow());
    }
  }
  const blocks = [
    { type: "text", text: "hi", citations: null },
    { type: "tool_use", id: "t", name: "f", input: {} },
    { type: "thinking", thinking: "thought", signature: "sig" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "server_tool_use", id: "s", name: "web_search", input: {} },
    { type: "container_upload", file_id: "file" },
    { type: "web_search_tool_result", tool_use_id: "s", content: [] },
    ...["web_fetch", "code_execution", "bash_code_execution", "text_editor_code_execution", "tool_search"].map((type) => ({
      type: `${type}_tool_result`, tool_use_id: "s", content: { type: `${type}_tool_result_error`, error_code: "unavailable" },
    })),
  ];
  for (const block of blocks) {
    test(`preserve ${block.type} whole and streamed`, () => {
      const body = { ...ANTHROPIC_ANSWER, content: [block], stop_reason: "pause_turn" };
      expect(fromAnthropicAnswer(body, 1).body["anthropic"]).toEqual(body);
      const translator = new AnthropicStreamTranslator(1, true);
      translator.translate({ type: "message_start", message: ANTHROPIC_ANSWER });
      const event = { type: "content_block_start", index: 0, content_block: block };
      expect(translator.translate(event)[0]!["anthropic"]).toEqual(event);
    });
  }
  for (const delta of [{ type: "thinking_delta", thinking: "x" }, { type: "signature_delta", signature: "sig" },
    { type: "citations_delta", citation: { type: "char_location", cited_text: "x", document_index: 0, document_title: null, start_char_index: 0, end_char_index: 1 } }]) {
    test(`preserve ${delta.type}`, () => {
      const translator = new AnthropicStreamTranslator(1, true);
      translator.translate({ type: "message_start", message: ANTHROPIC_ANSWER });
      const event = { type: "content_block_delta", index: 0, delta };
      expect(translator.translate(event)[0]!["anthropic"]).toEqual(event);
    });
  }
});
