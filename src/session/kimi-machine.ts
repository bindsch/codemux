/**
 * The kimi session's state machine (round al28's redesign): ONE pure
 * transition function that owns every decision — which cause ends the
 * session, whether an in-flight spawn is awaited or abandoned, whether a
 * late-landing child runs or is stopped, a turn's verdict, the exit code
 * — and issues every effect (spawn, stop, emit, registry write, timer
 * arm/disarm) for the executor (kimi-driver.ts) to perform. The driver
 * translates process callbacks into events and renders effects; it
 * decides nothing. Rounds al1–al27 instead spread these decisions across
 * per-interleaving flags in the driver (endEscalated, cutSpawnWait,
 * lateSpawnSettled, endExitCode's monotone max), and every flag created a
 * wrong state for the next interleaving — the seventeen rounds of majors
 * this table replaces.
 *
 * THE TABLE (states and invariants are stated once, in
 * turn-per-process.ts; this is kimi's column):
 *
 *   idle      --user_input-->            spawning
 *   spawning  --spawn_settled-->         running
 *   spawning  --spawn_failed-->          ending (a crash end: the
 *                                         accepted turn never ran)
 *   running   --child_exit-->            idle (the turn's verdict) or
 *                                         draining (an end owns)
 *   any live  --stdin_eof|shutdown|signal|session_timeout|fatal|
 *              registry_error-->        draining (a child or an awaited
 *                                         spawn still owes a wait) or
 *                                         ending (nothing to wait on)
 *   draining  --spawn_settled-->         draining (the grace arm adopts
 *                                         the late child and runs it)
 *   draining  --any later cause-->       draining, cut: waits are cut,
 *                                         an awaited spawn is abandoned,
 *                                         a landed child is stopped
 *   draining|ending --children_settled-> ended (the executor delivers
 *                                         this once every child of the
 *                                         end path has settled)
 *   ended     --anything-->              ended: the event is ignored and
 *                                         counted (EndCauseLog.countIgnored)
 *
 * THE CAUSE RULE (invariant 3): the FIRST end event fixes the session's
 * REASON forever; every failure the end path then meets raises the
 * process exit CODE to the max of the codes the recorded causes carry
 * (EndCauseLog.exitCode). Later would-be causes are diagnostics —
 * emitted as error events (fatal for the failure classes: a death the
 * stop did not cause, a drain failure code, a spawn failure, a parse or
 * protocol fatal, a registry error; non-fatal for a signal or timeout
 * landing during the end), allowed to cut the end path's waits and stop
 * children — and they never rewrite the reason. The code is different,
 * deliberately: it summarizes the END PATH, not the first event of it,
 * so a later cause raises it (al11's spawn failure inside the drain,
 * al18's signal, al25/al27's timeout, al26's external death — each
 * pinned by its round) while a turn that failed on its own before any
 * end exists costs nothing (that failure is the turn's verdict, already
 * reported on the turn).
 *
 * THE SPAWN RULE: a killing end (signal, timeout, crash) that meets an
 * in-flight spawn ABANDONS it — the spawn closure runs compatibility and
 * keep-env probes with timeouts of their own, and the session's absolute
 * deadline must not stretch to wait for them; the abandoned spawn's late
 * landing is stopped and settled by the hold (turn-per-process.ts's
 * divergence note), not by an event. A GRACEFUL end (stdin-close,
 * shutdown) awaits the spawn and adopts its child: the prompt already
 * rides the child's argv, so the end runs the turn it owes.
 *
 * THE CONFIRMATION RULE: `confirmed` is per turn — reset when the turn
 * opens, set only by this turn's own `session.resume_hint` (the final
 * line of every completed turn, kimi-session.ts's wire pin), cleared by
 * any fatal. A turn that ends unconfirmed is a failed turn and sets
 * sawUnconfirmedTurnFailure, so the end's resumable verdict cannot ride
 * an earlier turn's hint. There is no turn_timeout row: the CLI refuses
 * `--turn-timeout` for kimi (no verified interrupt channel), so the
 * event cannot occur.
 */

import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import { emptyUsage } from "../result-envelope.js";
import type { ResultUsageBlock } from "../types.js";
import type { SessionEndReason } from "./agy-driver.js";
import {
  kimiPromptIsCommand,
  kimiSessionCapabilities,
  parseKimiStreamLine,
} from "./kimi-session.js";
import {
  applyAuthorPrefix,
  parseInputLine,
  type InputRejectionReason,
} from "./protocol.js";
import {
  callerStdinFailure,
  crashSynthesisReason,
  harnessFailed,
  SESSION_SIGNAL_EXIT_CODE,
  type SessionChildOutcome,
} from "./process.js";
import { addUsage } from "./usage.js";
import { EndCauseLog, type SessionEndCause, type TurnProcessPhase } from "./turn-per-process.js";

