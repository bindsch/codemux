/**
 * OpenAI chat-completions request -> Anthropic Messages request, exactly or
 * not at all: every field either maps one to one (the table in
 * docs/complete.md) or the request is refused with a 400 naming the field.
 * Nothing is dropped silently, because a measurement harness must know the
 * model saw what it sent.
 */

import { cannotTranslate, badRequest } from "./errors.js";

type Json = Record<string, unknown>;

/** Top-level fields that map, or that are accepted only at the value that
 * makes them a no-op (`n: 1`, `store: false`, a zero penalty). */
const MAPPED_FIELDS: ReadonlySet<string> = new Set([
  "model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p",
  "stop", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options",
  "user", "n", "response_format", "store", "seed", "frequency_penalty",
  "presence_penalty", "logprobs",
]);

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Refuses a field that is present at anything but its no-op value. */
function requireNoOp(request: Json, field: string, noOp: unknown[]): void {
  const value = request[field];
  if (!present(value) || noOp.includes(value)) return;
  const valid = field === "store" || field === "logprobs" ? typeof value === "boolean"
    : field === "seed" ? Number.isSafeInteger(value)
    : field === "n" ? Number.isSafeInteger(value) && (value as number) >= 1
    : typeof value === "number" && Number.isFinite(value) && value >= -2 && value <= 2;
  if (!valid) throw badRequest(`${field} has an invalid value`);
  throw cannotTranslate(`${field}=${JSON.stringify(value)} has no Anthropic Messages equivalent`);
}

/** The fields each message role may carry; any other present field has no
 * Anthropic equivalent and is refused rather than dropped. */
const MESSAGE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  system: new Set(["role", "content"]),
  developer: new Set(["role", "content"]),
  user: new Set(["role", "content"]),
  assistant: new Set(["role", "content", "tool_calls", "refusal"]),
  tool: new Set(["role", "content", "tool_call_id"]),
};

/** Refuses any present field of `value` outside `allowed`: a nested field
 * the translation would otherwise drop (`cache_control` on a text part). */
function onlyFields(value: Json, allowed: readonly string[], where: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field) && present(value[field])) throw cannotTranslate(`${where}.${field} has no Anthropic equivalent`);
  }
}

function textParts(content: unknown, where: string, allowImages: boolean): Json[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw badRequest(`${where}.content must be a string or an array of parts`);
  return content.map((part, index) => {
    if (!isObject(part)) throw badRequest(`${where}.content[${index}] must be an object`);
    if (part["type"] === "text") {
      if (typeof part["text"] !== "string") throw badRequest(`${where}.content[${index}].text must be a string`);
      onlyFields(part, ["type", "text"], `${where}.content[${index}]`);
      return { type: "text", text: part["text"] };
    }
    if (allowImages && part["type"] === "image_url") {
      if (!isObject(part["image_url"])) throw badRequest(`${where}.content[${index}].image_url must be an object`);
      onlyFields(part, ["type", "image_url"], `${where}.content[${index}]`);
      onlyFields(part["image_url"], ["url", "detail"], `${where}.content[${index}].image_url`);
      return imageBlock(part["image_url"], `${where}.content[${index}]`);
    }
    throw cannotTranslate(`${where}.content[${index}] of type ${JSON.stringify(part["type"])} cannot be translated`);
  }).filter((part) => part["type"] !== "text" || part["text"] !== "");
}

function imageBlock(imageUrl: Json, where: string): Json {
  if (present(imageUrl["detail"]) && !["auto", "low", "high"].includes(imageUrl["detail"] as string)) {
    throw badRequest(`${where}.image_url.detail must be auto, low, or high`);
  }
  if (present(imageUrl["detail"]) && imageUrl["detail"] !== "auto") {
    throw cannotTranslate(`${where}.image_url.detail has no Anthropic equivalent`);
  }
  const url = imageUrl["url"];
  if (typeof url !== "string") throw badRequest(`${where}.image_url.url must be a string`);
  const data = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/s.exec(url);
  if (data !== null) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return { type: "image", source: { type: "url", url } };
  }
  throw cannotTranslate(`${where}.image_url.url must be a data: or http(s) URL`);
}

