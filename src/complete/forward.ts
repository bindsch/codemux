/**
 * One chat-completions request through the governor to the upstream and
 * back (docs/complete.md). An OpenAI-wire upstream gets the request body
 * unchanged except for two governance fields: `stream_options.include_usage`
 * on a streamed request (the usage chunk is withheld from a client that did
 * not ask for it) and, on OpenRouter, `usage.include: true` (forced, even
 * over a client's `false`) so the provider reports its charge. A whole
 * answer is forwarded byte for byte; a stream is forwarded event by event,
 * each event's text unchanged but its separator written as a blank line
 * (`\n\n`). On OpenAI itself, a `service_tier` the price table does not
 * price (anything but `default` or `flex`) is refused, and an answer
 * served at one stops the cap; other OpenAI-wire upstreams name their own
 * tiers, which the table does not interpret. Upstream redirects are refused, never followed, so the key header
 * never reaches another host. An Anthropic
 * upstream gets the translated request (anthropic-request.ts) and its
 * answer translated back (anthropic-response.ts).
 */

import { toAnthropicRequest } from "./anthropic-request.js";
import { AnthropicStreamTranslator, fromAnthropicAnswer } from "./anthropic-response.js";
import { badRequest, CompleteError, errorBody } from "./errors.js";
import type { CompleteGovernor, Ticket } from "./governor.js";
import { clearProxyEnvironment, upstreamRequest, type UpstreamConfig } from "./provider.js";
import { openAIChoices, OpenAIStreamShape } from "./openai-response.js";
import { isObject, ResponseAccounting, tierPriced } from "./response-accounting.js";
import { readSse } from "./sse.js";

type Json = Record<string, unknown>;

const MAX_ERROR_BODY_BYTES = 1024 * 1024;
/** The largest whole answer read; a bigger one is a 502 at an unknown cost. */
export const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/** Where the answer goes: one whole body, or a stream of SSE text. */
export interface ResponseSink {
  send(status: number, contentType: string, body: string): void;
  begin(status: number): void;
  write(text: string): void;
  end(): void;
  /** Aborted when the client goes away. */
  readonly closed: AbortSignal;
}

export interface Exchange {
  upstream: UpstreamConfig;
  governor: CompleteGovernor;
  timeoutMs: number;
  /** Aborted when the server shuts down. */
  shutdown: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function upstreamBody(request: Json, upstream: UpstreamConfig): Json {
  if (upstream.wire === "anthropic") return toAnthropicRequest(request);
  if (upstream.provider === "openai" && !tierPriced(request["service_tier"])) {
    throw badRequest(`service_tier ${JSON.stringify(request["service_tier"])} is billed above the price table's standard ` +
      "tier, so the budget cannot be kept; use \"default\" or \"flex\", or leave it out");
  }
  const body: Json = { ...request };
  if (request["stream"] === true) {
    const options = isObject(request["stream_options"]) ? request["stream_options"] : {};
    body["stream_options"] = { ...options, include_usage: true };
  }
  if (upstream.provider === "openrouter") {
    body["usage"] = { ...(isObject(request["usage"]) ? request["usage"] : {}), include: true };
  }
  return body;
}

/** A body read to at most `limit` bytes; the rest is never buffered, and
 * the body is canceled. `overflowed` says whether anything was cut. */
async function readBounded(response: Response, limit: number): Promise<{ text: string; overflowed: boolean }> {
  if (response.body === null) return { text: "", overflowed: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - size;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        size = limit;
        overflowed = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A body that already failed has nothing left to cancel.
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), overflowed };
}

/** An upstream error answer in the OpenAI error shape: an OpenAI-wire body
 * passes through; Anthropic's `{type:"error", error:{type, message}}` is
 * rewritten with the same message and type. */
function upstreamErrorBody(text: string, upstream: UpstreamConfig): string {
  if (upstream.wire !== "anthropic") return text;
  try {
    const parsed = JSON.parse(text) as Json;
    const error = isObject(parsed["error"]) ? parsed["error"] : {};
    return JSON.stringify({
      error: { message: String(error["message"] ?? text), type: String(error["type"] ?? "upstream_error"), code: null },
    });
  } catch {
    return JSON.stringify({ error: { message: text, type: "upstream_error", code: null } });
  }
}

/** Handles one parsed request body; every refusal is thrown as a
 * CompleteError for the server to answer, after its ledger row. */