/**
 * The slice of SessionProcess the machine names in its effects: what a
 * turn's child must let the executor do (stop it, close its stdin, await
 * its settling and exit). Real children are
 * SessionProcess instances; the interleaving suite scripts this surface.
 */
export interface TurnChild {
  requestStop(): void;
  endInput(): void;
  awaitEndAnswer(answered: () => boolean): Promise<void>;
  readonly settled: Promise<void>;
  readonly exited: Promise<SessionChildOutcome>;
  /** SIGKILL the child's whole process group at once (round al30, edges
   * major 3): the escalation a second SIGINT/SIGTERM triggers while the
   * first signal's shutdown still runs. Optional because the
   * interleaving suite scripts this surface; real children are
   * SessionProcess instances, which implement it. */
  escalateStop?(): void;
}

export interface KimiMachineConfig {
  authorPrefix: boolean;
  /** Whether the registry is in play (a registryPath was given). */
  registryEnabled: boolean;
}

/** The open turn's own accumulators, reset when the turn opens. */
export interface KimiTurnSlot {
  id: string;
  /** Recorded when the turn opens, before the turn_started emission it
   * belongs to: an emission can end the session synchronously (the
   * outbound queue's overflow), and the synthesized ledger record must
   * read the turn's true start. */
  startedAt: number;
  /** An assistant frame with text arrived this turn (round al33, edges
   * major 2: a frame carrying only tool calls asks for work, it is not
   * a reply, so it does not set this — the turn's answer is the final
   * assistant text, and a stream that never delivers one has not
   * answered). */
  sawAssistant: boolean;
  /** Tool calls this turn opened that no tool result has answered, keyed
   * by call id to the tool's name (round al35, correctness major 3):
   * nonempty at the child's exit, the tool loop was cut mid-flight. The
   * map's keying is the grammar itself — a duplicate id, a result for
   * an unknown id, or a result arriving twice is a malformed tool loop
   * the session fails on, never a set difference that silently loses
   * one call's fate. */
  pendingToolCalls: Map<string, string>;
  /** Call ids remain reserved for the whole turn, including after a result. */
  seenToolCallIds: Set<string>;
  /** An assistant frame with text arrived while no call this turn
   * opened was still unanswered — the final reply, the line the writer
   * prints once every call's result has landed (round al34, edges
   * major 1: a reply that arrives while a call is still pending is
   * mid-loop prose, not the answer, so it does not set this). False
   * while the loop is open, so a stream ending mid-loop ends without
   * it. */
  sawFinalAssistantText: boolean;
  sawHint: boolean;
}

export interface KimiMachineState {
  phase: TurnProcessPhase;
  /** The native session id: the registry-vouched resume id from
   * construction, or the id the first resume hint named. Null until one
   * of those lands; a fresh session that stays null past its first turn
   * is untrackable and ends the session. */
  sessionId: string | null;
  /** session_started went out. */
  announced: boolean;
  /** The start record exists in the registry. */
  registryRecorded: boolean;
  /** A record_start effect is out; its record_outcome has not landed. */
  recordPending: boolean;
  pendingHint: string | null;
  /** The CLI claimed the record for a resume before anything spawned. */
  resumeClaimed: boolean;
  turn: KimiTurnSlot | null;
  /** The open turn's landed child; null while the spawn is in flight. */
  child: TurnChild | null;
  /** The turn's spawn promise exists and may still produce a child. */
  spawnInFlight: boolean;
  /** An end abandoned the in-flight spawn: its late landing is the
   * hold's business, never an event; the registry release waits for it. */
  spawnAbandoned: boolean;
  /** The cause log: null cause while the session is live, the first
   * cause forever after, later causes as diagnostics. */
  end: EndCauseLog;
  /** The end path still owes the open turn its run (a graceful first
   * cause, no later cause, no fatal): lines parse, a late child is
   * adopted and drained rather than stopped. */
  graceOpen: boolean;
  /** A fatal error was raised (first or later cause): the parse arm is
   * closed and the turn's confirmation withdrawn. */
  fatalClosed: boolean;
  /** The first fatal's message, for the synthesized completion's reason. */
  fatalMessage: string | null;
  /** This turn's own resume hint confirmed the session (the rule above). */
  confirmed: boolean;
  /** Some completed turn lacked its confirmation (the resumable rule). */
  sawUnconfirmedTurnFailure: boolean;
  /** The harness child's own exit outcome, recorded when the child exited
   * (childExit), for the session_ended event to carry (the harnessExit
   * field's note); null when no child exited. */
  harnessExit: SessionChildOutcome | null;
  sawHarnessFailure: boolean;
  turnCounter: number;
  inputSeq: number;
  /** The cumulative usage fold: kimi reports none, so every addend is
   * the honest all-null block and the totals stay all-null. */
  cumulative: ResultUsageBlock;
}

