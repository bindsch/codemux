import type {
  AgentId,
  CodemuxResultBlock,
  ResultUsageBlock,
  RunRequest,
  RunResult,
} from "./types.js";

/**
 * The `codemux` block and the codex event-stream handling behind
 * `--result-json`. Claude-family harnesses and Antigravity print one JSON
 * envelope of their own, which is kept verbatim with the block appended;
 * codex prints JSONL
 * events, which codemux reduces to the same promise: `result` holds the
 * final assistant message as plain text and the block carries the numbers.
 * A turn whose only message item is a Plan has none in the stream (see
 * `CODEX_FINAL_MESSAGE_FALLBACK_NOTE`), so the reduction also accepts the final
 * message codex itself records through `--output-last-message`.
 */

export function emptyUsage(): ResultUsageBlock {
  return {
    input_tokens: null,
    output_tokens: null,
    cached_input_tokens: null,
    total_tokens: null,
    cost_usd: null,
  };
}

function reportedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Appends one codemux diagnostic after the harness's own stderr, separating
 * the two with a newline even when the harness's last line was unterminated:
 * appending straight onto `"boom"` produced `"boomcodemux: ..."`, gluing the
 * codemux line onto the harness's and corrupting the line-oriented
 * diagnostics a caller parses (round10). An empty stderr gains nothing but
 * the line itself.
 */
export function appendDiagnostic(stderr: string, line: string): string {
  const separated =
    stderr === "" || stderr.endsWith("\n") ? stderr : `${stderr}\n`;
  return `${separated}${line}\n`;
}

export interface ClaudeEnvelopeInfo {
  envelope: Record<string, unknown>;
  usage: ResultUsageBlock;
  /** The model that served the run, when the envelope names exactly one. */
  servedModel: string | null;
  /**
   * True when the envelope's `modelUsage` names several models: no one model
   * served the run, so no model may be reported for it.
   */
  multipleModels: boolean;
  /**
   * True when the envelope reports its own failure: `is_error: true`, or a
   * subtype that names one (`error_during_execution`, `error_max_turns`, ...).
   * The harness can fail while exiting 0, and a wrapper can mask the exit
   * code, so the verdict reads the envelope rather than trusting the exit.
   */
  isError: boolean;
  /** The envelope's `subtype` when it names an error, else null. */
  errorSubtype: string | null;
}

/**
 * Parses the single JSON result object Claude Code prints for headless runs
 * launched with `--output-format json` (`claude --help`: json is "single
 * result"). Returns null when stdout is not that object -- an older binary,
 * a wrapper, JSON that is not the result envelope, or an envelope that
 * reports no outcome at all -- and the caller treats that as the contract
 * violation it is.
 *
 * The envelope's `usage` counts come from the Anthropic Messages API, where
 * `input_tokens` excludes the cache; the cache read and write counts become
 * `cached_input_tokens` so the three fields sum to the whole conversation.
 */
export function parseClaudeResultEnvelope(
  stdout: string
): ClaudeEnvelopeInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  // `type: "result"` is the envelope's discriminator. `{}` and every other
  // JSON object parse cleanly yet carry no result, so treating any object as
  // the envelope would report unrelated stdout as a successful run.
  if (envelope.type !== "result") {
    return null;
  }
  // The discriminator alone is not a result either: `{"type":"result"}` --
  // a malformed wrapper response -- names neither the `result` text nor a
  // status, so it reports no outcome at all and accepting it would turn
  // an envelope that says nothing into a successful run. A successful
  // envelope owes its `result` text; only a failing one may omit it,
  // because `is_error: true` or an `error_*` subtype names the outcome
  // (a failure) and fails the run downstream. A bare non-error `subtype`
  // is not an outcome: `{"type":"result","subtype":"success"}` satisfied
  // this check while carrying no reply, and any string -- the empty one
  // included -- counted.
  const errorSubtype =
    typeof envelope.subtype === "string" && envelope.subtype.startsWith("error")
      ? envelope.subtype
      : null;
  const isError = envelope.is_error === true || errorSubtype !== null;
  if (typeof envelope.result !== "string" && !isError) {
    return null;
  }

  const usage = emptyUsage();
  if (typeof envelope.usage === "object" && envelope.usage !== null) {
    const reported = envelope.usage as Record<string, unknown>;
    usage.input_tokens = reportedCount(reported.input_tokens);
    usage.output_tokens = reportedCount(reported.output_tokens);
    // A reported zero stays zero: the harness did report the cache count,
    // and null would drop a known number. Both counts must be reported:
    // summing a reported one with an unreported one guesses the missing
    // half as zero, so a one-sided report stays null.
    const cacheRead = reportedCount(reported.cache_read_input_tokens);
    const cacheWrite = reportedCount(reported.cache_creation_input_tokens);
    if (cacheRead !== null && cacheWrite !== null) {
      usage.cached_input_tokens = cacheRead + cacheWrite;
    }
  }
  // The total is their sum plus output, computed only when all three are
  // known; `{output_tokens: 5}` once produced 5 by guessing the rest as zero.
  if (
    usage.input_tokens !== null &&
    usage.cached_input_tokens !== null &&
    usage.output_tokens !== null
  ) {
    usage.total_tokens =
      usage.input_tokens + usage.cached_input_tokens + usage.output_tokens;
  }
  usage.cost_usd = reportedCount(envelope.total_cost_usd);

  let servedModel: string | null = null;
  let multipleModels = false;
  if (
    typeof envelope.modelUsage === "object" &&
    envelope.modelUsage !== null
  ) {
    const models = Object.keys(envelope.modelUsage as Record<string, unknown>);
    if (models.length === 1 && models[0] !== "") servedModel = models[0] ?? null;
    multipleModels = models.length > 1;
  }

  return { envelope, usage, servedModel, multipleModels, isError, errorSubtype };
}

