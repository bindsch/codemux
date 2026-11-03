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

import { emptyUsage } from "../result-envelope.js";
import { EndCauseLog } from "./turn-per-process.js";
import type { KimiMachineState } from "./kimi-machine/types.js";

export { step, turnSpawnFailureMessage } from "./kimi-machine/step.js";
export type {
  KimiEffect,
  KimiEvent,
  KimiMachineConfig,
  KimiMachineState,
  KimiTurnSlot,
  TurnChild,
} from "./kimi-machine/types.js";

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