export type KimiEvent =
  | { kind: "user_input"; line: string }
  | { kind: "run_started" }
  | { kind: "spawn_settled"; child: TurnChild }
  | { kind: "spawn_failed"; error: unknown }
  | { kind: "child_line"; line: string }
  | { kind: "child_exit"; child: TurnChild; outcome: SessionChildOutcome }
  | { kind: "stdin_eof"; error?: unknown }
  | { kind: "signal" }
  | { kind: "session_timeout" }
  | { kind: "fatal"; source: "codemux" | "harness"; message: string }
  | { kind: "registry_error"; message: string }
  | { kind: "record_outcome"; ok: boolean; error?: string }
  /** Internal: the executor delivers this once every child of the end
   * path has settled — the one transition into `ended`. */
  | { kind: "children_settled" };

export type KimiEffect =
  | { kind: "ack"; inputSeq: number; accepted: boolean; reason?: InputRejectionReason }
  | { kind: "emit"; event: "user_message"; inputSeq: number; text: string; author: string | undefined; turnId: string }
  | { kind: "emit"; event: "turn_started"; turnId: string }
  | {
      kind: "emit";
      event: "turn_completed";
      turnId: string;
      finish: "end" | "failed" | "interrupted";
      reason?: string;
    }
  | { kind: "emit"; event: "assistant_message"; raw: string; text: string; turnId: string }
  | { kind: "emit"; event: "tool_call"; raw: string; callId: string; name: string; input: unknown }
  | { kind: "emit"; event: "tool_result"; raw: string; callId: string; output: unknown }
  | { kind: "emit"; event: "unknown_event"; raw: string }
  | { kind: "announce" }
  | {
      kind: "emit";
      event: "session_ended";
      reason: SessionEndReason;
      exitCode: number | null;
      /** The harness child's own exit outcome, whatever ended the session
       * (round al37, correctness major 2's other half): the end path's
       * summary code is an answer codemux computed, so the event also
       * carries the child's raw `{code, signal}` — null when no child
       * ever exited (a spawn that failed before one existed) — and
       * nothing the child did is hidden behind the summary. */
      harnessExit: SessionChildOutcome | null;
      usage: ResultUsageBlock;
      resumable: boolean;
    }
  | { kind: "error"; fatal: boolean; source: "codemux" | "harness"; message: string }
  | { kind: "spawn"; prompt: string }
  /** Wire the child's exit (settled first) as a child_exit event and
   * close its stdin; the end path awaits the same delivery. */
  | { kind: "attach_child"; child: TurnChild }
  /** Stop a child no state can adopt (defensive: a spawn settling after
   * the end path passed its waits) and settle it before anything
   * releases the record. */
  | { kind: "stop_child"; child: TurnChild }
  | { kind: "arm_session_timer" }
  | { kind: "disarm_session_timer" }
  /** Write the registry start record; the outcome arrives as
   * record_outcome. */
  | { kind: "record_start" }
  /** Run the end-path procedure: wait for (or stop) what the state owes,
   * then deliver children_settled. Issued exactly once, at the first
   * end-cause transition. */
  | { kind: "end_path" }
  /** Cut the end path's waits: the graceful spawn race resolves, the
   * drain's answer wait returns, the child is stopped. */
  | { kind: "cut_waits" }
  /** An in-flight spawn was abandoned: defer the registry release behind
   * its settling (the hold, invariant 4). */
  | { kind: "hold_release" }
  /** Release the registry record (only when no spawn was abandoned —
   * the hold owns it then). */
  | { kind: "release_registry" }
  | { kind: "stamp_activity" }
  | { kind: "ledger_turn"; turnId: string; startedAt: number; finish: "end" | "failed" | "interrupted" }
  | { kind: "ledger_session"; reason: SessionEndReason; exitCode: number | null; usage: ResultUsageBlock }
  | { kind: "resolve_done"; code: number };

