/**
 * The kimi machine's transition: the one step function that answers
 * every event with its effects. src/session/kimi-machine.ts owns the
 * public surface; the table and its invariants are documented once,
 * in turn-per-process.ts.
 */

import { MAX_ARGV_PROMPT_BYTES } from "../../process-runner.js";
import { strictLaunchFailureExitCode } from "../../sandbox-command.js";
import { emptyUsage } from "../../result-envelope.js";
import { kimiPromptIsCommand } from "../kimi-session.js";
import { applyAuthorPrefix, parseInputLine } from "../protocol.js";
import {
  callerStdinFailure,
  crashSynthesisReason,
  SESSION_SIGNAL_EXIT_CODE,
} from "../process.js";
import { busyRecordExhaustedNotice, PENDING_RECORD_FATAL } from "../registry.js";
import {
  CAPABILITIES,
  type KimiEffect,
  type KimiEvent,
  type KimiMachineConfig,
  type KimiMachineState,
} from "./types.js";
import { childExit, childLine } from "./child-events.js";
import { fatalEnd, interruption, startEndPath } from "./end-paths.js";

const EMPTY_PENDING: ReadonlySet<string> = new Set();

/** UTF-8 size in bytes — the unit the argv bound is stated in. */
const byteLength = (text: string): number => Buffer.byteLength(text);

/** The one spelling of a turn-spawn failure: the accepted turn never
 * ran, so the failure is codemux's own and must surface as a fatal,
 * never a silently interrupted turn. */
export function turnSpawnFailureMessage(error: unknown): string {
  return `could not spawn the kimi turn process (${
    error instanceof Error ? error.message : String(error)
  })`;
}

/**
 * The transition. Mutates `state` (the caller owns it; the function
 * performs no I/O and reads nothing but its arguments and the clock —
 * `Date.now()` for the turn's startedAt stamp, the one value the ledger
 * record needs that no event carries) and returns the effects to
 * perform, in order. An effect may raise a nested delivery (the
 * outbound queue's overflow ends the session inside an emit); the
 * executor parks it behind the current effect list (the al29
 * effect-completion rule), so this function never re-enters itself.
 */