/**
 * Finishes a `--result-json` run for a Claude-family harness: the envelope
 * is re-emitted with every original field untouched plus the codemux block.
 * Stdout that is not the envelope breaks the contract the launch made (it
 * ran with `--output-format json`, whose single result is that object), so
 * the run fails loudly: the raw stdout stays on stdout, stderr says what is
 * missing, and the exit is non-zero -- a silent success without the block
 * would leave the caller parsing nothing. An envelope that reports its own
 * failure (`is_error`, or an `error_*` subtype) fails the run the same way:
 * the harness can fail while exiting 0, and a wrapper can mask the exit
 * code, so the structured report is read rather than the exit trusted; the
 * envelope is still emitted (its fields are the harness's own record of the
 * failure) and stderr carries the codemux line. An envelope whose result
 * text is empty or whitespace-only fails the run too: a reply of spaces and
 * newlines is no reply (round10 for "", round17 for whitespace-only), so it
 * must not pass as a successful run a caller could record as having no
 * output.
 */
export function claudeFamilyResult(
  result: RunResult,
  request: RunRequest,
  agent: AgentId
): RunResult {
  const parsed = parseClaudeResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no result envelope, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  // The envelope's reply is absent when it named no result text, the empty
  // one, or a whitespace-only one: a reply of spaces and newlines is no
  // reply -- the same rule prompt validation applies to input -- and the
  // structured path must not turn it into a successful result a caller
  // could record as a run with no output.
  const replyAbsent =
    typeof parsed.envelope.result !== "string" ||
    parsed.envelope.result.trim() === "";
  const block = (): CodemuxResultBlock => ({
    agent,
    // The served model when the envelope names it, else the model codemux
    // selected, else null: the harness default, which nothing reported.
    // Several modelUsage entries are a report in the other direction -- the
    // run was served by more than one model -- so the requested model must
    // not stand in; only a run that names no models at all falls back.
    model: parsed.multipleModels
      ? null
      : parsed.servedModel ?? request.model ?? null,
    usage: parsed.usage,
    // Always null in this release: the adapter passes
    // --no-session-persistence, so no run leaves a session a later resume
    // could reach (reserved for the live-sessions release; see types.ts).
    session_id: null,
  });
  if (parsed.isError) {
    // The subtype is the specific reason when the envelope names one; the
    // bare flag is the whole reason when it does not.
    const reason =
      parsed.errorSubtype !== null
        ? `subtype "${parsed.errorSubtype}"`
        : "is_error: true";
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} reported an error result ` +
          `(${reason}), so this run fails even though the harness exited ` +
          `${result.exitCode}`
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  if (replyAbsent) {
    // Fail closed: the envelope still goes out with the block attached (its
    // fields are the harness's own record), but the run reports no result.
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed an envelope with no ` +
          "result text, so this --result-json run reports no result"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  return {
    ...result,
    stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
  };
}

export interface AgyEnvelopeInfo {
  envelope: Record<string, unknown>;
  usage: ResultUsageBlock;
  /** The envelope's `status` string; "SUCCESS" on success. */
  status: string;
  /** The envelope's `error` text when it names one as a string. */
  errorText: string | null;
  /**
   * True when the envelope reports its own failure: any status other than
   * "SUCCESS" (ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING) or
   * a non-null `error`. The harness can fail while exiting 0, and a
   * wrapper can mask the exit code, so the verdict reads the envelope
   * rather than trusting the exit.
   */
  isError: boolean;
}