function toolUseBlock(call: unknown, where: string): Json {
  if (!isObject(call) || typeof call["type"] !== "string") throw badRequest(`${where} needs a tool type`);
  if (call["type"] !== "function") {
    throw cannotTranslate(`${where} must be a function tool call`);
  }
  if (!isObject(call["function"])) throw badRequest(`${where}.function must be an object`);
  const fn = call["function"];
  onlyFields(call, ["id", "type", "function"], where);
  onlyFields(fn, ["name", "arguments"], `${where}.function`);
  if (typeof call["id"] !== "string" || typeof fn["name"] !== "string") {
    throw badRequest(`${where} needs a string id and function.name`);
  }
  let input: unknown;
  try {
    // Empty or whitespace-only strings mean no arguments. Other strings
    // must parse as objects; non-strings are refused below.
    const raw = fn["arguments"];
    if (typeof raw !== "string") throw new TypeError("not a string");
    input = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    throw badRequest(`${where}.function.arguments must be a JSON object string (Anthropic tool_use.input is one)`);
  }
  if (!isObject(input)) {
    throw cannotTranslate(`${where}.function.arguments must be a JSON object (Anthropic tool_use.input is one)`);
  }
  return { type: "tool_use", id: call["id"], name: fn["name"], input };
}

/** Appends blocks under a role, merging into the previous message when it
 * has the same role: Anthropic requires alternating turns and itself
 * merges consecutive same-role turns, so the merge changes nothing the
 * model sees. */