export async function forwardCompletion(request: unknown, exchange: Exchange, sink: ResponseSink): Promise<void> {
  const { governor, upstream } = exchange;
  const now = exchange.now ?? Date.now;
  const model = isObject(request) && typeof request["model"] === "string" ? request["model"] : null;
  let body: Json;
  try {
    if (!isObject(request)) throw badRequest("the request body must be a JSON object");
    if (model === null || model === "") throw badRequest("model must be a non-empty string");
    if (request["stream"] !== undefined && typeof request["stream"] !== "boolean") throw badRequest("stream must be a boolean");
    body = upstreamBody(request, upstream);
  } catch (error) {
    if (error instanceof CompleteError) governor.refuse(model, now(), error);
    throw error;
  }
  if (exchange.shutdown.aborted) {
    const error = new CompleteError(503, "shutting_down", "the server is stopping");
    governor.refuse(model, now(), error);
    throw error;
  }
  const ticket = governor.admit(model!);
  const stream = request["stream"] === true;
  const clientWantsUsage = isObject(request["stream_options"]) && request["stream_options"]["include_usage"] === true;
  const target = upstreamRequest(upstream);
  const signal = AbortSignal.any([AbortSignal.timeout(exchange.timeoutMs), exchange.shutdown, sink.closed]);
  let response: Response;
  // Only an abort after the request left can be billed.
  const abortedBeforeSend = signal.aborted;
  try {
    // Also protect library callers and later changes to process.env.
    clearProxyEnvironment();
    response = await (exchange.fetchImpl ?? fetch)(target.url, {
      method: "POST", headers: target.headers, body: JSON.stringify(body), signal, redirect: "error", proxy: upstream.proxy,
    });
  } catch (error) {
    // An abort (timeout, shutdown, client gone) or a reset may land after
    // the upstream took the request, so it may be billed; a connection
    // that never opened is not.
    governor.settle(ticket, {
      usage: null, servedModel: null, finish: abortFinish(exchange, sink, "upstream_unreachable"),
      billable: !abortedBeforeSend && !provablyNotSent(error), costKnown: false,
    });
    throw new CompleteError(502, "upstream_unreachable", `the upstream could not be reached: ${redacted(error, upstream.apiKey)}`);
  }
  if (!response.ok) {
    const accounting = new ResponseAccounting(upstream);
    const read = await readBounded(response, MAX_ERROR_BODY_BYTES).catch(() => ({ text: "", overflowed: true }));
    const text = read.text;
    let hasUsage = false;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) {
        accounting.observe(parsed);
        hasUsage = parsed["usage"] !== undefined && parsed["usage"] !== null;
      }
    } catch { /* Non-JSON error bodies carry no readable billing evidence. */ }
    const finish = read.overflowed ? "upstream_malformed" : `upstream_error:${response.status}`;
    governor.settle(ticket, accounting.settlement(abortFinish(exchange, sink, finish),
      !read.overflowed, read.overflowed || hasUsage));
    if (read.overflowed) throw new CompleteError(502, "upstream_malformed", "the upstream error body was unreadable or exceeded its size limit");
    sink.send(response.status, "application/json", upstreamErrorBody(text, upstream));
    return;
  }
  if (!stream) return wholeAnswer(response, ticket, exchange, sink, now);
  return streamAnswer(response, ticket, exchange, sink, now, clientWantsUsage);
}

/** Fetch failures that prove the request never reached the upstream: no
 * connection, no address, a refused TLS handshake, or a redirect answered
 * before any work. Anything else (a reset after the body was sent) may
 * have been billed. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket", "UnexpectedRedirect",
]);

function provablyNotSent(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && (NOT_SENT_CODES.has(code) || /CERT|TLS|SSL/.test(code));
}

/** A transport error's message for the client, with the key cut out: a
 * runtime error about a header may quote its value. */
function redacted(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey === "" ? message : message.split(apiKey).join("[redacted]");
}

function abortFinish(exchange: Exchange, sink: ResponseSink, otherwise: string): string {
  if (exchange.shutdown.aborted) return "interrupted";
  if (sink.closed.aborted) return "client_closed";
  return otherwise;
}

