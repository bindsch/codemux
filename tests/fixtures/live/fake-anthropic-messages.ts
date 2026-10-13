/**
 * A logging fake of an Anthropic Messages endpoint (`POST /v1/messages`),
 * for live-driving `codemux session`/`run -a claude` under the provider
 * override when no real Messages endpoint is available or a request
 * receipt is wanted. Two modes:
 *
 *   canned (default) — answers every /v1/messages request itself, in the
 *     wire shape the claude binary speaks (plain JSON, or SSE when the
 *     request asked `stream: true`), so a whole session completes. The
 *     model it plays: a plant/recall protocol over the conversation the
 *     client replays — every request carries the full history, so the
 *     "memory" is read out of the request body, not kept server-side:
 *       - a user turn containing "code word <token>" is answered "noted"
 *       - "17 + 25" is answered "42"
 *       - a later turn asking "what was the code word" is answered with
 *         the first token planted in an EARLIER user turn
 *       - anything else is answered "noted"
 *   proxy (FAKE_UPSTREAM=<url>) — forwards every request to the upstream
 *     verbatim and relays its status and body back, logging what passed
 *     through. This is the receipt: the real endpoint's own answers
 *     (including its rejections) come back untouched while the log names
 *     the model and path of every request that left the client.
 *
 * Everything received is recorded as JSONL under $FAKE_STATE_DIR
 * (messages.jsonl): one line per request — method, path, the model the
 * body named, whether an authorization credential rode the headers
 * (boolean only; the value is never recorded), the message count, and in
 * proxy mode the upstream status. GET /v1/models is answered with a
 * one-model list when not proxied, so client-side capability probes
 * pass. The server listens on an ephemeral 127.0.0.1 port, prints
 * `FAKE_ENDPOINT http://127.0.0.1:<port>` on stderr, writes the same URL
 * to $FAKE_STATE_DIR/endpoint, and runs until killed.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR;
if (!stateDir) {
  console.error("fake-anthropic-messages: FAKE_STATE_DIR is required");
  process.exit(64);
}
mkdirSync(stateDir, { recursive: true });
const logPath = join(stateDir, "messages.jsonl");

function record(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

/** Every text a request's user messages carried, in order — the history
 * the client replays is the whole conversation, so later turns still
 * see the earlier plants. */
function userTexts(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const texts: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const role = (message as Record<string, unknown>).role;
    if (role !== "user") continue;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }
  return texts;
}

/** The canned model's answer for one request, from the replayed history. */
function cannedReply(body: Record<string, unknown>): string {
  const texts = userTexts(body);
  const last = texts[texts.length - 1] ?? "";
  if (/what was the code word/i.test(last)) {
    // The plant is a "code word <token>" in an EARLIER user turn; the
    // asking turn itself must not answer itself.
    const plants: string[] = [];
    for (const text of texts.slice(0, -1)) {
      // The plant may read "code word X" or "code word: X".
      for (const match of text.matchAll(/code word:?\s*([a-z0-9-]+)/gi)) {
        plants.push(match[1] ?? "");
      }
    }
    if (plants.length > 0) return plants[0] ?? "no code word was planted";
    return "no code word was planted";
  }
  if (last.includes("17 + 25")) return "42";
  return "noted";
}

const messageId = () => `msg_fake_${Math.random().toString(36).slice(2, 10)}`;

/** A complete non-streaming Messages response. */
function jsonResponse(body: Record<string, unknown>, reply: string): string {
  return JSON.stringify({
    id: messageId(),
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : "fake-model",
    content: [{ type: "text", text: reply }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** The same answer as an Anthropic SSE stream (the wire the claude
 * binary speaks when it asked for `stream: true`). */
function sseChunks(body: Record<string, unknown>, reply: string): string {
  const events: [string, Record<string, unknown>][] = [
    ["message_start", {
      type: "message_start",
      message: {
        id: messageId(),
        type: "message",
        role: "assistant",
        model: typeof body.model === "string" ? body.model : "fake-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const authPresent =
      request.headers.get("authorization") !== null ||
      request.headers.get("x-api-key") !== null;
    const log = (extra: Record<string, unknown> = {}): void => {
      record({
        ts: new Date().toISOString(),
        method: request.method,
        path: url.pathname,
        auth_present: authPresent,
        ...extra,
      });
    };

    // Proxy mode: forward verbatim, relay the upstream's answer, and log
    // only what passed through (the model from the parsed body, never a
    // credential).
    const upstream = process.env.FAKE_UPSTREAM;
    if (upstream) {
      const bodyText = await request.text();
      let model: string | null = null;
      let messageCount = -1;
      let stream = false;
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        model = typeof parsed.model === "string" ? parsed.model : null;
        messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : -1;
        stream = parsed.stream === true;
      } catch {
        // Not JSON (or empty): forwarded as-is, logged without a model.
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      let upstreamStatus = -1;
      let answer: Response;
      try {
        const forwarded = await fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : bodyText,
        });
        upstreamStatus = forwarded.status;
        answer = new Response(forwarded.body, {
          status: forwarded.status,
          headers: forwarded.headers,
        });
      } catch (error) {
        upstreamStatus = -2;
        answer = new Response(
          JSON.stringify({ type: "error", error: { type: "api_error", message: `fake upstream unreachable: ${String(error)}` } }),
          { status: 502, headers: { "content-type": "application/json" } }
        );
      }
      log({ model, message_count: messageCount, stream, upstream_status: upstreamStatus });
      return answer;
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      log();
      return Response.json({
        object: "list",
        data: [
          {
            id: "clawvm-qwen32b-coder",
            object: "model",
            created: 0,
            owned_by: "fake",
          },
        ],
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      log();
      return Response.json({ input_tokens: 100 });
    }

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const bodyText = await request.text();
      let body: Record<string, unknown> = {};
      let model: string | null = null;
      let messageCount = -1;
      let systemRoleEntries = 0;
      let stream = false;
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
        model = typeof body.model === "string" ? body.model : null;
        stream = body.stream === true;
        if (Array.isArray(body.messages)) {
          messageCount = body.messages.length;
          systemRoleEntries = body.messages.filter(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as Record<string, unknown>).role === "system"
          ).length;
        }
      } catch {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "body is not JSON" } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      log({ model, message_count: messageCount, system_role_entries: systemRoleEntries, stream });
      const reply = cannedReply(body);
      if (stream) {
        return new Response(sseChunks(body, reply), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(jsonResponse(body, reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    log();
    return new Response(
      JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no such route: ${request.method} ${url.pathname}` } }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  },
});

const endpoint = `http://127.0.0.1:${server.port}`;
appendFileSync(join(stateDir, "endpoint"), endpoint);
console.error(`FAKE_ENDPOINT ${endpoint}`);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