/**
 * Parses the single JSON result object Antigravity CLI prints for print
 * mode launched with `--output-format=json` (the `=` form the pinned
 * 1.2.14 requires). The shape is pinned against
 * 1.2.14 by the official headless documentation and the binary's own JSON
 * tags (no login was available to record a live envelope; the pin is
 * documented, not live-verified): `status`, `response`, `error`,
 * `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
 * total_tokens}`. Returns null when stdout is not that object, and the
 * caller treats that as the contract violation it is.
 *
 * Usage arithmetic, from every documented example: `total_tokens` is
 * `input_tokens + output_tokens`, where `input_tokens` INCLUDES the
 * cache-read count and `thinking_tokens` sits outside the total entirely.
 * The normalized block therefore reports `input_tokens` (the raw value)
 * minus `cache_read_tokens` as uncached input, keeps `cache_read_tokens`
 * as `cached_input_tokens`, and computes `total_tokens` as the sum of
 * those three -- the cross-harness rule (README: "only when every
 * component was reported"). The sum reproduces the total agy itself
 * reports whenever every component was reported (the subtraction gives
 * the cache reads back), and a reported total over missing components is
 * not echoed: it would publish a number whose own addends are null.
 * `thinking_tokens` has no normalized counterpart and stays unmapped, and
 * `cost_usd` is null because the envelope carries no cost.
 */
export function parseAgyResultEnvelope(
  stdout: string
): AgyEnvelopeInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  // `status` is the envelope's discriminator: `{}` and every other JSON
  // object parse cleanly yet carry no outcome, so accepting them would
  // report unrelated stdout as a successful run.
  if (typeof envelope.status !== "string" || envelope.status === "") {
    return null;
  }
  const errorText =
    typeof envelope.error === "string" ? envelope.error : null;
  const isError = envelope.status !== "SUCCESS" || envelope.error != null;
  // The discriminator alone is not a result either: an envelope owes its
  // `response` text, and only a failing one -- a non-SUCCESS status or a
  // named error -- may omit it, because that names the outcome (a
  // failure) and fails the run downstream. `{"status":"SUCCESS"}` says
  // nothing at all.
  if (typeof envelope.response !== "string" && !isError) {
    return null;
  }

  const usage = emptyUsage();
  if (typeof envelope.usage === "object" && envelope.usage !== null) {
    const reported = envelope.usage as Record<string, unknown>;
    const input = reportedCount(reported.input_tokens);
    const output = reportedCount(reported.output_tokens);
    // A reported zero stays zero: the harness did report the count, and
    // null would drop a known number. The raw input includes the cache
    // reads, so uncached input is their difference and needs both counts:
    // one-sided reports stay null rather than guessing the missing half.
    const cacheRead = reportedCount(reported.cache_read_tokens);
    if (input !== null && cacheRead !== null) {
      usage.input_tokens = Math.max(0, input - cacheRead);
    }
    usage.output_tokens = output;
    usage.cached_input_tokens = cacheRead;
    // The total is computed, never echoed: the sum of the three normalized
    // components, and only when all are known -- which reproduces agy's own
    // total (the subtracted cache reads are added back), while a reported
    // total over missing components would publish a number whose own
    // addends are null (the claude and codex parsers' rule, round 5).
    if (
      usage.input_tokens !== null &&
      usage.cached_input_tokens !== null &&
      usage.output_tokens !== null
    ) {
      usage.total_tokens =
        usage.input_tokens + usage.cached_input_tokens + usage.output_tokens;
    }
  }

  return { envelope, usage, status: envelope.status, errorText, isError };
}

/**
 * Finishes a `--result-json` run for Antigravity: the envelope is re-emitted
 * with every original field untouched plus the codemux block. Stdout that is
 * not the envelope breaks the contract the launch made (it ran with
 * `--output-format=json`), so the run fails loudly -- the raw stdout stays,
 * stderr says what is missing, and the exit is non-zero. An envelope with a
 * non-SUCCESS status or an `error` fails the run the same way: the harness
 * can fail while exiting 0, and the structured report is read rather than
 * the exit trusted. An envelope whose response text is empty or
 * whitespace-only fails too: a reply of spaces and newlines is no reply.
 */
export function agyResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "agy" as const;
  const parsed = parseAgyResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no result envelope, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  // The envelope carries no model field, so the codemux block reports the
  // model codemux selected, else null: the harness default, which nothing
  // reported. `conversation_id` is agy's own and no codemux run can resume
  // it, so session_id stays null like every harness in this release.
  const block = (): CodemuxResultBlock => ({
    agent,
    model: request.model ?? null,
    usage: parsed.usage,
    session_id: null,
  });
  if (parsed.isError) {
    const reason =
      parsed.errorText !== null
        ? `status "${parsed.status}": ${parsed.errorText}`
        : `status "${parsed.status}"`;
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} reported an error result (${reason}), ` +
          `so this run fails even though the harness exited ${result.exitCode}`
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  // The parser guarantees a string response on a non-error envelope; the
  // belt check keeps the guarantee local rather than trusting the caller's
  // reading of it.
  const response =
    typeof parsed.envelope.response === "string"
      ? parsed.envelope.response
      : "";
  if (response.trim() === "") {
    return {
      ...result,
      stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed an envelope with no ` +
          "result text, so this --result-json run reports no result"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  return {
    ...result,
    stdout: `${JSON.stringify({ ...parsed.envelope, codemux: block() })}\n`,
  };
}