export function step(
  state: KimiMachineState,
  event: KimiEvent,
  config: KimiMachineConfig
): KimiEffect[] {
  // Invariant 2: ended absorbs. Every event is ignored and counted; the
  // hold an earlier transition issued still completes on its own.
  if (state.phase === "ended") {
    state.end.countIgnored();
    return [];
  }
  switch (event.kind) {
    case "run_started": {
      const effects: KimiEffect[] = [{ kind: "arm_session_timer" }];
      if (state.sessionId !== null && !state.announced) {
        // A resumed session knows its identity at spawn: the id is
        // registry-vouched caller input, and the first turn's resume
        // hint only has to agree with it.
        if (config.registryEnabled && !state.registryRecorded) {
          state.recordPending = true;
          effects.push({ kind: "record_start" });
        } else {
          state.announced = true;
          effects.push({ kind: "announce" });
        }
      }
      return effects;
    }
    case "user_input": {
      // Every line consumes an input_seq, accepted or rejected.
      state.inputSeq += 1;
      const inputSeq = state.inputSeq;
      if (state.end.cause !== null) {
        // The input contract: during the end path every line answers
        // `shutting_down`; past session_ended nothing may follow.
        return [{ kind: "ack", inputSeq, accepted: false, reason: "shutting_down" }];
      }
      const parsed = parseInputLine(event.line, {
        capabilities: CAPABILITIES,
        hasActiveTurn: state.turn !== null,
        pendingRequestIds: EMPTY_PENDING,
        shuttingDown: false,
      });
      if (!parsed.ok) {
        return [{ kind: "ack", inputSeq, accepted: false, reason: parsed.reason }];
      }
      const message = parsed.message;
      switch (message.type) {
        case "user": {
          const harnessText = applyAuthorPrefix(
            message.text,
            message.author,
            config.authorPrefix
          );
          // The prompt rides argv (`--prompt`), so the run path's 32 KiB
          // argv bound is the per-turn cap, checked before the ack — an
          // accepted line that cannot reach the harness would hang its
          // turn open.
          if (byteLength(harnessText) > MAX_ARGV_PROMPT_BYTES) {
            return [{ kind: "ack", inputSeq, accepted: false, reason: "text_too_long" }];
          }
          // The command shapes kimi's headless path actually dispatches
          // (kimiPromptIsCommand states the rule): the word-bounded
          // /goal name and the `!` shell escape — unlike aider's broader
          // refusal of any / or ! leading text, kimi dispatches these two
          // alone, so the refusal covers exactly them. Judged on
          // harnessText: the text about to ride argv is what kimi
          // dispatches, and an author prefix ahead of it neutralizes the
          // shape.
          if (kimiPromptIsCommand(harnessText)) {
            return [{ kind: "ack", inputSeq, accepted: false, reason: "unsupported" }];
          }
          // A whitespace-only prompt is kimi's own refusal before
          // anything runs — no resume hint can ever close the turn, so
          // the turn is never launched.
          if (harnessText.trim() === "") {
            return [{ kind: "ack", inputSeq, accepted: false, reason: "unsupported" }];
          }
          const turnId = `t${++state.turnCounter}`;
          state.turn = {
            id: turnId,
            startedAt: Date.now(),
            sawAssistant: false,
            pendingToolCalls: new Map(),
            seenToolCallIds: new Set(),
            sawFinalAssistantText: false,
            errorMessage: null,
            sawHint: false,
          };
          state.phase = "spawning";
          state.spawnInFlight = true;
          state.spawnAbandoned = false;
          // Per-turn confirmation: this turn's own hint must name the
          // session again, so a turn that fails with no hint is the
          // store's refusal whatever an earlier turn proved.
          state.confirmed = false;
          // turn_started before the echo and the spawn (the
          // claude/codex/agy order): a spawn failure's fatal must follow
          // the turn it failed.
          return [
            { kind: "ack", inputSeq, accepted: true },
            { kind: "emit", event: "turn_started", turnId },
            {
              kind: "emit",
              event: "user_message",
              inputSeq,
              text: message.text,
              author: message.author,
              turnId,
            },
            { kind: "spawn", prompt: harnessText },
          ];
        }
        case "shutdown": {
          state.end.record({ reason: "shutdown", code: 0 });
          return [{ kind: "ack", inputSeq, accepted: true }, ...startEndPath(state)];
        }
        case "interrupt": {
          if (state.turn !== null) state.turn.interruption ??= message.reason ?? "caller interrupted the turn";
          return [{ kind: "ack", inputSeq, accepted: true }, { kind: "stop_turn" }];
        }
        default:
          // kimi's capability matrix rejects every other type inside
          // parseInputLine; this arm is the checked backup.
          return [{ kind: "ack", inputSeq, accepted: false, reason: "unsupported" }];
      }
    }
    case "spawn_settled": {
      if (!state.spawnInFlight || state.spawnAbandoned || state.child !== null) {
        return []; // stale or defensive: the hold owns abandoned spawns
      }
      if (state.phase === "ending") {
        // The end path passed its waits before this spawn landed
        // (unreachable — the grace arm awaits the spawn, the killing arm
        // abandons it, and `ended` absorbs above — but a child no state
        // can adopt is stopped, never leaked). Marked abandoned so the
        // registry release waits behind the stop's settling, and the
        // hold is DECLARED like every other abandonment (round al35,
        // contracts-2 minor): the effect union's own contract says an
        // abandoned spawn comes with hold_release, and an effect
        // consumer tracking holds from the stream would have missed
        // this one — the only arm that abandons without declaring it.
        state.spawnInFlight = false;
        state.spawnAbandoned = true;
        return [
          { kind: "stop_child", child: event.child },
          { kind: "hold_release" },
        ];
      }
      state.spawnInFlight = false;
      state.child = event.child;
      // A graceful end that awaited this spawn adopts the child and runs
      // the turn it owes (the drain continues in `draining`); a live
      // session attaches it as the running turn's child.
      if (state.end.cause === null) state.phase = "running";
      return [{ kind: "attach_child", child: event.child },
        ...(state.turn?.interruption === undefined ? [] : [{ kind: "stop_turn" } as KimiEffect])];
    }
    case "spawn_failed": {
      if (!state.spawnInFlight || state.spawnAbandoned) {
        return []; // the hold owns abandoned spawns; defensive
      }
      state.spawnInFlight = false;
      const message = turnSpawnFailureMessage(event.error);
      const code = strictLaunchFailureExitCode(event.error);
      if (state.end.cause === null) {
        // The accepted turn never ran: codemux's own failure, a crash
        // end — never a silently interrupted turn.
        return fatalEnd(state, "codemux", message, "crash", code);
      }
      // The graceful end awaited this spawn and it rejected: a later
      // cause. The race the end path runs resolves with it; the turn's
      // synthesis reads failed.
      state.end.record({ reason: "crash", code });
      state.graceOpen = false;
      state.fatalClosed = true;
      state.fatalMessage ??= message;
      state.confirmed = false;
      return [
        { kind: "error", fatal: true, source: "codemux", message },
        { kind: "cut_waits" },
      ];
    }
    case "child_line":
      return childLine(state, event.line, config);
    case "session_identified":
      if (state.sessionId !== null) return [];
      state.sessionId = event.sessionId;
      if (config.registryEnabled) { state.recordPending = true; return [{ kind: "record_start" }]; }
      state.announced = true;
      return [{ kind: "announce" }];
    case "turn_timeout":
      if (state.turn === null || state.end.cause !== null) return [];
      state.turn.interruption ??= "the turn exceeded its timeout";
      return [{ kind: "stop_turn" }];
    case "child_exit":
      return childExit(state, event.child, event.outcome, event.usage);
    case "stdin_eof": {
      if (state.end.cause === null) {
        if (event.error !== undefined) {
          // A read error is a failed input channel, not a drained one:
          // fatal, and the end carries code 1.
          return fatalEnd(state, "codemux", callerStdinFailure(event.error), "stdin-close", 1);
        }
        state.end.record({ reason: "stdin-close", code: 0 });
        return startEndPath(state);
      }
      // An end owns. A clean close is the end already running; a read
      // error during the drain is a later cause that closes it like
      // every fatal (the drain's remaining output is accepted nowhere).
      if (event.error !== undefined) {
        return fatalEnd(state, "codemux", callerStdinFailure(event.error), "crash", 1);
      }
      return [];
    }
    case "signal":
      return interruption(state, {
        reason: "signal",
        code: SESSION_SIGNAL_EXIT_CODE,
        message: "a signal interrupted the session during its shutdown; the shutdown waits were cut and the open turn, if any, was stopped",
      });
    case "session_timeout":
      return interruption(state, {
        reason: "timeout",
        code: 1,
        message: "the session exceeded its timeout during the shutdown; the shutdown waits were cut and the open turn, if any, was stopped",
      });
    case "fatal":
      return fatalEnd(state, event.source, event.message, "crash", 1);
    case "registry_error":
      return fatalEnd(
        state,
        "codemux",
        `cannot record the session in the registry: ${event.message}`,
        "crash",
        1
      );
    case "record_outcome": {
      state.recordPending = false;
      // A resumed session whose run-start record exhausted the busy
      // budget is tracked already — the CLI's claim wrote the record
      // before anything spawned — so the exhaustion is a lost refresh of
      // a record that exists, not an untracked session: announce (the
      // announce was waiting on the record verdict), say so on stderr,
      // and keep running (round 361, item 16; the summary-time half of
      // this exemption is round 356's, in children_settled). A fresh
      // session owes the same exhaustion a crash, and every other
      // failure class fails closed for either kind of session.
      const claimedBusy = !event.ok && event.failure === "busy" && state.resumeClaimed;
      if (event.ok || claimedBusy) {
        state.registryRecorded = event.ok;
        if (!state.announced) {
          state.announced = true;
          const hint = state.pendingHint;
          state.pendingHint = null;
          return [
            { kind: "announce" },
            ...(hint === null ? [] : [{ kind: "emit", event: "unknown_event", raw: hint } as KimiEffect]),
            ...(claimedBusy
              ? [{
                  kind: "notice",
                  message: busyRecordExhaustedNotice(
                    state.sessionId ?? "unknown",
                    event.error ?? "unknown error"
                  ),
                } as KimiEffect]
              : []),
          ];
        }
        state.pendingHint = null;
        return claimedBusy
          ? [{
              kind: "notice",
              message: busyRecordExhaustedNotice(
                state.sessionId ?? "unknown",
                event.error ?? "unknown error"
              ),
            }]
          : [];
      }
      state.pendingHint = null;
      // An untracked live session must not run.
      return fatalEnd(
        state,
        "codemux",
        `cannot record the session in the registry: ${event.error ?? "unknown error"}`,
        "crash",
        1
      );
    }
    case "children_settled": {
      if (state.end.cause === null) return []; // spurious: no end owns
      const effects: KimiEffect[] = [];
      // A start record still pending at the summary never lands: the
      // off-stream retries stop the moment this transition ends the
      // session (the driver's settled predicate reads the phase), so the
      // session ran untracked — never announced, no record a --resume
      // could find. Fail closed with the record failure's own verdict
      // (review round 345): the fatal, a crash end, exit 1. The reason
      // is the crash head-on, not the first cause's with a raised code —
      // the one summary-time override besides sawHarnessFailure, because
      // the untracked session is the outcome the caller must see. A
      // resumed session is tracked already -- the CLI's claim wrote its
      // record before the spawn -- so its pending run-start record is
      // not this verdict (review round 356).
      const untracked = state.recordPending && !state.resumeClaimed;
      if (untracked) {
        state.recordPending = false;
        state.end.record({ reason: "crash", code: 1 });
        state.fatalClosed = true;
        state.fatalMessage ??= PENDING_RECORD_FATAL;
        state.confirmed = false;
        effects.push({
          kind: "error",
          fatal: true,
          source: "codemux",
          message: PENDING_RECORD_FATAL,
        });
      }
      const cause = state.end.cause;
      const failedChild = state.sawHarnessFailure;
      const endReason = untracked ? "crash" : failedChild ? "harness_failed" : cause.reason;
      const endCode = Math.max(state.end.exitCode, failedChild ? 1 : 0);
      if (state.turn !== null) {
        // The turn_started the caller saw must be answered (the
        // synthesized completion): failed when any fatal owns the story
        // or the turn's own stream carried an error frame (the childExit
        // rule, review round 123), interrupted otherwise. An open turn
        // cut by the end never closed, so its closing hint never came —
        // the same unconfirmed-turn evidence a completed turn records,
        // whatever the synthesized verdict reads.
        if (!state.confirmed) state.sawUnconfirmedTurnFailure = true;
        const finish: "failed" | "interrupted" =
          state.fatalClosed || state.turn.errorMessage !== null ? "failed" : "interrupted";
        const reason =
          state.turn.errorMessage !== null
            ? state.turn.errorMessage
            : state.fatalMessage !== null
              ? crashSynthesisReason(state.fatalMessage)
              : `the session ended (${cause.reason}) before the turn completed`;
        effects.push(
          {
            kind: "emit",
            event: "turn_completed",
            turnId: state.turn.id,
            finish,
            reason,
            // The synthesized completion happens at children_settled,
            // after the child_exit that carried the read; the open turn's
            // delta already folded there when its verdict did, and this
            // path's turn never closed — no counts are attributed.
            usage: emptyUsage(),
          },
          {
            kind: "ledger_turn",
            turnId: state.turn.id,
            startedAt: state.turn.startedAt,
            finish,
            usage: emptyUsage(),
          }
        );
        state.turn = null;
      }
      // Resumable means the LAST turn's hint named this session, or, for
      // a recorded or claimed session kimi never confirmed, that the end
      // path did not fail AND no turn failed unconfirmed: the registry
      // must hold a record a `--resume` can find, and a hint that never
      // came leaves the store's state unproven. The end's failure test is
      // the raised code (exitCode), not the first cause's — a session
      // whose shutdown met a failure must not advertise another resume.
      const ownsRecord = state.registryRecorded || state.resumeClaimed;
      const resumable =
        CAPABILITIES.resume &&
        ownsRecord &&
        (state.confirmed || (state.end.exitCode === 0 && !state.sawUnconfirmedTurnFailure));
      effects.push(
        { kind: "disarm_session_timer" },
        ...(ownsRecord && !state.spawnAbandoned ? [{ kind: "release_registry" } as KimiEffect] : []),
        {
          kind: "emit",
          event: "session_ended",
          reason: endReason,
          // The session summary includes every observed child failure.
          exitCode: endCode,
          harnessExit: state.harnessExit,
          usage: state.cumulative,
          resumable,
        },
        {
          kind: "ledger_session",
          reason: endReason,
          exitCode: endCode,
          usage: state.cumulative,
        },
        // No dispose_signals here (round al30, edges major 3): the
        // handlers stay installed until the driver's finishDone has
        // settled the hold (an abandoned spawn's late child), and a
        // second SIGINT/SIGTERM in that window escalates — the group
        // dies at once — instead of falling back to the default
        // disposition, which would kill codemux mid-hold.
        // The code the process exits with is the end path's summary: the
        // first cause's floor raised by every cause recorded since.
        { kind: "resolve_done", code: endCode }
      );
      state.phase = "ended";
      return effects;
    }
  }
}
