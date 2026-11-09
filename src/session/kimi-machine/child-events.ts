/**
 * The kimi machine's child event application: one parsed output line
 * of the open turn's child, and the child's exit verdict. The
 * transition (kimi-machine/step.ts) calls these; src/session/
 * kimi-machine.ts owns the public surface.
 */

import { emptyUsage } from "../../result-envelope.js";
import { parseKimiStreamLine } from "../kimi-session.js";
import { harnessFailed, type SessionChildOutcome } from "../process.js";
import type { ResultUsageBlock } from "../../types.js";
import { addUsage } from "../usage.js";
import { fatalEnd } from "./end-paths.js";
import type {
  KimiEffect,
  KimiMachineConfig,
  KimiMachineState,
  TurnChild,
} from "./types.js";

/** One output line from the open turn's child. Parsed only while a live
 * turn runs or a graceful, uncut, un-fataled drain still owes the turn
 * its run; once a killing end, a cut, or any fatal owns, later bytes
 * are accepted nowhere (a stream the session already reported as
 * fatally broken cannot emit post-fatal events or re-confirm the store
 * through a late hint). */
export function childLine(
  state: KimiMachineState,
  line: string,
  config: KimiMachineConfig
): KimiEffect[] {
  const parseOpen =
    state.phase === "running" ||
    state.phase === "idle" ||
    state.phase === "spawning" ||
    (state.phase === "draining" && state.graceOpen);
  if (!parseOpen || state.fatalClosed || state.turn?.interruption !== undefined) return [];
  const unknown = (raw: string): KimiEffect => ({ kind: "emit", event: "unknown_event", raw });
  // The hint is the turn's closing record — the writer runs the turn
  // body, writes the hint, then exits — so any line after it is drift:
  // output past the closing record is a malformed or concatenated
  // stream, never a longer turn. The raw line goes out, the
  // confirmation the hint earned is withdrawn, and the crash is not
  // resumable.
  if (state.turn !== null && state.turn.sawHint) {
    return [
      unknown(line),
      ...fatalEnd(
        state,
        "harness",
        "harness output followed the turn's closing resume hint, so the stream is malformed and the turn fails",
        "crash",
        1
      ),
    ];
  }
  const parse = parseKimiStreamLine(line, { knownSessionId: state.sessionId });
  switch (parse.kind) {
    case "unusable":
      return fatalEnd(
        state,
        "harness",
        `unusable harness output (not JSON, ${parse.bytes} bytes): ${parse.excerpt}`,
        "crash",
        1
      );
    case "grammar_error":
      // The raw line still goes out, then the fatal end. A hint that
      // named a foreign session withdraws the confirmation an earlier
      // matching hint earned: a store that answered with another
      // session's id is not one a --resume can be sent into on the
      // record's word.
      if (parse.wrongSession !== undefined) state.confirmed = false;
      return [
        unknown(line),
        ...fatalEnd(state, "harness", parse.message, "crash", 1),
      ];
    case "unknown":
      // Tier 1: raw preserved, session continuing.
      return [unknown(line)];
    case "error": {
      if (state.turn === null) {
        return [
          unknown(line),
          ...fatalEnd(state, "harness", "an output line arrived with no open turn", "crash", 1),
        ];
      }
      // Non-fatal: the session continues (the next turn runs), but the
      // error still fails the turn whatever the exit code, the reply, or
      // the resume hint turn out to be — the plain-run rule
      // (result-envelope/kimi.ts fails a run on an error event) and the
      // opencode driver's since review round 123. The first error
      // frame's message is the reason that verdict carries; the frame
      // itself is the error event, so the raw line needs no separate
      // passthrough (the mapped kinds carry their payload in the event).
      state.turn.errorMessage ??= parse.message;
      return [
        { kind: "error", fatal: false, source: "harness", message: parse.message },
      ];
    }
    case "resume_hint": {
      // The one line that names the session. The closing-record pin is
      // set FIRST, before adoption, so a foreign id's fatal and any line
      // after the hint both meet it. The pin rides the open turn; a hint
      // with no open turn (unreachable through the spawn discipline —
      // the turn closes at the child's exit, after the stream ends)
      // adopts without it.
      if (state.turn !== null) state.turn.sawHint = true;
      // A hint naming a foreign session never reaches this case: the
      // parser (kimi-session.ts) converts a mismatched id into a
      // grammar_error with wrongSession before the machine sees the
      // line, so what lands here matches the known id — or names a
      // first one (round al32, contracts-2 minor 2: the duplicate
      // foreign-id arm that sat here was unreachable).
      state.confirmed = true;
      if (state.sessionId === null) {
        // A fresh session learns its identity here: the announcement and
        // the registry record wait for this line (the agy pattern).
        state.sessionId = parse.sessionId;
        const effects: KimiEffect[] = [];
        if (config.registryEnabled) {
          state.recordPending = true;
          state.pendingHint = line;
          effects.push({ kind: "record_start" });
        } else {
          state.announced = true;
          effects.push({ kind: "announce" }, unknown(line));
        }
        return effects;
      }
      return [unknown(line)];
    }
    case "assistant": {
      if (state.turn === null) {
        return [
          unknown(line),
          ...fatalEnd(state, "harness", "an output line arrived with no open turn", "crash", 1),
        ];
      }
      const effects: KimiEffect[] = [];
      if (parse.text !== null) {
        // Text is the reply; tool calls alone never are (round al33,
        // edges major 2 — see the sawAssistant field's note).
        state.turn.sawAssistant = true;
        effects.push({
          kind: "emit",
          event: "assistant_message",
          raw: line,
          text: parse.text,
          turnId: state.turn.id,
        });
      }
      if (parse.toolCalls.length > 0) {
        // The loop is open: calls without their results, and no final
        // text stands behind them (round al33, edges major 2).
        state.turn.sawFinalAssistantText = false;
        for (const call of parse.toolCalls) {
          // A repeated id is a malformed tool loop, not a second call
          // to stack (round al35, correctness major 3): the loop keys
          // calls by id, so one id can name exactly one call per turn — a
          // harness repeating it cannot say which result answers which
          // call, and the session fails on the grammar error rather
          // than track a loop it cannot read. The check runs before
          // the set, so a duplicate inside one frame is caught the
          // same as one from a later frame.
          if (state.turn.seenToolCallIds.has(call.callId)) {
            return [
              unknown(line),
              ...fatalEnd(
                state,
                "harness",
                `an assistant frame repeated the tool call id ${call.callId} ` +
                  "the loop already opened",
                "crash",
                1
              ),
            ];
          }
          state.turn.seenToolCallIds.add(call.callId);
          state.turn.pendingToolCalls.set(call.callId, call.name);
          effects.push({
            kind: "emit",
            event: "tool_call",
            raw: line,
            callId: call.callId,
            name: call.name,
            input: call.input,
          });
        }
      } else if (parse.text !== null && state.turn.pendingToolCalls.size === 0) {
        // The reply stands only behind the loop: a text frame while a
        // call is still unanswered is mid-loop prose, not the final
        // answer (round al34, edges major 1), so it must not confirm
        // the turn.
        state.turn.sawFinalAssistantText = true;
      }
      return effects;
    }
    case "tool_result": {
      if (state.turn === null) {
        return [
          unknown(line),
          ...fatalEnd(state, "harness", "an output line arrived with no open turn", "crash", 1),
        ];
      }
      // The result must answer a call the loop opened and no earlier
      // result answered (round al35, correctness major 3): a result for
      // an unknown id, or a second result for one already answered, is
      // a malformed tool loop — the session fails on the grammar error
      // rather than let the loop's bookkeeping drift into a silent set
      // difference. The wire carries no error marker for a tool result,
      // so none is invented (is_error false is the wire's own reading).
      if (!state.turn.pendingToolCalls.has(parse.callId)) {
        return [
          unknown(line),
          ...fatalEnd(
            state,
            "harness",
            `a tool result arrived for the call id ${parse.callId} the loop ` +
              "never opened, or one it already answered",
            "crash",
            1
          ),
        ];
      }
      // The call this result answers is no longer pending — the loop
      // closes one call at a time (round al33, edges major 2).
      state.turn.pendingToolCalls.delete(parse.callId);
      return [
        { kind: "emit", event: "tool_result", raw: line, callId: parse.callId, output: parse.output },
      ];
    }
  }
}