export interface CodexEventStream {
  /**
   * The thread codex started, from the single `thread.started` event the
   * grammar promises (a stream without one is rejected at parse).
   */
  threadId: string;
  /**
   * The final assistant message: the last completed `agent_message` item of
   * the stream's LAST turn, which is what codex's own human mode prints on
   * stdout (`final_message_from_turn_items` picks the last AgentMessage).
   * Null when that turn completed without one, and null when the stream
   * failed: a failed turn has no final message, and codex itself discards it
   * (`self.final_message = None` on TurnStatus::Failed) even though earlier
   * `item.completed` events stay in the stream.
   */
  finalMessage: string | null;
  /**
   * The model that served the run when codex rerouted it: a reroute is
   * reported as a completed `error` item whose `message` reads
   * `model rerouted: <from> -> <to> (<reason>)` (exec_events.rs at 0.159.3
   * formats ModelRerouted that way), and the model that answers can then
   * differ from the one codemux selected. Null when the stream reports no
   * reroute; the stream names no model otherwise.
   */
  servedModel: string | null;
  /** This run's token usage, as far as the stream can express it. */
  usage: ResultUsageBlock;
  /**
   * Whether the LAST `turn.completed` carried a usage figure. Each snapshot
   * replaces the previous one, so an earlier turn's figure does not count:
   * a last turn that omits usage leaves the fields null. A failed stream
   * reports no usage at all, so this is false alongside null fields there.
   */
  usageReported: boolean;
  /**
   * Whether every turn the stream opened closed, and at least one closed by
   * completing -- not "the last turn completed": a stream whose last turn
   * failed after an earlier one completed still reports true here, and the
   * failure is `failure`'s to report (every consumer checks `failure`
   * before trusting this field). Item completion is not turn completion
   * upstream (exec_events.rs: a turn "encompasses all events that happen
   * while agent is processing the prompt", and `turn.completed` is emitted
   * when it finishes), so a stream that stops after an `item.completed` --
   * a truncated stream from a zero-exit wrapper, say -- has a message but
   * no completed turn behind it.
   */
  turnCompleted: boolean;
  /**
   * The failure diagnostic: the message of a `turn.failed` event (terminal:
   * no later event clears it) or of the last `error` event that no later
   * matched `turn.completed` superseded, or null when every turn completed.
   * An `error` codex retried is superseded when its turn later completes.
   */
  failure: string | null;
}

/**
 * Reduces the JSONL event stream `codex exec --json` prints on stdout. The
 * event shapes are pinned against the installed codex-cli 0.159.3 (tag
 * rust-v0.159.3), where they are defined in codex-rs/exec/src/exec_events.rs:
 * `thread.started` carries `thread_id`, `turn.started` opens a turn,
 * `item.completed` carries an `agent_message` item with `text`, and a model
 * reroute as an `error` item whose `message` reads
 * `model rerouted: <from> -> <to> (<reason>)`,
 * `turn.completed` carries `usage`, `turn.failed` carries
 * `error: {message}`, and a top-level `error` event carries `message` (a
 * fatal error from the event stream; one that will be retried is followed
 * by a later `turn.completed`).
 *
 * Two semantics come from how exec builds those events
 * (codex-rs/exec/src/event_processor_with_jsonl_output.rs, same tag):
 *
 * - `turn.completed.usage` is the thread's cumulative total, not this turn's
 *   share: `usage_from_last_total` copies `last_total_token_usage`, fed by
 *   ThreadTokenUsageUpdated, whose `total` is the running thread counter
 *   (codex-protocol's TokenUsageInfo keeps `total_token_usage` and
 *   `last_token_usage` apart, and the exec stream exposes only the total).
 *   A thread this run started makes the last snapshot this run's usage, and
 *   the counter is a thread-lifetime total (a resumed thread's snapshot
 *   would include every earlier run), so the reduction keeps the last
 *   snapshot rather than summing snapshots; every codemux run starts its
 *   own thread (`--ephemeral`), so no run's snapshot carries another's.
 * - a failed turn discards the final message, yet the stream keeps any
 *   earlier `item.completed` agent messages, so the reduction refuses to
 *   offer one as the result.
 *
 * Plan items are the one message the stream cannot carry: codex treats the
 * last `Plan` as the turn's final message (`final_message_from_turn_items`
 * falls back to it), but the JSONL mapper drops the item
 * (`map_item_with_id` has no Plan arm), so a turn that ends with only a
 * Plan leaves no message in the stream at all. The caller cannot tell that
 * turn from one that produced nothing, so the reduction leaves
 * `finalMessage` null and the final message codex itself records through
 * `--output-last-message` is the fallback (see
 * `CODEX_FINAL_MESSAGE_FALLBACK_NOTE`).
 *
 * Codex's `input_tokens` INCLUDES its cache breakdowns: the cached reads
 * AND the cache writes are each parts of that total, not additions to it
 * (responses.rs maps `ResponseCompletedUsage` with both as breakdowns;
 * `blended_total` in event_processor_with_human_output.rs subtracts the
 * reads to discount them). The normalized uncached input is therefore
 * `input - cached - cacheWrite`, and both breakdowns join the cached count.
 *
 * Returns null when a line is not a JSON object, when the stream announces
 * no thread, a second one, or one that is not the stream's first event,
 * when a `turn.completed` or `turn.failed` closes a turn no `turn.started`
 * opened, when a `turn.started` opens inside a turn still open or after a
 * turn already completed, or when an item event -- `item.started`,
 * `item.updated`, or `item.completed`, whatever the item's type -- follows
 * the last `turn.completed` with no turn reopened: all are format drift,
 * and the caller says so rather than reporting a partial stream as fact.
 */
