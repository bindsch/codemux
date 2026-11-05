/**
 * The kimi machine's end paths: the first cause's end path, the
 * later causes' cuts, and the fatal end every failure class shares.
 * The transition (kimi-machine/step.ts) calls these; src/session/
 * kimi-machine.ts owns the public surface.
 */

import type { SessionEndReason } from "../agy-driver.js";
import type { SessionEndCause } from "../turn-per-process.js";
import type { KimiEffect, KimiMachineState } from "./types.js";

/** Begin the end path: the cause is recorded (first cause), the phase
 * picks itself by what the path still owes — a landed child to drain,
 * or an in-flight spawn only a graceful end awaits (a killing end
 * abandons it: the probes must not stretch the deadline, and the hold
 * defers the registry release behind its settling) — and the end_path
 * effect starts the executor's procedure.
 *
 * Only the caller-driven ends (stdin close, shutdown) open the graceful
 * drain. Every other first cause is a killing end whether or not a
 * child has landed: the first signal (SIGINT, SIGTERM, SIGHUP) stops
 * the child at once instead of waiting out the grace deadline (review
 * round 96, whole tree) — the documented killing-end behavior, and what
 * the executor already does whenever graceOpen is false.
 *
 * A fatal first cause is always a killing end (round al30, rule 4,
 * correctness major 3): the stdin read error records the end reason
 * `stdin-close` — the channel did close — but a FAILED close is a fatal
 * like every other (fatalClosed), and treating it as graceful gave the
 * end path its answer period while the parse arm it had already closed
 * accepted the drain's output nowhere. The kill path is the only one
 * that matches: stop the child, abandon the spawn, no drain. */
export function startEndPath(state: KimiMachineState): KimiEffect[] {
  const cause = state.end.cause!;
  const killing =
    state.fatalClosed || (cause.reason !== "stdin-close" && cause.reason !== "shutdown");
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
export function interruption(
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
export function fatalEnd(
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
