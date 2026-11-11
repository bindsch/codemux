---
read_when: "Pointing a measurement harness at a hosted model through codemux complete, or checking its caps, ledger rows, or Anthropic field mapping."
---
# Complete

`codemux complete` brokers plain chat completions, with native tool calls,
from hosted models to a research harness that runs its own agent loop as the
object of an experiment. Agent runs (`codemux run`) are the wrong tool there:
the harness under study must own every turn. `complete` gives those
completions the governance codemux gives agent runs: a named API key, a hard
spend cap, and a row in the call ledger for every request.

## The consumer contract

```sh
codemux complete serve --provider anthropic --budget-usd 20 --max-requests 500 \
  --label study=eA --label arm=gadget
```

`serve` prints exactly one JSON line on stdout, then serves until SIGTERM,
SIGINT, SIGHUP, or a cap:

```json
{"base_url":"http://127.0.0.1:53817/v1","token":"<per-run token>","pid":4242,"provider":"anthropic","upstream_host":"api.anthropic.com","budget_usd":20,"max_requests":500,"prices_as_of":"2026-11-10"}
```

Point any OpenAI client at `base_url` with `token` as its API key:

```python
from openai import OpenAI
client = OpenAI(base_url=ready["base_url"], api_key=ready["token"])
reply = client.chat.completions.create(
    model="claude-sonnet-4-5", max_tokens=1024, temperature=0,
    messages=[{"role": "user", "content": "Archive the inbox."}],
    tools=[{"type": "function", "function": {"name": "read_mail", "parameters": {"type": "object", "properties": {}}}}],
)
```

- The server binds 127.0.0.1 only and serves one route,
  `POST /v1/chat/completions`, streaming (`"stream": true`, server-sent
  events ending in `data: [DONE]`) and non-streaming.
- Every request must carry `Authorization: Bearer <token>`. A request without
  it gets 401 and writes no ledger row. The token is new on every start.
- `tools` and `tool_calls` pass through unchanged on the OpenAI wire; the
  Anthropic translation keeps tool names, schemas, call ids, and arguments.
- A refusal by codemux uses the OpenAI error shape with
  `"type": "codemux_error"` and a `code`: `unauthorized`, `bad_request`,
  `cannot_translate`, `model_not_priced`, `budget_exhausted`, `cost_unknown`,
  `request_cap_reached`, `shutting_down`, `not_found`,
  `method_not_allowed`, `payload_too_large` (bodies over 32 MiB),
  `upstream_unreachable`, or `upstream_malformed`. An upstream error passes
  through with its own status; Anthropic's error body is rewritten into the
  OpenAI shape with the same message and type. A stream that fails after it
  started ends with one `data: {"error": …}` event and no `[DONE]`, and
  codemux cancels the upstream stream so the provider stops generating.
  Upstream redirects are refused (`upstream_unreachable`), never followed,
  so the key never reaches another host.
- `codemux complete once -f req.json --provider …` forwards one request from
  a file and prints the answer on stdout. It does not stream.

| Error code | HTTP status | Condition |
|---|---|---|
| `unauthorized` | 401 | Missing or wrong bearer token |
| `bad_request` | 400 | Invalid JSON, request shape, or malformed mapped value |
| `cannot_translate` | 400 | A request feature has no exact Anthropic equivalent, including an omitted output cap or temperature above 1 and at most 2 |
| `model_not_priced` | 400 | No table price or override, outside OpenRouter |
| `budget_exhausted` | 429 | Settled spend reached the dollar cap |
| `cost_unknown` | 429 | Earlier billable usage could not establish the full cost |
| `request_cap_reached` | 429 | Admitted requests reached the request cap |
| `shutting_down` | 503 | A stop signal is shutting down the server |
| `not_found` | 404 | Wrong route |
| `method_not_allowed` | 405 | Non-POST request to the completion route |
| `payload_too_large` | 413 | Request body exceeds 32 MiB |
| `upstream_unreachable` | 502 | Upstream connection failed or returned a redirect |
| `upstream_malformed` | 502 | Invalid upstream response or incomplete stream; after streaming starts, carried in an error event under HTTP 200 |