export function parseCodexEventStream(stdout: string): CodexEventStream | null {
  const events: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    events.push(parsed);
  }

  let threadId = "";
  let sawThreadStarted = false;
  let finalMessage: string | null = null;
  let servedModel: string | null = null;
  let usage = emptyUsage();
  let usageReported = false;
  // `turn.failed` is terminal: nothing later in the stream clears it. A
  // top-level `error` is softer -- codex retries those, and a later matched
  // `turn.completed` proves the retry recovered.
  let turnFailure: string | null = null;
  let errorFailure: string | null = null;
  // Turns open at `turn.started` and close at `turn.completed` or
  // `turn.failed`; the stream is complete only when every turn closed and at
  // least one did so by completing. A terminal event with no open turn is
  // drift (a prefix-truncated or concatenated stream), not a count to clamp.
  let openTurns = 0;
  let sawTurnCompletion = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index] as Record<string, unknown>;
    switch (event.type) {
      case "thread.started":
        // Exactly one announcement names the thread this run runs on, the
        // grammar makes it the stream's FIRST event (exec emits it before
        // any turn), and it must name one: the thread id identifies the
        // conversation this stream records, so an announcement without it
        // names nothing. An announcement that follows any other event is
        // drift -- a wrapper concatenating two valid streams produces
        // exactly this shape -- and accepting a late one paired the
        // earlier stream's completed response with the second run's
        // thread. All refused.
        if (index > 0) return null;
        if (typeof event.thread_id !== "string" || event.thread_id === "") {
          return null;
        }
        sawThreadStarted = true;
        threadId = event.thread_id;
        break;
      case "turn.started":
        // Turns run one at a time -- the grammar nests items inside a turn
        // and closes it before the next opens -- so a `turn.started` while
        // another turn is still open is drift, the shape of a concatenated
        // or terminal-event-dropping wrapper. Counting it let the second
        // turn's events close as a turn of this stream. A completed turn
        // closes the stream too: one `codex exec` run is one turn, so a
        // `turn.started` after any `turn.completed` is a second
        // conversation glued on (round19) -- accepting it returned the
        // second run's result while the thread the one announcement named
        // stayed the first run's.
        if (openTurns > 0 || sawTurnCompletion) return null;
        openTurns++;
        // A new turn supersedes the previous one's message: only the last
        // turn's may be the result, so an earlier turn's reply must not
        // survive into a turn that ends without one and pose as its result.
        finalMessage = null;
        break;
      case "item.started":
      case "item.updated":
        // Items belong inside turns -- the event grammar nests them there
        // -- so an item event after the last `turn.completed`, with no
        // `turn.started` reopening a turn, is drift (a wrapper concatenating
        // or truncating streams produces exactly this shape). Round23: only
        // a trailing `item.completed` agent message was refused before, so
        // a trailing `item.started` or `item.updated` was silently accepted
        // and the completed turn's response returned successfully over a
        // stream whose tail belonged to no turn of this run.
        if (openTurns === 0 && sawTurnCompletion) return null;
        break;
      case "item.completed": {
        // The same ordering rule for the third item event, whatever the
        // item's type: an agent message (round6), a reasoning or tool item
        // (round23) -- any item completing after the last `turn.completed`
        // is drift. Letting a trailing message item replace the completed
        // turn's message would return an uncompleted message as a
        // successful result, and accepting a trailing non-message item
        // would pass a concatenated stream off as this run's.
        if (openTurns === 0 && sawTurnCompletion) return null;
        const item = event.item;
        if (
          typeof item === "object" && item !== null &&
          (item as Record<string, unknown>).type === "agent_message"
        ) {
          const text = (item as Record<string, unknown>).text;
          // A recognized agent_message whose text is not a string is drift,
          // not an item to skip over: silently ignoring it left the stream
          // without a message, so a nonempty --output-last-message fallback
          // could pass the malformed run off as a successful Plan-only turn
          // (round10). The stream is the documented source for agent
          // messages, and one it cannot carry fails closed like any other
          // drift.
          if (typeof text !== "string") return null;
          finalMessage = text;
        } else if (
          typeof item === "object" && item !== null &&
          (item as Record<string, unknown>).type === "error"
        ) {
          // A reroute notice is the one error item this reduction reads:
          // codex reports a rerouted model as a completed `error` item
          // (ModelRerouted in exec_events.rs), with the message formatted
          // `model rerouted: <from> -> <to> (<reason>)` -- the reason is
          // Debug-formatted upstream, so the parenthetical is matched as a
          // unit and a reason containing parentheses still parses. The last
          // reroute wins: a later one supersedes the model an earlier one
          // named. Any other error item is left alone -- the stream's
          // failure channels are `turn.failed` and the top-level `error`
          // event, not items, so nothing this reduction reports depends on
          // an unrecognized one (unlike an agent_message whose text is not
          // a string, which is drift because the stream is the documented
          // source for messages).
          const message = (item as Record<string, unknown>).message;
          if (typeof message === "string") {
            const reroute = /^model rerouted: (.+) -> (.+) \((.*)\)$/.exec(message);
            if (reroute !== null) servedModel = reroute[2]!;
          }
        }
        break;
      }
      case "turn.completed": {
        // Every terminal event must match an open turn: an unmatched one is
        // the shape of a prefix-truncated stream (only the tail of a longer
        // conversation), and clamping it to zero let that tail pose as a
        // complete result.
        if (openTurns === 0) return null;
        openTurns--;
        sawTurnCompletion = true;
        // A completed turn supersedes an earlier `error`: codex retried the
        // error and the turn recovered, so the run did not fail. A
        // `turn.failed` is never superseded -- upstream discards the final
        // message of a failed turn, and a later completed turn cannot
        // un-fail the run that reported it.
        errorFailure = null;
        const reported = event.usage;
        // A completed turn that reports no usage figure -- the field absent,
        // or an object carrying no counts -- leaves the run with no last
        // snapshot. The snapshot replaces rather than joins, so the previous
        // turn's cumulative total must not survive it: a stream whose last
        // turn omits usage reports null fields, not the earlier turn's
        // stale counts.
        if (typeof reported !== "object" || reported === null) {
          usage = emptyUsage();
          usageReported = false;
          break;
        }
        const u = reported as Record<string, unknown>;
        const input = reportedCount(u.input_tokens);
        const cached = reportedCount(u.cached_input_tokens);
        const cacheWrite = reportedCount(u.cache_write_input_tokens);
        const output = reportedCount(u.output_tokens);
        if (input === null && cached === null && cacheWrite === null && output === null) {
          usage = emptyUsage();
          usageReported = false;
          break;
        }
        // Every count zero is the same non-report in another shape: codex
        // 0.159.3 fills `turn.completed.usage` with `Usage::default()` when
        // the thread never received a token-usage update, and a turn that
        // completed has consumed tokens -- output above all -- so four
        // zeros are that synthetic snapshot, not a measured figure.
        // Publishing `total_tokens: 0` for a nonempty completed run would
        // report a number nothing reported (round23).
        if (input === 0 && cached === 0 && cacheWrite === 0 && output === 0) {
          usage = emptyUsage();
          usageReported = false;
          break;
        }
        // Each normalized field is computed exactly from the raw fields it
        // needs and is null when any of them is unreported, never guessed
        // from a zero: a reported zero is knowledge (a turn with no cache
        // traffic keeps cached_input_tokens 0), while a missing field stays
        // missing. The snapshot replaces, not joins, the previous one: each
        // is the same cumulative thread counter at a later point.
        usage = {
          // The uncached input: codex counts BOTH cache reads and cache
          // writes inside input_tokens (each is a breakdown of that total,
          // responses.rs), so both are subtracted. Subtracting only the
          // reads left every cache write counted twice -- once here and
          // once in the cached count below (round25).
          input_tokens:
            input !== null && cached !== null && cacheWrite !== null
              ? Math.max(0, input - cached - cacheWrite)
              : null,
          output_tokens: output,
          // Cache reads and writes join into the one cached count.
          cached_input_tokens:
            cached !== null && cacheWrite !== null ? cached + cacheWrite : null,
          // The total is computed, not reported: the sum of the three
          // normalized components above, and only when every component of
          // the documented sum is known -- which takes all four raw counts,
          // because the uncached input needs `cached` AND `cacheWrite` and
          // the joined cached count needs `cacheWrite` too (README: the
          // total is computed "only when every component was reported",
          // round17). The uncached term is the CLAMPED one: cached input
          // above total input once summed the raw `input`, so the reported
          // components disagreed with the total they were promised to sum
          // to (round19).
          total_tokens:
            input !== null && cached !== null && cacheWrite !== null && output !== null
              ? Math.max(0, input - cached - cacheWrite) + cached + cacheWrite + output
              : null,
          cost_usd: null,
        };
        usageReported = true;
        break;
      }
      case "turn.failed": {
        // Same matching rule as turn.completed, for the same reason. The
        // error sits one level down (TurnFailedEvent { error }); the
        // fallback literal is upstream's own.
        if (openTurns === 0) return null;
        openTurns--;
        const error = event.error;
        const message =
          typeof error === "object" && error !== null
            ? (error as Record<string, unknown>).message
            : undefined;
        turnFailure =
          typeof message === "string" && message !== ""
            ? message
            : "turn failed";
        break;
      }
      case "error": {
        const message = event.message;
        errorFailure =
          typeof message === "string" && message !== ""
            ? message
            : "codex reported an error";
        break;
      }
      default:
        break;
    }
  }

  // The grammar opens every stream with its one `thread.started`
  // announcement; a stream without one (an empty stream included) is not
  // the event stream this reduction is documented to read.
  if (!sawThreadStarted) return null;
  const failure = turnFailure ?? errorFailure;
  if (failure !== null) {
    finalMessage = null;
    // A failed run reports no usage totals either (round17): the last
    // snapshot is an earlier turn's (a failed turn closes with no usage
    // event), so the run's true total is that figure or more -- an
    // exact-looking number that understates a failed run is worse than
    // none.
    usage = emptyUsage();
    usageReported = false;
  }
  return {
    threadId,
    finalMessage,
    servedModel,
    usage,
    usageReported,
    turnCompleted: sawTurnCompletion && openTurns === 0,
    failure,
  };
}