const CAPABILITIES = kimiSessionCapabilities();
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

export function initialKimiState(resumeSessionId: string | null): KimiMachineState {
  return {
    phase: "idle",
    sessionId: resumeSessionId,
    announced: false,
    registryRecorded: false,
    recordPending: false,
    pendingHint: null,
    resumeClaimed: false,
    turn: null,
    child: null,
    spawnInFlight: false,
    spawnAbandoned: false,
    end: new EndCauseLog(),
    graceOpen: false,
    fatalClosed: false,
    fatalMessage: null,
    confirmed: false,
    sawUnconfirmedTurnFailure: false,
    harnessExit: null,
    sawHarnessFailure: false,
    turnCounter: 0,
    inputSeq: 0,
    cumulative: emptyUsage(),
  };
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
      return [{ kind: "attach_child", child: event.child }];
    }
    case "spawn_failed": {
      if (!state.spawnInFlight || state.spawnAbandoned) {
        return []; // the hold owns abandoned spawns; defensive
      }
      state.spawnInFlight = false;
      const message = turnSpawnFailureMessage(event.error);
      if (state.end.cause === null) {
        // The accepted turn never ran: codemux's own failure, a crash
        // end — never a silently interrupted turn.
        return fatalEnd(state, "codemux", message, "crash", 1);
      }
      // The graceful end awaited this spawn and it rejected: a later
      // cause. The race the end path runs resolves with it; the turn's
      // synthesis reads failed.
      state.end.record({ reason: "crash", code: 1 });
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
    case "child_exit":
      return childExit(state, event.child, event.outcome);
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
      if (event.ok) {
        state.registryRecorded = true;
        if (!state.announced) {
          state.announced = true;
          const hint = state.pendingHint;
          state.pendingHint = null;
          return [
            { kind: "announce" },
            ...(hint === null ? [] : [{ kind: "emit", event: "unknown_event", raw: hint } as KimiEffect]),
          ];
        }
        return [];
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
      const cause = state.end.cause;
      const failedChild = state.sawHarnessFailure;
      const endReason = failedChild ? "harness_failed" : cause.reason;
      const endCode = Math.max(state.end.exitCode, failedChild ? 1 : 0);
      const effects: KimiEffect[] = [];
      if (state.turn !== null) {
        // The turn_started the caller saw must be answered (the
        // synthesized completion): failed when any fatal owns the story,
        // interrupted otherwise. An open turn cut by the end never
        // closed, so its closing hint never came — the same
        // unconfirmed-turn evidence a completed turn records, whatever
        // the synthesized verdict reads.
        if (!state.confirmed) state.sawUnconfirmedTurnFailure = true;
        const finish: "failed" | "interrupted" = state.fatalClosed ? "failed" : "interrupted";
        const reason =
          state.fatalMessage !== null
            ? crashSynthesisReason(state.fatalMessage)
            : `the session ended (${cause.reason}) before the turn completed`;
        effects.push(
          {
            kind: "emit",
            event: "turn_completed",
            turnId: state.turn.id,
            finish,
            reason,
          },
          {
            kind: "ledger_turn",
            turnId: state.turn.id,
            startedAt: state.turn.startedAt,
            finish,
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

// --- helpers ----------------------------------------------------------------

/** Begin the end path: the cause is recorded (first cause), the phase
 * picks itself by what the path still owes — a landed child to drain,
 * or an in-flight spawn only a graceful end awaits (a killing end
 * abandons it: the probes must not stretch the deadline, and the hold
 * defers the registry release behind its settling) — and the end_path
 * effect starts the executor's procedure.
 *
 * A fatal first cause is always a killing end (round al30, rule 4,
 * correctness major 3): the stdin read error records the end reason
 * `stdin-close` — the channel did close — but a FAILED close is a fatal
 * like every other (fatalClosed), and treating it as graceful gave the
 * end path its answer period while the parse arm it had already closed
 * accepted the drain's output nowhere. The kill path is the only one
 * that matches: stop the child, abandon the spawn, no drain. */
function startEndPath(state: KimiMachineState): KimiEffect[] {
  const cause = state.end.cause!;
  const killing =
    state.fatalClosed || (cause.reason !== "stdin-close" && cause.reason !== "shutdown" &&
      (cause.reason !== "signal" || state.spawnInFlight));
  const effects: KimiEffect[] = [];
  if (killing && state.spawnInFlight && !state.spawnAbandoned && state.child === null) {
    state.spawnAbandoned = true;
    effects.push({ kind: "hold_release" });
  }
  const awaitsSpawn =
    !killing && state.spawnInFlight && !state.spawnAbandoned && state.child === null;
  state.phase = state.child !== null || awaitsSpawn ? "draining" : "ending";
  state.graceOpen = !killing;
  effects.push({ kind: "end_path" });
  return effects;
}

/** A signal or timeout arriving while an end owns: a diagnostic that
 * cuts every wait (and abandons an awaited spawn) but never rewrites
 * the reason. As a FIRST cause it simply ends the session. */
function interruption(
  state: KimiMachineState,
  cause: SessionEndCause & { message: string }
): KimiEffect[] {
  if (state.end.cause === null) {
    state.end.record(cause);
    return startEndPath(state);
  }
  state.end.record(cause);
  state.graceOpen = false;
  const effects: KimiEffect[] = [
    { kind: "error", fatal: false, source: "codemux", message: cause.message },
  ];
  if (state.spawnInFlight && !state.spawnAbandoned) {
    state.spawnAbandoned = true;
    effects.push({ kind: "hold_release" });
  }
  effects.push({ kind: "cut_waits" });
  return effects;
}

/** A fatal error (parse, protocol, spawn, registry, the caller's own
 * input channel): closes the parse arm, withdraws the confirmation,
 * ends the session — as the first cause when none owns yet, else as a
 * diagnostic later cause that cuts the end path's waits. */
function fatalEnd(
  state: KimiMachineState,
  source: "codemux" | "harness",
  message: string,
  reason: SessionEndReason,
  code: number
): KimiEffect[] {
  state.fatalClosed = true;
  state.fatalMessage ??= message;
  state.confirmed = false;
  const error: KimiEffect = { kind: "error", fatal: true, source, message };
  if (state.end.cause === null) {
    state.end.record({ reason, code });
    return [error, ...startEndPath(state)];
  }
  state.end.record({ reason, code });
  state.graceOpen = false;
  const effects: KimiEffect[] = [error];
  if (state.spawnInFlight && !state.spawnAbandoned) {
    state.spawnAbandoned = true;
    effects.push({ kind: "hold_release" });
  }
  effects.push({ kind: "cut_waits" });
  return effects;
}

/** One output line from the open turn's child. Parsed only while a live
 * turn runs or a graceful, uncut, un-fataled drain still owes the turn
 * its run; once a killing end, a cut, or any fatal owns, later bytes
 * are accepted nowhere (a stream the session already reported as
 * fatally broken cannot emit post-fatal events or re-confirm the store
 * through a late hint). */
function childLine(
  state: KimiMachineState,
  line: string,
  config: KimiMachineConfig
): KimiEffect[] {
  const parseOpen =
    state.phase === "running" ||
    state.phase === "idle" ||
    state.phase === "spawning" ||
    (state.phase === "draining" && state.graceOpen);
  if (!parseOpen || state.fatalClosed) return [];
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
function childExit(
  state: KimiMachineState,
  child: TurnChild,
  outcome: SessionChildOutcome
): KimiEffect[] {
  if (state.child !== child) return []; // superseded — defensive
  state.harnessExit = outcome;
  state.sawHarnessFailure ||= harnessFailed(outcome);
  if (state.fatalClosed) {
    // A fatal-owned session leaves the turn open
    // for the synthesis at children_settled.
    return [];
  }
  if (state.turn === null) return []; // defensive: nothing to complete
  const endOwns = state.end.cause !== null;
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
      },
      { kind: "ledger_turn", turnId: turn.id, startedAt: turn.startedAt, finish: "failed" },
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
  // before this verdict ever reads them).
  const unresolvedCalls = turn.pendingToolCalls.size;
  const failed =
    harnessFailed(outcome) ||
    !turn.sawAssistant ||
    !turn.sawFinalAssistantText ||
    !state.confirmed;
  if (!state.confirmed) {
    state.sawUnconfirmedTurnFailure = true;
  }
  state.cumulative = addUsage(state.cumulative, emptyUsage());
  effects.push(
    {
      kind: "emit",
      event: "turn_completed",
      turnId: turn.id,
      finish: failed ? "failed" : "end",
      ...(failed
        ? {
            reason:
              outcome.code !== 0
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
    },
    { kind: "ledger_turn", turnId: turn.id, startedAt: turn.startedAt, finish: failed ? "failed" : "end" },
    { kind: "stamp_activity" }
  );
  return effects;
}
