/**
 * The kimi machine's shared contracts: the child surface, the state,
 * the events, the effects, and the capability matrix every input is
 * checked against. src/session/kimi-machine.ts owns the public
 * surface; the transition lives in kimi-machine/step.ts.
 */

import type { ResultUsageBlock } from "../../types.js";
import type { SessionEndReason } from "../agy-driver.js";
import { kimiSessionCapabilities } from "../kimi-session.js";
import type { InputRejectionReason } from "../protocol.js";
import type { SessionChildOutcome } from "../process.js";
import type { EndCauseLog, TurnProcessPhase } from "../turn-per-process.js";

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

export const CAPABILITIES = kimiSessionCapabilities();