/**
 * The stderr line that says where a fallback result came from. Codex ends
 * some successful turns with a `Plan` item and no `agent_message`; its own
 * final message is then the Plan text (`final_message_from_turn_items`
 * falls back to the last Plan), but the JSONL mapper drops the item, so the
 * event stream codemux reduces carries no message at all. The launch
 * therefore also passes `--output-last-message <file>` and the recorded
 * final message -- Plan included -- becomes the result; the note keeps the
 * caller from reading a plan as an assistant reply without knowing it.
 */
export const CODEX_FINAL_MESSAGE_FALLBACK_NOTE =
  "codemux: the codex stream carried no agent_message item, so the result " +
  "is the final message codex recorded itself (its last Plan item, which " +
  "the JSONL event stream does not carry)";

/**
 * Fills a stream whose last turn left no message in the event stream with
 * the final message codex recorded through `--output-last-message`. Only a
 * failed-turn-free stream with no in-stream message qualifies: a failed turn
 * has no final message upstream, and a stream that already has one stands
 * (the stream is the documented source; the file is the fallback for the
 * item the mapper drops). Returns whether the fallback supplied the result,
 * so both callers can say so on stderr.
 */
export function applyCodexFinalMessageFallback(
  stream: CodexEventStream,
  fallback: string | null
): boolean {
  if (fallback === null || stream.failure !== null || stream.finalMessage !== null) {
    return false;
  }
  stream.finalMessage = fallback;
  return true;
}