/** Preserve the child outcome and report every nonzero or signal exit as failure. */
export function childExit(
  state: KimiMachineState,
  child: TurnChild,
  outcome: SessionChildOutcome,
  usage: ResultUsageBlock
): KimiEffect[] {
  if (state.child !== child) return []; // superseded — defensive
  state.harnessExit = outcome;
  state.sawHarnessFailure ||= state.turn?.interruption === undefined && harnessFailed(outcome);
  if (state.fatalClosed) {
    // A fatal-owned session leaves the turn open
    // for the synthesis at children_settled.
    return [];
  }
  if (state.turn === null) return []; // defensive: nothing to complete
  const endOwns = state.end.cause !== null;
  if (state.turn.interruption !== undefined && !endOwns) {
    const turn = state.turn;
    state.turn = null;
    state.child = null;
    state.phase = "idle";
    state.confirmed = state.sessionId !== null;
    state.cumulative = addUsage(state.cumulative, usage);
    const interrupted: KimiEffect[] = [
      { kind: "emit", event: "turn_completed", turnId: turn.id, finish: "interrupted", reason: turn.interruption, usage },
      { kind: "ledger_turn", turnId: turn.id, startedAt: turn.startedAt, finish: "interrupted", usage },
      { kind: "stamp_activity" },
    ];
    if (state.sessionId === null) interrupted.push(...fatalEnd(state, "codemux",
      "the first Kimi turn was interrupted before its session identity was established; the session cannot safely resume", "crash", 1));
    return interrupted;
  }
  const exitDetail =
    outcome.code !== null
      ? `code ${outcome.code}`
      : `signal ${outcome.signal ?? "unknown"}`;
  const effects: KimiEffect[] = [];
  if (endOwns && state.sessionId !== null && harnessFailed(outcome)) {
    effects.push(...fatalEnd(
      state, "harness", `the kimi process exited with ${exitDetail}`, "harness_failed", 1
    ));
  }
  const turn = state.turn;
  state.turn = null;
  state.child = null;
  if (!endOwns) state.phase = "idle";
  if (state.sessionId === null) {
    // A fresh session still unnamed after its first turn is untrackable
    // (§4.8): the turn's events went out as they arrived, so the
    // pairing completes, then the untracked-session fatal ends the
    // session.
    effects.push(
      {
        kind: "emit",
        event: "turn_completed",
        turnId: turn.id,
        finish: "failed",
        reason: `the kimi process exited with ${exitDetail} and named no session id`,
        // No named session means no wire log: nothing was attributed.
        usage: emptyUsage(),
      },
      { kind: "ledger_turn", turnId: turn.id, startedAt: turn.startedAt, finish: "failed", usage: emptyUsage() },
      ...fatalEnd(
        state,
        "harness",
        "the first turn's resume hint named no session id, " +
          "so the session cannot be recorded in the registry",
        "crash",
        1
      )
    );
    return effects;
  }
  // The writer pins the closing hint to every completed turn, so a turn
  // of an identified session that ends with no hint of its own is not
  // successful whatever its exit and output say; and a turn has not
  // answered unless every tool call resolved exactly once and a final
  // assistant text arrived after them — a resolved loop with no reply
  // behind it and a reply that lands while a call is still pending are
  // both failed turns, whatever the hint and exit 0 say (round al33,
  // edges major 2; the both-shapes rule is round al34, edges major 1;
  // "resolved exactly once" is the map-keyed grammar of round al35,
  // correctness major 3, which fails the session on the malformed loops
  // before this verdict ever reads them). An error frame the turn's
  // stream carried fails it the same way, whatever the exit, the reply,
  // or the hint say (review round 127, mirroring the opencode rule of
  // round 123), and its first message is the reason.
  const unresolvedCalls = turn.pendingToolCalls.size;
  const failed =
    harnessFailed(outcome) ||
    turn.errorMessage !== null ||
    !turn.sawAssistant ||
    !turn.sawFinalAssistantText ||
    !state.confirmed;
  if (!state.confirmed) {
    state.sawUnconfirmedTurnFailure = true;
  }
  state.cumulative = addUsage(state.cumulative, usage);
  effects.push(
    {
      kind: "emit",
      event: "turn_completed",
      turnId: turn.id,
      finish: failed ? "failed" : "end",
      ...(failed
        ? {
            reason:
              turn.errorMessage !== null
                ? turn.errorMessage
                : outcome.code !== 0
                  ? `the kimi process exited with ${exitDetail}`
                  : unresolvedCalls > 0
                    ? `the kimi process exited 0 with ${unresolvedCalls} tool call${
                        unresolvedCalls === 1 ? "" : "s"
                      } that never received a result and no final assistant reply`
                    : !turn.sawAssistant
                      ? "the kimi process exited 0 and printed no assistant output"
                      : !turn.sawFinalAssistantText
                        ? "the kimi process exited 0 with no final assistant reply " +
                          "after its tool results"
                        : "the kimi process exited 0 without the resume hint that " +
                          "closes every completed turn, so the session is unconfirmed",
          }
        : {}),
      // The failed verdict changes nothing about the counts: the turn's
      // model calls happened, so its wire-log delta reports either way.
      usage,
    },
    { kind: "ledger_turn", turnId: turn.id, startedAt: turn.startedAt, finish: failed ? "failed" : "end", usage },
    { kind: "stamp_activity" }
  );
  return effects;
}