SSE parsing follows the [WHATWG event-stream rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation):
CR, LF, and CRLF line endings, one initial UTF-8 BOM, comments, literal
field names, and one optional space after the colon. Empty data fields are
preserved; EOF without a terminating blank line discards the pending event.
The broker does not reconnect, so `id` and `retry` have no local effect.

## Providers and keys

| `--provider` | Upstream | Default key variable |
|---|---|---|
| `anthropic` | `https://api.anthropic.com/v1/messages`, translated | `ANTHROPIC_API_KEY` |
| `openai` | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` |
| `openai-compatible` | `--base-url` + `/chat/completions` (required) | none: `--key-env` is required |

The default key variable applies only on the provider's own host. A
`--base-url` that names another host (a gateway, a proxy, a local server)
needs `--key-env`, so a provider key exported in a shell profile is never
sent to a third party by default. `--key-env NAME` names another variable. The key is read from that variable
and nowhere else: never argv, never a file codemux writes, never the
Keychain. codemux refuses to start without it, refuses a value where a name
belongs, and refuses an OAuth subscription token (`CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_AUTH_TOKEN`, `CODEX_OAUTH_TOKEN`, an `sk-ant-oat…` value, or a
JWT access token). This
command is paid per-token API use; subscription quota stays with the
harnesses, so the usagemux quota gate is not consulted. `--base-url` must be
https, or plain http to a loopback host, so the key never crosses a network
in cleartext.

Upstream connections are direct by default. Before any fetch, the broker
removes `http_proxy`, `HTTP_PROXY`, `https_proxy`, `HTTPS_PROXY`, `all_proxy`,
`ALL_PROXY`, `no_proxy`, and `NO_PROXY` from its process environment. These
are the case variants listed in [Bun's proxy documentation](https://bun.sh/docs/runtime/networking/fetch#proxying-requests).
They stay removed for the process lifetime; the parent shell is unaffected.
The broker does not interpret proxy exclusions.
On pinned Bun 1.3.14, each value is cleared before deletion to clear the
runtime's native environment map too; [Bun's environment binding](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/JSEnvironmentVariableMap.cpp)
documents that deletion alone leaves that map stale.

To use a proxy, pass `--proxy http://127.0.0.1:3128` to `serve` or `once`.
The value must be an absolute HTTP(S) proxy URL without a path, query, or
fragment. It is passed explicitly as Bun fetch's `proxy` option. The
upstream must use HTTPS: `--proxy` with a plain-http upstream is refused
at startup (exit 64), including loopback upstreams and HTTPS proxies.
Environment exclusions cannot bypass an explicit proxy.

A 200 answer that carries an `error` object
is answered with that error's status (or 502 for an absent or invalid status),
even if it also carries completion fields. An `error` event inside a stream
ends it as a failure. Reading stops at `[DONE]` or `message_stop`, even if
the upstream keeps its connection open.

Success follows the providers' published response types. OpenAI messages may
omit content; optional fields accept null, whole tool calls may be function or
custom calls, and choice lists may be empty. Streams end at `[DONE]`; a chunk's
finish reason is optional, including audio expiry updates after a finished
choice. Full usage is still required to settle a known cost. A malformed
whole answer returns 502 `upstream_malformed`; a malformed stream emits an
error event. Usage, reported charges, and the served model are read before
validation, including from error envelopes, non-2xx bodies, and failing stream
events. All use the same model and tier pricing rules. A non-2xx response
without billing evidence is unbilled; an unreadable error body or one over
1 MiB returns 502 and stops with `cost_unknown`. Partial counts remain visible in the ledger, with
missing counts recorded as null. Partial charges count toward spend, while
the unknown-cost stop still applies.
Supplied non-object usage (for example, `"usage": []`) also stops with
`cost_unknown`, even after earlier valid counts or before later valid
usage. Earlier counts and reported charges remain in the ledger, but
cannot establish a complete cost. Null or absent usage on stream events
does not invalidate counts. Malformed usage on a non-2xx response is
billing evidence, so that response cannot be assumed unbilled.