/**
 * The one success verdict every codex event-stream run shares. A run is
 * successful only when the stream carried a complete result: any
 * `turn.failed` or `error` event, a stream that ends without a final
 * assistant message (a turn that produced no message -- the Plan fallback,
 * when the caller applied one, counts as the message), a stream whose last
 * turn never ended with `turn.completed` (an `item` completing is not the
 * turn finishing, so a wrapper that drops the final event cannot make a
 * truncated stream pass), or codex's own non-zero exit is a failure. The
 * diagnostic is the stderr line for the failure; it is null when codex
 * itself already exited non-zero, because its own stderr is the
 * diagnostic.
 */
export function codexStreamVerdict(
  stream: CodexEventStream,
  result: RunResult
): { failed: boolean; diagnostic: string | null } {
  if (stream.failure !== null) {
    return {
      failed: true,
      diagnostic: `codemux: codex run failed: ${stream.failure}`,
    };
  }
  if (!result.success) {
    // Codex's own exit already failed and its stderr is on stderr; no
    // codemux line is added, but the verdict still fails the run.
    return { failed: true, diagnostic: null };
  }
  if (stream.finalMessage === null || stream.finalMessage.trim() === "") {
    // An empty or whitespace-only final message is no message (round10 for
    // "", round17 for whitespace-only): a completed codex turn whose one
    // agent_message carried empty text passed as a successful run with an
    // empty result. The rule is the same one the Claude envelope path
    // applies to its `result` text.
    return {
      failed: true,
      diagnostic:
        "codemux: the codex stream ended without a final assistant " +
        "message, so this run has no result to report",
    };
  }
  if (!stream.turnCompleted) {
    return {
      failed: true,
      diagnostic:
        "codemux: the codex stream ended without a `turn.completed` " +
        "event, so the turn never finished and this result is truncated",
    };
  }
  return { failed: false, diagnostic: null };
}

