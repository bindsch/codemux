/** Structural checks for OpenAI answers; unknown extension fields pass through. */
import { CompleteError } from "./errors.js";
import { isObject } from "./response-accounting.js";

type Json = Record<string, unknown>;

// Published response types, pinned for nullable fields and tool-call variants:
// https://github.com/openai/openai-python/tree/0ebd00647f6088fb100b03440c6c4554bbab549d/src/openai/types/chat
// ChatCompletionMessage has only one required field: role. ChoiceDelta's
// fields are all optional/nullable; its role union includes non-assistant roles.
// ChatCompletionMessageToolCallUnion includes function AND custom calls.
const ROLES = ["developer", "system", "user", "assistant", "tool"];
const FINISH_REASONS = ["stop", "length", "tool_calls", "content_filter", "function_call"];

function malformed(message: string): never {
  throw new CompleteError(502, "upstream_malformed", `the upstream answer ${message}`);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function strings(value: unknown, fields: string[], partial: boolean): void {
  if (!isObject(value) || fields.some((field) =>
    (!partial || present(value[field])) && typeof value[field] !== "string")) malformed("has invalid call fields");
}

function messageShape(message: unknown, stream: boolean): void {
  if (!isObject(message)) malformed(stream ? "has no delta object" : "has no message object");
  if (stream ? present(message["role"]) && !ROLES.includes(message["role"] as string) : message["role"] !== "assistant") {
    malformed("has an invalid message role");
  }
  if (message["content"] !== undefined && message["content"] !== null && typeof message["content"] !== "string") {
    malformed("has invalid message content");
  }
  if (message["refusal"] !== undefined && message["refusal"] !== null && typeof message["refusal"] !== "string") malformed("has an invalid refusal");
  if (message["audio"] !== undefined && message["audio"] !== null && !isObject(message["audio"])) malformed("has invalid audio");
  if (present(message["function_call"])) strings(message["function_call"], ["name", "arguments"], stream);
  if (present(message["tool_calls"])) {
    if (!Array.isArray(message["tool_calls"])) malformed("has invalid tool calls");
    for (const tool of message["tool_calls"]) {
      if (!isObject(tool) || ((!stream || present(tool["id"])) && typeof tool["id"] !== "string")) {
        malformed("has an invalid tool call");
      }
      if (stream && !Number.isInteger(tool["index"])) malformed("has an invalid tool index");
      const type = tool["type"];
      if ((!stream || present(type)) && type !== "function" && type !== "custom") malformed("has an invalid tool type");
      // The SDK chunk type currently lists function only. Preserve custom
      // deltas from compatible gateways too, using the whole-answer union.
      for (const [field, argument] of [["function", "arguments"], ["custom", "input"]] as const) {
        if (stream ? present(tool[field]) : type === field) strings(tool[field], ["name", argument], stream);
      }
    }
  }
}

export function openAIChoices(answer: Json, stream = false): Json[] {
  if (answer["error"] !== undefined && answer["error"] !== null) malformed("has an invalid error envelope");
  const choices = answer["choices"];
  // List[Choice] permits an empty list, including moderation-only chunks.
  if (!Array.isArray(choices)) malformed("has no completion choices");
  for (const choice of choices) {
    if (!isObject(choice) || !Number.isInteger(choice["index"])) {
      malformed("has an invalid choice index");
    }
    if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== null &&
        !FINISH_REASONS.includes(choice["finish_reason"] as string)) malformed("has an invalid finish reason");
    messageShape(choice[stream ? "delta" : "message"], stream);
  }
  return choices as Json[];
}

export class OpenAIStreamShape {
  private observed = false;

  observe(answer: Json): Json[] {
    const choices = openAIChoices(answer, true);
    this.observed = true;
    return choices;
  }

  finish(): void {
    // Chunk.finish_reason is optional, including the final audio expiry
    // update after a finished choice. [DONE] closes the stream; accounting
    // separately requires complete usage before it can settle a known cost.
    if (!this.observed) malformed("stream ended without a completion chunk");
  }
}