On the OpenAI wire the request body goes upstream unchanged except for two
governance fields: a streamed request gets `stream_options.include_usage`
(empty-choice usage chunks are withheld from a client that did not ask for
them, including gateway metadata; chunks with moderation are retained), and an
OpenRouter request gets `"usage": {"include": true}` so OpenRouter reports
its charge. With `--provider openai` only, a `service_tier` other than
`default` or `flex` (such as `priority`) is refused with 400
`bad_request`, because the price table prices the standard tier only, and
an answer that reports a premium tier anyway (a project whose default tier
is not standard) stops the server with `cost_unknown`. OpenRouter reports
its own charge, and an `openai-compatible` upstream names its own tiers,
so neither is judged. A stream that ends before `data: [DONE]` gets an
error event and stops the server with `cost_unknown`, even when it carried
a partial provider charge (which is counted), as does a usage
object without both `prompt_tokens` and `completion_tokens`, an upstream
connection reset after the request was sent, and an answer served by a
model other than the one requested (or that alias's own dated snapshot)
that the table does not price. A whole
answer comes back byte for byte; a stream comes back event by event, each
event's text unchanged and its separator written as a blank line (`\n\n`).

## Caps

- `--max-requests N` counts every request forwarded upstream, at admission.
  A refusal before forwarding (a request that cannot translate, a model
  without a price) does not count.
- `--budget-usd N` counts the estimated cost of every answer. Before a
  request is forwarded, codemux compares the spend already settled with the
  budget. Requests already in flight when the budget is crossed still finish
  and are counted, so the overshoot is bounded by what those requests cost;
  a harness that sends one request at a time overshoots by at most one
  answer. A request the upstream accepted whose full usage never arrives
  (a 2xx answer without a usage object, a stream cut before its usage
  chunk, a request aborted by the timeout or a client that went away after
  it was sent) may still be billed, so its row records what was seen and
  the server stops with `cost_unknown`. On OpenRouter `usage.include` is
  forced to `true`, even over a client's `false`, so the charge comes back.
  A whole answer over 64 MiB is a 502 at an unknown cost.
- A client disconnect during an answer cancels the upstream, records
  `client_closed`, and stops with `cost_unknown`. The native Bun HTTP
  server reports disconnects on both the pinned Bun 1.3 and Bun 1.4.
- Uploads have a separate body deadline using `--timeout`. An incomplete
  upload records `refused:bad_request` and consumes no upstream request.
  A connected client receives a complete JSON error response. A signal
  during upload records `interrupted`.
- Once a cap is reached, a request that arrives while the requests in
  flight finish gets HTTP 429 with code `budget_exhausted`,
  `request_cap_reached`, or `cost_unknown`. The server then stops and the
  process exits, so a later request finds the port closed (a connection
  error): a harness that sends one request at a time sees the exit, not a
  429. A closing line on stderr names the cap, the request count, and the
  estimated spend. Each HTTP connection closes after its response.
  Cap shutdown waits for all pending response writes,
  including large bodies and streams sent to slow readers. There is no
  response-drain deadline; a client that stops reading can delay exit
  until it disconnects or a stop signal aborts the server.
- Cost is the provider's own charge when it reports one (OpenRouter
  `usage.cost`), else the reported tokens priced with the table in
  `src/complete/prices.ts`. Prices are USD per million tokens as of the date
  printed in `prices_as_of`, at the standard tier, read from
  [Anthropic's](https://platform.claude.com/docs/en/about-claude/pricing)
  and [OpenAI's](https://developers.openai.com/api/docs/pricing) price
  pages on 2026-11-10; check them against those pages before a paid
  campaign. Anthropic cache writes cost 1.25x the input price and cache
  reads 0.1x, except 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable
  and Mythos 5.1 and 5.2; Claude Haiku 5.5 prompts over 100,000 tokens
  (cache reads and writes included) pay its higher long-context prices for
  every token. OpenAI cached input has its own listed price. Supplied
  malformed token counts or charges make cost unknown, as do contradictory
  totals or subtotals (for example cached tokens above prompt tokens).
  Counts must be nonnegative safe integers; charges must be finite and
  nonnegative. Invalid evidence remains unknown after later valid events.
  Valid reported charges are still recorded and counted, while uncertainty
  triggers the stop. Unpriced billing dimensions
  also stop with `cost_unknown`: Anthropic server tools, one-hour cache
  writes, nonstandard tiers, fast inference, or non-global inference;
  OpenAI audio tokens or cache-write tokens. Null or omitted optional
  cache counts mean no cache usage. OpenAI's regional-processing uplift
  is not modeled. Left out of the table, and so refused unless
  the price flags below are given: models the pages no longer list
  (`claude-3-5-haiku`, `gpt-4.1-nano`, `o4-mini`), `gpt-5.4` and `gpt-5.5`
  (their prices above 272K tokens were not readable from the page), and
  `gpt-5.6-*` and `gpt-6-*` (their cache-write prices are not modeled). A
  model id matches its table entry without an OpenRouter vendor prefix
  and, for Claude ids only, without a snapshot date
  (`claude-sonnet-4-5-20250929`). OpenAI prices some snapshots apart from
  their base model, so a dated OpenAI id (`gpt-4o-2024-05-13`) the table
  does not list is refused rather than priced as its base.
- A model the table does not list is refused with `model_not_priced` unless
  `--input-usd-per-mtok` and `--output-usd-per-mtok` price it (they then
  price every model on that server). On OpenRouter an unlisted model is
  served, because the charge comes back with the answer; if an answer
  arrives without a charge and the model has no price, the server stops:
  the budget cannot be kept without a number.
- SIGTERM, SIGINT, or SIGHUP stops `serve` or `once`, aborting requests in
  flight; their rows record `finish: "interrupted"`. The process exits 143,
  codemux's exit for a handled termination signal. A stop at a cap exits 0,
  so a supervisor can tell the two apart.

## Ledger

Every authenticated request to `POST /v1/chat/completions` appends one row
to the [call ledger](results-and-usage.md#call-ledger) with
`kind: "complete"`, including one whose body never arrived whole
(`refused:bad_request`, or `interrupted` when a stop signal cut it) and
one that arrives after a stop signal (`refused:shutting_down`). Requests
to another path or with another method (404, 405) write none. Rows follow
the ledger's own rules: `CODEMUX_CALL_LOG=off` turns them off, and a write
that fails warns once on stderr while the server keeps serving; the caps
are kept in memory and hold either way:

| Field | Value |
|---|---|
| `agent` | null: no harness serves the call |
| `model`, `model_effective` | The model requested and the model the provider says served it |
| `provider` | The upstream host (`api.anthropic.com`) |
| `usage` | Uncached input, cached input (reads plus writes), output, and total tokens, and the cost |
| `cost_source` | `billed` for a provider-reported charge, `price-table` for codemux's estimate, null when no cost could be recorded. Errors and incomplete responses can still carry usage or partial charges. |
| `finish` | The OpenAI finish reason (`stop`, `length`, `tool_calls`, `content_filter`, `function_call`); `refused:<code>` for a codemux refusal; `upstream_error:<status>`; `upstream_unreachable`, `upstream_malformed`, `untranslatable`, `stream_error:<code>`, `interrupted`, or `client_closed`; `unknown` for an OpenAI answer without a finish reason; `incomplete` for a stream that ended with neither a finish reason nor an error |
| `duration_ms` | Wall time from admission to the settled answer |
| `labels` | The `--label` pairs, or `CODEMUX_LABELS` |

The row never holds the prompt text, the answer, or the key.
`codemux calls --kind complete --sum` totals them; `--label` and `--by`
select a study or an arm. The price-table estimate prints on its own line
below the totals, which carry provider-billed charges only.

## Anthropic mapping

The translation is exact or refused, naming the field: `cannot_translate`
when the field has no Anthropic equivalent, `bad_request` when its value is
malformed (a `top_p` outside [0, 1], nonpositive or disagreeing `max_tokens`,
a nonnumeric `temperature`, a `stop` that is not strings). A missing output
cap and a valid OpenAI temperature in (1, 2] have no Anthropic equivalent;
they return `cannot_translate`. Nothing is dropped silently. codemux adds one field
of its own, `service_tier: "standard_only"`, so an account with Priority
Tier capacity is never served at a premium the price table undercounts.

| OpenAI request | Anthropic Messages request |
|---|---|
| `model` | `model` |
| `max_tokens` or `max_completion_tokens` | `max_tokens`; required, because Anthropic needs an explicit cap |
| leading `system`/`developer` messages | `system` text blocks, in order; one after the first user or assistant turn is refused |
| `user` message, string or text parts | `user` turn with text blocks; an empty one is refused |
| `image_url` part, `data:` URL | `image` block, `base64` source; an `http(s)` URL becomes a `url` source; a `detail` other than `auto` is refused |
| `assistant` content and `tool_calls` | `assistant` turn: text blocks, then `tool_use` blocks with the same `id`, `name`, and `arguments` parsed as `input` (a JSON object, else refused; empty or whitespace-only strings become `{}`) |
| `tool` message | `tool_result` block with the same `tool_call_id` in a `user` turn; one after a user message in the same turn is refused, because Anthropic wants tool results first |
| consecutive turns of one role | merged into one turn, as Anthropic itself does |
| `temperature` | `temperature`; above 1 is refused (OpenAI allows up to 2) |
| `top_p` | `top_p`; a non-number or a value outside [0, 1] is refused |
| `stop` | `stop_sequences` |
| `tools[].function` | `tools[]`: `name`, `description` (a string when present, otherwise refused), `parameters` as `input_schema` (an empty object schema when absent or null; any other non-object is refused); `strict: true` is refused |
| `tool_choice` `auto` / `none` / `required` / named function | `auto` / `none` / `any` / `tool` with the name |
| `parallel_tool_calls: false` | `tool_choice.disable_parallel_tool_use: true` |
| `user` | `metadata.user_id` |
| `stream` | `stream`; `stream_options.include_usage` adds the final usage chunk |
| `n: 1`, `store: false`, zero penalties, `logprobs: false`, `response_format: {"type": "text"}`, null `seed` | accepted as no-ops |
| `seed`, `n` > 1, nonzero penalties, `logit_bias`, `logprobs`, other `response_format`, `metadata`, audio, `reasoning_effort`, a message `name` or any other message field the role does not carry, a non-string `function.arguments`, a `function` role, `refusal` | refused |

| Anthropic answer | OpenAI answer |
|---|---|
| `id`, `model` | `id`, `model` (the served model) |
| text blocks | `message.content`, joined; null when there is none |
| `tool_use` blocks | `message.tool_calls`: same `id`, `name`, `input` serialized as `arguments` |
| entire message / native stream event | top-level `anthropic` extension, preserving native content and optional metadata |
| `stop_reason` `end_turn`, `stop_sequence` / `max_tokens`, `model_context_window_exceeded` / `tool_use` / `refusal` | `finish_reason` `stop` / `length` / `tool_calls` / `content_filter` |
| `stop_reason` `pause_turn` / null or omitted | `finish_reason` `stop` / null; original reason retained in `anthropic` |
| `usage` | `prompt_tokens` = input + cache reads + cache writes, `completion_tokens` = output, `prompt_tokens_details.cached_tokens` = cache reads |
| stream `message_start`, `text_delta`, `tool_use` start, `input_json_delta`, `message_delta`, `message_stop` | `chat.completion.chunk` events: the assistant role, `delta.content`, a `tool_calls` entry with id and name, its `arguments` fragments, the finish reason, the usage chunk |

`ping` events produce nothing. Every other native event is retained in
the top-level `anthropic` field of its translated chunk. Events without an
OpenAI delta use empty choices. `content_block_stop` also supplies
`arguments: "{}"` for a client tool call that streamed no arguments.
Thinking, citations, server-tool results, and other published content
variants remain in the native extension; server tools are never presented
as client tool calls. Invalid blocks, unknown discriminators, and error
events still fail with 502 `upstream_malformed`. The row records the usage
seen; incomplete or unpriced usage stops the server with `cost_unknown`.
A stream counts as finished only
after `message_delta` carried its final usage and `message_stop` closed it:
one that ends cleanly before that gets an error event instead of
`[DONE]`, and the server stops with `cost_unknown`. A whole answer without
a `usage` object stops it the same way. Final usage remains valid when a
gateway sends the stop reason in a separate subsequent delta.

## What it does not do

- It does not run an agent, tools, or a sandbox: the caller's harness does.
- It does not use subscription accounts or consult usagemux quota.
- It does not read keys from files or the Keychain, and does not store them.
- It does not serve other OpenAI routes (`/v1/models`, embeddings,
  responses) or listen on anything but 127.0.0.1.
- It does not retry: a provider error goes back to the caller, which owns
  its retry policy and its effect on the measurement.
- Its cost is an estimate from reported usage, not an invoice.