function push(messages: Json[], role: "user" | "assistant", blocks: Json[]): void {
  const last = messages[messages.length - 1];
  if (last !== undefined && last["role"] === role) {
    (last["content"] as Json[]).push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
}

function translateMessages(input: unknown): { system: Json[]; messages: Json[] } {
  if (!Array.isArray(input) || input.length === 0) throw badRequest("messages must be a non-empty array");
  const system: Json[] = [];
  const messages: Json[] = [];
  input.forEach((message, index) => {
    const where = `messages[${index}]`;
    if (!isObject(message)) throw badRequest(`${where} must be an object`);
    if (present(message["name"])) throw cannotTranslate(`${where}.name has no Anthropic equivalent`);
    const role = message["role"];
    if (typeof role !== "string") throw badRequest(`${where}.role must be a string`);
    const allowed = typeof role === "string" && Object.hasOwn(MESSAGE_FIELDS, role) ? MESSAGE_FIELDS[role]! : null;
    if (allowed !== null) {
      for (const field of Object.keys(message)) {
        if (!allowed.has(field) && present(message[field])) {
          throw cannotTranslate(`${where}.${field} has no Anthropic equivalent`);
        }
      }
    }
    if (role === "system" || role === "developer") {
      // Anthropic takes the system prompt once, before the conversation.
      if (messages.length > 0) {
        throw cannotTranslate(`${where}: a ${role} message after the conversation started has no Anthropic equivalent`);
      }
      system.push(...textParts(message["content"], where, false));
      return;
    }
    if (role === "user") {
      const blocks = textParts(message["content"], where, true);
      if (blocks.length === 0) throw cannotTranslate(`${where} is empty; Anthropic refuses an empty user turn`);
      push(messages, "user", blocks);
      return;
    }
    if (role === "assistant") {
      if (present(message["refusal"])) throw cannotTranslate(`${where}.refusal has no Anthropic equivalent`);
      const blocks = present(message["content"]) ? textParts(message["content"], where, false) : [];
      const calls = message["tool_calls"];
      if (present(calls)) {
        if (!Array.isArray(calls)) throw badRequest(`${where}.tool_calls must be an array`);
        calls.forEach((call, callIndex) => blocks.push(toolUseBlock(call, `${where}.tool_calls[${callIndex}]`)));
      }
      if (blocks.length === 0) throw cannotTranslate(`${where} is empty; Anthropic refuses an empty assistant turn`);
      push(messages, "assistant", blocks);
      return;
    }
    if (role === "tool") {
      if (typeof message["tool_call_id"] !== "string") throw badRequest(`${where}.tool_call_id must be a string`);
      const content = message["content"];
      const text = typeof content === "string"
        ? content
        : textParts(content, where, false).map((part) => part["text"] as string).join("");
      // Anthropic wants a turn's tool_result blocks before any other block;
      // a tool message after a user message in the same turn cannot keep
      // that order without moving what the harness sent.
      const last = messages[messages.length - 1];
      if (last !== undefined && last["role"] === "user" &&
        (last["content"] as Json[]).some((block) => block["type"] !== "tool_result")) {
        throw cannotTranslate(`${where}: a tool result after a user message in the same turn has no Anthropic equivalent`);
      }
      push(messages, "user", [{ type: "tool_result", tool_use_id: message["tool_call_id"], content: text }]);
      return;
    }
    throw cannotTranslate(`${where}.role ${JSON.stringify(role)} cannot be translated`);
  });
  if (messages.length === 0) throw badRequest("messages must hold at least one user turn");
  return { system, messages };
}

function translateTools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) throw badRequest("tools must be an array");
  return tools.map((tool, index) => {
    const where = `tools[${index}]`;
    if (!isObject(tool) || typeof tool["type"] !== "string") throw badRequest(`${where} needs a tool type`);
    if (tool["type"] !== "function") {
      throw cannotTranslate(`${where} must be a function tool`);
    }
    if (!isObject(tool["function"])) throw badRequest(`${where}.function must be an object`);
    const fn = tool["function"];
    onlyFields(tool, ["type", "function"], where);
    onlyFields(fn, ["name", "description", "parameters", "strict"], `${where}.function`);
    if (typeof fn["name"] !== "string") throw badRequest(`${where}.function.name must be a string`);
    if (Object.hasOwn(fn, "description") && typeof fn["description"] !== "string") {
      throw badRequest(`${where}.function.description must be a string`);
    }
    if (present(fn["strict"]) && fn["strict"] !== false) {
      if (typeof fn["strict"] !== "boolean") throw badRequest(`${where}.function.strict must be a boolean`);
      throw cannotTranslate(`${where}.function.strict has no Anthropic equivalent`);
    }
    // Omitted and null parameters both select the empty object schema.
    if (present(fn["parameters"]) && !isObject(fn["parameters"])) {
      throw badRequest(`${where}.function.parameters must be a JSON Schema object`);
    }
    const out: Json = {
      name: fn["name"],
      input_schema: isObject(fn["parameters"]) ? fn["parameters"] : { type: "object", properties: {} },
    };
    if (typeof fn["description"] === "string") out["description"] = fn["description"];
    return out;
  });
}

function translateToolChoice(choice: unknown, parallel: unknown): Json | undefined {
  let out: Json | undefined;
  if (!present(choice) || choice === "auto") out = present(parallel) ? { type: "auto" } : undefined;
  else if (choice === "none") out = { type: "none" };
  else if (choice === "required") out = { type: "any" };
  else if (isObject(choice) && choice["type"] === "function" && isObject(choice["function"]) &&
    typeof choice["function"]["name"] === "string") {
    onlyFields(choice, ["type", "function"], "tool_choice");
    onlyFields(choice["function"], ["name"], "tool_choice.function");
    out = { type: "tool", name: choice["function"]["name"] };
  } else {
    if (isObject(choice) && typeof choice["type"] === "string" && choice["type"] !== "function") {
      throw cannotTranslate(`tool_choice ${JSON.stringify(choice)} cannot be translated`);
    }
    throw badRequest(`tool_choice ${JSON.stringify(choice)} is malformed`);
  }
  if (present(parallel)) {
    if (typeof parallel !== "boolean") throw badRequest("parallel_tool_calls must be a boolean");
    if (out!["type"] === "none") {
      if (parallel === false) throw cannotTranslate("parallel_tool_calls=false with tool_choice none cannot be translated");
    } else {
      out!["disable_parallel_tool_use"] = !parallel;
    }
  }
  return out;
}