async function wholeAnswer(
  response: Response, ticket: Ticket, exchange: Exchange, sink: ResponseSink, now: () => number
): Promise<void> {
  const { governor, upstream } = exchange;
  let text: string;
  let parsed: Json;
  try {
    const read = await readBounded(response, MAX_ANSWER_BYTES);
    if (read.overflowed) throw new Error(`the answer exceeds ${MAX_ANSWER_BYTES} bytes`);
    text = read.text;
    parsed = JSON.parse(text) as Json;
    if (!isObject(parsed)) throw new Error("not an object");
  } catch (error) {
    governor.settle(ticket, {
      usage: null, servedModel: null, finish: abortFinish(exchange, sink, "upstream_malformed"), billable: true, costKnown: false,
    });
    throw new CompleteError(502, "upstream_malformed",
      `the upstream answer was not a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
  const accounting = new ResponseAccounting(upstream);
  accounting.observe(parsed);
  // An error object takes precedence over success fields on either wire.
  // Some providers report failures with HTTP 200 and an empty choices array.
  if (isObject(parsed["error"]) || (upstream.wire === "anthropic" && parsed["type"] === "error")) {
    const code = isObject(parsed["error"]) ? parsed["error"]["code"] : undefined;
    const status = typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
    governor.settle(ticket, accounting.settlement(`upstream_error:${status}`));
    sink.send(status, "application/json", upstreamErrorBody(text, upstream));
    return;
  }
  if (upstream.wire === "anthropic") {
    let translated;
    try {
      translated = fromAnthropicAnswer(parsed, Math.floor(now() / 1000));
    } catch (error) {
      governor.settle(ticket, accounting.settlement("untranslatable"));
      throw error;
    }
    governor.settle(ticket, accounting.settlement(translated.finish));
    sink.send(200, "application/json", JSON.stringify(translated.body));
    return;
  }
  let choices: Json[];
  try {
    choices = openAIChoices(parsed);
  } catch (error) {
    governor.settle(ticket, accounting.settlement("upstream_malformed"));
    throw error;
  }
  const finish = choices[0]?.["finish_reason"];
  governor.settle(ticket, accounting.settlement(typeof finish === "string" ? finish : "unknown"));
  sink.send(200, "application/json", text);
}

async function streamAnswer(
  response: Response, ticket: Ticket, exchange: Exchange, sink: ResponseSink,
  now: () => number, clientWantsUsage: boolean
): Promise<void> {
  const { governor, upstream } = exchange;
  const accounting = new ResponseAccounting(upstream);
  const shape = new OpenAIStreamShape();
  let finish: string | null = null;
  // The usage is final only when the stream ran to its end: a stream cut
  // by an error or an abort carries at most a partial count.
  let completed = false;
  let sawDone = false;
  const translator = upstream.wire === "anthropic"
    ? new AnthropicStreamTranslator(Math.floor(now() / 1000), clientWantsUsage) : null;
  try {
    sink.begin(200);
    if (response.body === null) throw new CompleteError(502, "upstream_malformed", "the upstream stream had no body");
    for await (const event of readSse(response.body)) {
      if (translator !== null) {
        if (event.data === null) continue;
        const parsedEvent = JSON.parse(event.data) as Json;
        for (const chunk of translator.translate(parsedEvent)) {
          sink.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        finish = translator.finish;
        // message_stop ends the answer: stop reading, even if the
        // upstream keeps its connection open.
        if (parsedEvent["type"] === "message_stop") break;
        continue;
      }
      if (event.data === null) {
        sink.write(`${event.raw}\n\n`);
        continue;
      }
      if (event.data === "[DONE]") {
        shape.finish();
        // [DONE] ends the answer: stop reading, even if the upstream keeps
        // its connection open.
        sawDone = true;
        sink.write(`${event.raw}\n\n`);
        break;
      }
      const chunk = JSON.parse(event.data) as Json;
      if (!isObject(chunk)) throw new CompleteError(502, "upstream_malformed", "the upstream event was not an object");
      accounting.observe(chunk);
      // A provider error inside the stream (OpenRouter sends these) ends it
      // as a failure: whatever usage came before is partial.
      if (isObject(chunk["error"])) {
        throw new CompleteError(502, "upstream_malformed",
          `the upstream stream reported an error: ${String(chunk["error"]["message"] ?? "unknown")}`);
      }
      const choices = shape.observe(chunk);
      const reason = choices[0]?.["finish_reason"];
      if (typeof reason === "string") finish = reason;
      if (isObject(chunk["usage"])) {
        // The usage chunk codemux asked for on the client's behalf is
        // withheld when the client did not ask for it itself.
        // Gateway metadata does not turn an empty-choice usage chunk into
        // content. Published moderation results still belong to the client.
        if (!clientWantsUsage && choices.length === 0 && chunk["moderation"] == null) continue;
      }
      sink.write(`${event.raw}\n\n`);
    }
    if (translator !== null) {
      // A clean end before message_stop is a cut stream: its usage is
      // partial, and the client must not read it as a finished answer.
      if (!translator.complete) {
        throw new CompleteError(502, "upstream_malformed", "the Anthropic stream ended before its final usage and message_stop");
      }
      sink.write("data: [DONE]\n\n");
    } else if (!sawDone) {
      // An OpenAI-wire stream ends with [DONE]; a clean end before it is a
      // cut stream whose usage cannot be trusted as final.
      throw new CompleteError(502, "upstream_malformed", "the stream ended before [DONE]");
    }
    completed = true;
  } catch (error) {
    const failure = error instanceof CompleteError
      ? error
      : new CompleteError(502, "upstream_malformed", `the upstream stream failed: ${error instanceof Error ? error.message : String(error)}`);
    finish = abortFinish(exchange, sink, `stream_error:${failure.code}`);
    sink.write(`data: ${errorBody(failure.code, failure.message)}\n\n`);
  } finally {
    // The translator may have read usage from the event that then failed
    // to translate; the row records the latest count it saw.
    if (translator !== null) {
      governor.settle(ticket, {
        usage: translator.usageSeen ? translator.usage : null, servedModel: translator.model,
        finish: finish ?? abortFinish(exchange, sink, "incomplete"), billable: true,
        costKnown: completed && translator.complete && translator.priceKnown, priceKnown: translator.priceKnown,
      });
    } else {
      governor.settle(ticket, accounting.settlement(finish ?? abortFinish(exchange, sink, "incomplete"), completed));
    }
    sink.end();
  }
}