/**
 * Finishes a `--result-json` run for codex: codemux builds the envelope
 * itself, because the harness's own stdout is an event stream rather than
 * one object. `result` holds the final assistant message as plain text, and
 * is null unless the verdict above passed -- a failed or interrupted turn
 * has no final message, and partial output from an earlier
 * `item.completed` must not pose as one. A turn the stream records as
 * complete but messageless is different: when codex itself recorded a final
 * message (a Plan-only turn; see `CODEX_FINAL_MESSAGE_FALLBACK_NOTE`), that
 * message -- passed in as `finalMessageFallback` from the
 * `--output-last-message` file the launch named -- is the result, and a
 * turn with no message anywhere still fails. A failed turn surfaces on
 * every channel: the exit is non-zero even if codex's own was not, and the
 * diagnostic rides on stderr after codex's own output.
 *
 * Usage is this run's. `turn.completed.usage` is the thread's cumulative
 * total (see parseCodexEventStream); a run launched with `--ephemeral`
 * starts its thread, so the last snapshot is exactly this run's usage. An
 * unparseable stream is a broken contract, so that run fails loudly:
 * non-zero exit, the raw stdout kept verbatim on stdout for inspection
 * (the same way the Claude-family path keeps it -- no envelope is emitted,
 * because there is no stream to build one from), and the codemux line on
 * stderr.
 */
export function codexResult(
  result: RunResult,
  request: RunRequest,
  finalMessageFallback: string | null = null
): RunResult {
  const stream = parseCodexEventStream(result.stdout);
  if (stream === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        "codemux: codex printed an event stream this codemux " +
          "cannot parse, so this --result-json run reports no result or usage"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const usedFallback = applyCodexFinalMessageFallback(stream, finalMessageFallback);
  const verdict = codexStreamVerdict(stream, result);
  const block: CodemuxResultBlock = {
    agent: "codex",
    // The model is the one that served the run: a reroute (servedModel)
    // replaces the selection mid-run, and otherwise the stream names no
    // model, so it is the one codemux selected or null (the harness
    // default, unreported).
    model: stream.servedModel ?? request.model ?? null,
    // A failed run's envelope reports null usage even when the stream
    // parsed and carried a snapshot (round23): a complete stream paired
    // with codex's own non-zero exit still fails -- the verdict reads the
    // exit, not just the stream -- and a figure from a run whose end the
    // harness itself called failed is at best incomplete. The parser
    // already nulls usage for a stream-level failure; this extends the
    // rule to every failed envelope.
    usage: verdict.failed ? emptyUsage() : stream.usage,
    // Always null in this release: the adapter runs `--ephemeral`, so no
    // thread a run leaves behind can be resumed (reserved for the
    // live-sessions release; see types.ts).
    session_id: null,
  };
  const notes: string[] = [];
  if (verdict.diagnostic !== null) {
    notes.push(verdict.diagnostic);
  }
  if (!verdict.failed && usedFallback) {
    notes.push(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  }
  if (stream.servedModel !== null) {
    // Attribution the caller should not have to dig for: the envelope's
    // model field carries the served model, and the note says it on stderr
    // for the operator who selected a different one.
    notes.push(
      `codemux: codex rerouted the model, so this run was served by ${stream.servedModel}` +
        (request.model !== undefined && request.model !== stream.servedModel
          ? `, not the requested ${request.model}`
          : "")
    );
  }
  return {
    ...result,
    stdout: `${JSON.stringify({ result: verdict.failed ? null : stream.finalMessage, codemux: block })}\n`,
    stderr:
      notes.length > 0
        ? appendDiagnostic(result.stderr, notes.join("\n"))
        : result.stderr,
    exitCode: verdict.failed && result.exitCode === 0 ? 1 : result.exitCode,
    success: !verdict.failed,
  };
}