/** The translated request body. `stream` is carried through; the caller
 * decides how to read the answer. */
export function toAnthropicRequest(request: Json): Json {
  for (const field of Object.keys(request)) {
    if (!MAPPED_FIELDS.has(field) && present(request[field])) {
      throw cannotTranslate(`${field} has no Anthropic Messages equivalent`);
    }
  }
  const streamOptions = request["stream_options"];
  if (present(streamOptions)) {
    if (!isObject(streamOptions)) throw badRequest("stream_options must be an object");
    if (present(streamOptions["include_usage"]) && typeof streamOptions["include_usage"] !== "boolean") {
      throw badRequest("stream_options.include_usage must be a boolean");
    }
    onlyFields(streamOptions, ["include_usage"], "stream_options");
  }
  if (present(request["parallel_tool_calls"]) && !present(request["tools"])) {
    throw badRequest("parallel_tool_calls is only allowed when tools are given");
  }
  requireNoOp(request, "n", [1]);
  requireNoOp(request, "store", [false]);
  requireNoOp(request, "seed", []);
  requireNoOp(request, "frequency_penalty", [0]);
  requireNoOp(request, "presence_penalty", [0]);
  requireNoOp(request, "logprobs", [false]);
  const format = request["response_format"];
  if (present(format) && (!isObject(format) || !["text", "json_object", "json_schema"].includes(format["type"] as string))) {
    throw badRequest("response_format must be an object with a supported type");
  }
  if (present(format) && !(isObject(format) && format["type"] === "text" && Object.keys(format).length === 1)) {
    throw cannotTranslate("response_format other than {\"type\":\"text\"} has no Anthropic Messages equivalent");
  }
  if (typeof request["model"] !== "string" || request["model"] === "") throw badRequest("model must be a non-empty string");
  const maxTokens = request["max_completion_tokens"] ?? request["max_tokens"];
  if (present(request["max_tokens"]) && present(request["max_completion_tokens"]) &&
    request["max_tokens"] !== request["max_completion_tokens"]) {
    throw badRequest("max_tokens and max_completion_tokens disagree");
  }
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) {
    if (!present(maxTokens)) throw cannotTranslate("max_tokens (or max_completion_tokens) is required: Anthropic needs an explicit output cap");
    throw badRequest("max_tokens (or max_completion_tokens) must be a positive safe integer");
  }
  const { system, messages } = translateMessages(request["messages"]);
  const out: Json = { model: request["model"], max_tokens: maxTokens, messages };
  if (system.length > 0) out["system"] = system;
  const temperature = request["temperature"];
  if (present(temperature)) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw badRequest("temperature must be a number in [0, 2]");
    }
    if (temperature > 1) {
      throw cannotTranslate("temperature must lie in [0, 1] for Anthropic (OpenAI's range is [0, 2])");
    }
    out["temperature"] = temperature;
  }
  const topP = request["top_p"];
  if (present(topP)) {
    if (typeof topP !== "number" || !Number.isFinite(topP) || topP < 0 || topP > 1) throw badRequest("top_p must be a number in [0, 1]");
    out["top_p"] = topP;
  }
  const stop = request["stop"];
  if (present(stop)) {
    const sequences = typeof stop === "string" ? [stop] : stop;
    if (!Array.isArray(sequences) || !sequences.every((item) => typeof item === "string")) {
      throw badRequest("stop must be a string or an array of strings");
    }
    out["stop_sequences"] = sequences;
  }
  if (present(request["tools"])) out["tools"] = translateTools(request["tools"]);
  const choice = translateToolChoice(request["tool_choice"], request["parallel_tool_calls"]);
  if (choice !== undefined) out["tool_choice"] = choice;
  if (present(request["user"])) {
    if (typeof request["user"] !== "string") throw badRequest("user must be a string");
    out["metadata"] = { user_id: request["user"] };
  }
  if (request["stream"] === true) out["stream"] = true;
  // Pinned so an account with Priority Tier capacity is never served at a
  // premium the standard-tier price table would undercount.
  out["service_tier"] = "standard_only";
  return out;
}
