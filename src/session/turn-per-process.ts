/**
 * The turn-per-process lifecycle table (round al28's redesign): the one
 * state-and-event vocabulary every turn-per-process driver's process
 * interleaving is stated in. A turn-per-process agent (kimi, aider,
 * opencode) answers each caller input with one headless harness process,
 * so the hard part of its driver is not any single path but the
 * interleavings — a spawn in flight when the session ends, a signal that
 * lands during the shutdown drain, a child that exits while its own turn
 * is unanswerable. Rounds al1–al27 patched those interleavings one at a
 * time, each patch adding a per-interleaving flag (endEscalated,
 * cutSpawnWait, lateSpawnSettled, endExitCode's monotone max) whose
 * combination then produced a wrong verdict for the next interleaving.
 * This module is the replacement's shared half: the table both remaining
 * turn-per-process drivers are written against, so a reader can hold the
 * whole lifecycle in one place and the two drivers cannot drift into
 * privately different vocabularies.
 *
 * THE STATES (one ladder, no sub-flags):
 *
 * - idle: the session is live and no turn is open. A caller input here is
 *   accepted (validation first) and moves to spawning.
 * - spawning: a turn is open and its process spawn is in flight. No child
 *   exists yet; the spawn may still reject.
 * - running: the turn's child has landed and the turn is being answered.
 *   The child's lines are parsed; its exit completes the turn back to
 *   idle.
 * - draining: an end path owns the session AND still owes a child wait —
 *   the landed child being drained (gracefully on a stdin-close or
 *   shutdown, stopped on a signal, timeout, or crash), or an in-flight
 *   spawn the end path has not abandoned. Lines still parse here only
 *   while the drain is graceful and no fatal has landed.
 * - ending: the end path owns the session and no child wait remains (an
 *   idle end, an abandoned spawn, or the drain finished). Cleanup runs:
 *   the open turn's synthesized completion, session_ended, the registry
 *   release.
 * - ended: terminal. Every event is ignored and counted; nothing is
 *   emitted after session_ended. The one deferred effect that may still
 *   run is the abandoned spawn's stop-and-release (below) — issued by the
 *   abandoning transition, not by any event.
 *
 * THE EVENTS: user_input, spawn_settled (ok, carrying the child, or
 * error), child_line, child_exit (code and signal), stdin_eof, shutdown,
 * signal, session_timeout, turn_timeout, fatal (a parse or protocol
 * failure), registry_error.
 *
 * THE INVARIANTS (every turn-per-process driver):
 *
 * 1. ONE transition function. Every decision — which cause ends the
 *    session, whether a spawn is awaited or abandoned, whether a late
 *    child runs or is stopped, a turn's verdict, the exit code — is made
 *    by the transition from (state, event), and every effect (spawn,
 *    kill, emit, registry write, timer arm/disarm) is issued by the
 *    transition as an effect the executor performs. No callback decides
 *    policy on its own.
 * 2. ended absorbs. An event arriving in ended is ignored and counted,
 *    never reopened — except that the deferred stop-and-release an
 *    earlier transition issued still completes.
 * 3. The cause log retains caller intent and raises the exit code for
 *    later failures. The closing verdict overrides the initiating reason
 *    with harness_failed for every nonzero or signal child exit, including
 *    a failed earlier turn. shutdown_requested records caller intent
 *    independently. No ordering or signal-delivery evidence excuses an exit.
 * 4. No child outlives the record. The registry record is released only
 *    once no child of this session can exist anymore: every landed child
 *    is settled, and an abandoned in-flight spawn's late landing is
 *    stopped and settled first — the release is held behind that settle,
 *    past done, if the spawn never settles.
 *
 * THE DELIBERATE DIVERGENCES (named here, not drifted):
 *
 * - An end path that meets an in-flight spawn: kimi ABANDONS the spawn on
 *   every killing end and on any later cause cutting a graceful wait
 *   (the spawn closure runs probes whose own timeouts would stretch the
 *   caller's absolute deadline), and its late-landing child is stopped
 *   and settled before the record is released; a GRACEFUL first end
 *   (stdin-close, shutdown) awaits the spawn and runs the turn. Aider
 *   always awaits the spawn — its end path has no deadline-vs-probe
 *   tension, and awaiting keeps every child settled before done.
 * - The end code's arithmetic: kimi derives it from the cause log
 *   (EndCauseLog.exitCode, the max over every recorded cause); aider
 *   accumulates the same maximum itself — its ladder has a single
 *   reachable rung (a late child that cannot take its canned negatives
 *   raises 1), so a log of its own would only restate it.
 * - opencode (src/session/opencode-driver.ts) predates the table and is
 *   unchanged in this round; it shares the states' shapes but not this
 *   module.
 */

import type { SessionEndReason } from "./agy-driver.js";

/** The six states of the table above. */
export type TurnProcessPhase =
  | "idle"
  | "spawning"
  | "running"
  | "draining"
  | "ending"
  | "ended";

/** One would-be end of the session: what ended it, and the code the
 * process exits with when it does. */
export interface SessionEndCause {
  reason: SessionEndReason;
  code: number;
}

/**
 * The cause recorder (invariant 3): the first cause recorded is the
 * session's reason forever; every later one is kept as a diagnostic the
 * end path emits but never lets rewrite the story — while the code each
 * cause carries still counts, through the max (exitCode below). Also
 * counts the events that arrived after the session ended (invariant 2),
 * the one number that makes "ended absorbs" a checked fact instead of an
 * assumption.
 */
export class EndCauseLog {
  private firstCause: SessionEndCause | null = null;
  private readonly laterCauses: SessionEndCause[] = [];
  private ignoredEvents = 0;

  /** Record one cause; true when it was the first (the session's own
   * verdict), false when it is a diagnostic. */
  record(cause: SessionEndCause): boolean {
    if (this.firstCause === null) {
      this.firstCause = cause;
      return true;
    }
    if (
      this.laterCauses.length === 0 ||
      this.laterCauses[this.laterCauses.length - 1]!.reason !== cause.reason
    ) {
      this.laterCauses.push(cause);
    }
    return false;
  }

  /** The session's own cause, or null while the session is live. */
  get cause(): SessionEndCause | null {
    return this.firstCause;
  }

  /** The process exit code (invariant 3): the first cause's floor,
   * raised to the maximum of every cause the end path recorded. */
  get exitCode(): number {
    let code = this.firstCause?.code ?? 0;
    for (const cause of this.laterCauses) code = Math.max(code, cause.code);
    return code;
  }

  /** Whether any later cause arrived — every end-path wait is cut when
   * one does (the drain, the graceful spawn wait). */
  get cut(): boolean {
    return this.laterCauses.length > 0;
  }

  /** The diagnostics, in arrival order (deduplicated by reason: a burst
   * of the same signal is one diagnostic). */
  get later(): readonly SessionEndCause[] {
    return this.laterCauses;
  }

  /** Count one event ignored after the end (invariant 2). */
  countIgnored(): void {
    this.ignoredEvents += 1;
  }

  /** How many events arrived after the session ended. */
  get ignored(): number {
    return this.ignoredEvents;
  }
}
