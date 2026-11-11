/**
 * Anthropic Messages answer -> OpenAI chat completion, non-streaming and
 * streaming (docs/complete.md lists every mapping). Text blocks join into
 * `message.content`; `tool_use` blocks become `tool_calls` with the same
 * ids and their `input` serialized as `function.arguments`. The original
 * message/events remain in the anthropic extension, including native blocks.
 */

import { CompleteError } from "./errors.js";
import { blockObject, nativeBlock, nativeDelta } from "./anthropic-shape.js";
import { anthropicPriceKnown, hasNativeToolCharge, openAIUsage, usageFromAnthropic, type CompletionUsage } from "./usage.js";

type Json = Record<string, unknown>;

const FINISH: Readonly<Record<string, string>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  pause_turn: "stop",
};

function malformed(message: string): CompleteError {
  return new CompleteError(502, "upstream_malformed", message);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTool(block: Json): void {
  if (typeof block["id"] !== "string" || typeof block["name"] !== "string" ||
      !isObject(block["input"])) throw malformed("Anthropic tool_use has invalid id, name, or input");
}

// Message.stop_reason is Optional[StopReason] = None in the pinned SDK
// cited in anthropic-shape.ts. pause_turn is preserved in the native message.
export function finishReason(stopReason: unknown): string | null {
  if (stopReason === undefined || stopReason === null) return null;
  const finish = typeof stopReason === "string" && Object.hasOwn(FINISH, stopReason) ? FINISH[stopReason] : undefined;
  if (finish === undefined) {
    throw malformed(`Anthropic stop_reason ${JSON.stringify(stopReason)} has no OpenAI equivalent`);
  }
  return finish;
}

export interface TranslatedAnswer {
  body: Json;
  usage: CompletionUsage;
  model: string | null;
  finish: string;
}

/** Usage and the served model are read before any translation, so a
 * refused answer still reaches the ledger with what it cost. */
export function anthropicUsageOf(answer: unknown): { usage: CompletionUsage; model: string | null } {
  const a = (typeof answer === "object" && answer !== null ? answer : {}) as Json;
  return { usage: usageFromAnthropic(a["usage"]), model: typeof a["model"] === "string" ? a["model"] : null };
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** True when `holder.usage` carries every count in `fields`: without them
 * the cost cannot be known. A whole answer needs `input_tokens` and
 * `output_tokens`; a stream gets the first at `message_start` and the
 * final second at `message_delta`. */
export function hasAnthropicUsage(holder: unknown, fields: readonly string[] = ["input_tokens", "output_tokens"]): boolean {
  const usage = typeof holder === "object" && holder !== null ? (holder as Json)["usage"] : undefined;
  if (typeof usage !== "object" || usage === null) return false;
  return fields.every((field) => isCount((usage as Json)[field]));
}

export function fromAnthropicAnswer(answer: Json, created: number): TranslatedAnswer {
  const { usage, model } = anthropicUsageOf(answer);
  if (answer["type"] !== "message" || answer["role"] !== "assistant") throw malformed("Anthropic answer is not an assistant message");
  const content = answer["content"];
  if (!Array.isArray(content)) throw malformed("Anthropic answer has no content array");
  let text: string | null = null;
  const toolCalls: Json[] = [];
  for (const raw of content as unknown[]) {
    const block = blockObject(raw);
    if (block["type"] === "text" && typeof block["text"] === "string") {
      text = (text ?? "") + block["text"];
    } else if (block["type"] === "tool_use") {
      validateTool(block);
      toolCalls.push({
        id: block["id"],
        type: "function",
        function: { name: block["name"], arguments: JSON.stringify(block["input"] ?? {}) },
      });
    } else if (!nativeBlock(block)) {
      throw malformed(`Anthropic content block ${JSON.stringify(block["type"])} has no OpenAI equivalent`);
    }
  }
  const finish = finishReason(answer["stop_reason"]);
  const message: Json = { role: "assistant", content: text, refusal: null };
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  return {
    body: {
      anthropic: answer,
      id: answer["id"],
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
      usage: openAIUsage(usage),
    },
    usage,
    model,
    finish: finish ?? "unknown",
  };
}

/**
 * Anthropic SSE events -> OpenAI `chat.completion.chunk` objects, one
 * event at a time. `message_start` opens the assistant turn, text deltas
 * become `delta.content`, a `tool_use` block becomes a `tool_calls` entry
 * (id and name first, then `input_json_delta` fragments as
 * `function.arguments`), and `message_delta` carries the finish reason.
 * With `includeUsage` the stream ends with OpenAI's usage chunk (empty
 * `choices`). `ping` produces nothing. Other events without an OpenAI
 * delta remain in empty-choice chunks, including `content_block_stop`
 * and `message_stop` without usage. A tool stop supplies `arguments: "{}"`
 * when the tool streamed no arguments.
 */
export class AnthropicStreamTranslator {
  private id = "";
  private created: number;
  private toolIndexByBlock = new Map<number, number>();
  /** Tool blocks that have streamed a non-empty argument fragment. */
  private toolsWithArguments = new Set<number>();
  private nativeToolBlocks = new Set<number>();
  private nextToolIndex = 0;
  usage: CompletionUsage = usageFromAnthropic({});
  model: string | null = null;
  finish: string | null = null;
  /** True once `message_delta` carried the final usage and `message_stop`
   * closed the message: only then is `usage` the answer's whole cost. */
  complete = false;
  private finalUsage = false;
  private started = false;
  /** True once any event carried usage, including a failing event. */
  usageSeen = false;
  priceKnown = true;

  private observe(holder: Json): void {
    if (Array.isArray(holder["content"]) && holder["content"].some(hasNativeToolCharge)) this.priceKnown = false;
    if (hasNativeToolCharge(holder["content_block"])) this.priceKnown = false;
    if (holder["model"] !== undefined && holder["model"] !== null) {
      const model = typeof holder["model"] === "string" ? holder["model"] : "";
      if (this.model !== null && this.model !== model) this.priceKnown = false;
      this.model = model;
    }
    if (!isObject(holder["usage"])) {
      if (holder["usage"] !== undefined && holder["usage"] !== null) this.priceKnown = false;
      return;
    }
    const raw = holder["usage"];
    const prior = this.usage;
    if (!anthropicPriceKnown({
      ...raw, cache_creation_input_tokens: raw["cache_creation_input_tokens"] ?? prior.cacheWrite,
    })) this.priceKnown = false;
    const countOrPrior = (field: string, previous: number | undefined): unknown => {
      const count = raw[field];
      if (count === undefined || count === null) return previous;
      if (isCount(count)) return count;
      // Malformed evidence cannot erase a previously observed valid count.
      this.priceKnown = false;
      return previous;
    };
    this.usage = usageFromAnthropic({
      ...raw,
      input_tokens: countOrPrior("input_tokens", prior.inputKnown === false ? undefined : prior.input),
      output_tokens: countOrPrior("output_tokens", prior.outputKnown === false ? undefined : prior.output),
      cache_read_input_tokens: countOrPrior("cache_read_input_tokens", prior.cacheRead),
      cache_creation_input_tokens: countOrPrior("cache_creation_input_tokens", prior.cacheWrite),
    });
    if (this.usage.priceKnown === false) this.priceKnown = false;
    this.usageSeen = true;
  }

  constructor(created: number, private readonly includeUsage: boolean) {
    this.created = created;
  }

  private chunk(delta: Json, finish: string | null = null): Json {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    };
  }

  /** The OpenAI chunks one Anthropic event produces. */
  translate(event: Json): Json[] {
    const chunks = this.translateEvent(event);
    // Preserve every native event without assigning server tools to the
    // caller. Empty-choice chunks carry events with no OpenAI delta.
    if (event["type"] === "ping") return chunks;
    if (chunks.length === 0) return [{ ...this.chunk({}), choices: [], anthropic: event }];
    return chunks.map((chunk) => ({ ...chunk, anthropic: event }));
  }

  private translateEvent(event: Json): Json[] {
    if (!isObject(event)) throw malformed("Anthropic stream event is not an object");
    if (isObject(event["message"])) this.observe(event["message"]);
    this.observe(event);
    if (typeof event["type"] === "string" && event["type"].startsWith("content_block_") &&
        !Number.isInteger(event["index"])) {
      throw malformed("Anthropic content block has an invalid index");
    }
    if (typeof event["error"] === "object" && event["error"] !== null) {
      throw malformed(`Anthropic stream error: ${String((event["error"] as Json)["message"] ?? "unknown")}`);
    }
    switch (event["type"]) {
      case "message_start": {
        if (this.started || !isObject(event["message"])) throw malformed("Anthropic stream has an invalid message_start");
        this.started = true;
        const message = (event["message"] ?? {}) as Json;
        this.id = typeof message["id"] === "string" ? message["id"] : "";
        return [this.chunk({ role: "assistant", content: "", refusal: null })];
      }
      case "content_block_start": {
        if (!this.started) throw malformed("Anthropic content arrived before message_start");
        const block = blockObject(event["content_block"]);
        if (block["type"] === "text") {
          if (typeof block["text"] !== "string") throw malformed("Anthropic text block has no text");
          return typeof block["text"] === "string" && block["text"] !== "" ? [this.chunk({ content: block["text"] })] : [];
        }
        if (block["type"] === "tool_use") {
          validateTool(block);
          const index = this.nextToolIndex++;
          this.toolIndexByBlock.set(Number(event["index"]), index);
          return [this.chunk({
            tool_calls: [{ index, id: block["id"], type: "function", function: { name: block["name"], arguments: "" } }],
          })];
        }
        if (nativeBlock(block)) {
          if (block["type"] === "server_tool_use") this.nativeToolBlocks.add(Number(event["index"]));
          return [];
        }
        throw malformed(`Anthropic content block ${JSON.stringify(block["type"])} has no OpenAI equivalent`);
      }
      case "content_block_delta": {
        const delta = blockObject(event["delta"]);
        if (!this.started) throw malformed("Anthropic delta arrived before message_start");
        if (delta["type"] === "text_delta") {
          if (typeof delta["text"] !== "string") throw malformed("Anthropic text_delta has no text");
          return [this.chunk({ content: delta["text"] })];
        }
        if (delta["type"] === "input_json_delta") {
          if (typeof delta["partial_json"] !== "string") throw malformed("Anthropic input_json_delta has no string fragment");
          if (this.nativeToolBlocks.has(Number(event["index"]))) return [];
          const index = this.toolIndexByBlock.get(Number(event["index"]));
          if (index === undefined) throw malformed("input_json_delta for a block that is not a tool_use");
          if (typeof delta["partial_json"] !== "string") throw malformed("Anthropic input_json_delta has no string fragment");
          if (typeof delta["partial_json"] === "string" && delta["partial_json"] !== "") this.toolsWithArguments.add(index);
          return [this.chunk({ tool_calls: [{ index, function: { arguments: delta["partial_json"] } }] })];
        }
        if (nativeDelta(delta)) return [];
        throw malformed(`Anthropic delta ${JSON.stringify(delta["type"])} has no OpenAI equivalent`);
      }
      case "message_delta": {
        const delta = (event["delta"] ?? {}) as Json;
        this.finalUsage ||= this.usage.inputKnown !== false && hasAnthropicUsage(event, ["output_tokens"]);
        const reason = delta["stop_reason"];
        const finish = reason === undefined || reason === null ? null : finishReason(reason);
        if (!this.started) throw malformed("Anthropic delta arrived before message_start");
        // A usage-only message_delta updates the count and is preserved
        // without an OpenAI delta; the finish comes with its stop_reason.
        if (finish === null) return [];
        this.finish = finish;
        return [this.chunk({}, this.finish)];
      }
      case "message_stop":
        this.complete = this.started && this.finalUsage;
        if (!this.includeUsage) return [];
        return [{
          id: this.id,
          object: "chat.completion.chunk",
          created: this.created,
          model: this.model,
          choices: [],
          usage: openAIUsage(this.usage),
        }];
      case "content_block_stop": {
        // A tool call with no input streams no fragment; OpenAI sends "{}"
        // for one, as the whole-answer path does, so the client can send
        // the call back next turn.
        const index = this.toolIndexByBlock.get(Number(event["index"]));
        if (index === undefined || this.toolsWithArguments.has(index)) return [];
        this.toolsWithArguments.add(index);
        return [this.chunk({ tool_calls: [{ index, function: { arguments: "{}" } }] })];
      }
      case "ping":
        return [];
      case "error": {
        const error = (event["error"] ?? {}) as Json;
        throw malformed(`Anthropic stream error: ${String(error["message"] ?? "unknown")}`);
      }
      default:
        throw malformed(`Anthropic stream event ${JSON.stringify(event["type"])} has no OpenAI equivalent`);
    }
  }
}
