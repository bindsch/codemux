/**
 * The session's signal wiring and end-path failure messages.
 * src/session/process.ts owns the lifecycle and re-exports these.
 */

import type { SessionChildOutcome } from "./process.js";

/**
 * The session's signal wiring (design §4.6): the first SIGINT/SIGTERM/
 * SIGHUP starts the shutdown path; it runs to completion before codemux
 * exits 143 — never `process.exit` inside the handler. Later signals are
 * absorbed while the first one runs, except through `onLater`: round
 * al30 (edges major 3) keeps the handlers installed until the last
 * abandoned spawn is settled — past `session_ended`, where an earlier
 * round disposed them — and a second signal in that window escalates
 * (the driver kills every owned child at once) instead of being
 * absorbed while a stop that outlived the session still runs.
 * `trigger` re-enters the same rule, so a scripted delivery follows
 * the live one.
 */
export interface SessionSignalGate {
  trigger(signal: NodeJS.Signals): void;
  dispose(): void;
}

export function installSessionSignalHandlers(
  onFirst: (signal: NodeJS.Signals) => void,
  onLater?: (signal: NodeJS.Signals) => void
): SessionSignalGate {
  let fired = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (fired) {
      onLater?.(signal);
      return;
    }
    fired = true;
    onFirst(signal);
  };
  const forward = (signal: NodeJS.Signals) => () => handler(signal);
  const onSigint = forward("SIGINT");
  const onSigterm = forward("SIGTERM");
  const onSighup = forward("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  return {
    trigger: handler,
    dispose(): void {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
    },
  };
}

/** The fatal a caller-stdin read error reports (review live17): the end
 * path is the stdin-close one, but a failed read is not a clean close. */
export function callerStdinFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `reading the caller's stdin failed (${detail}); ending the session`;
}

/** The fatal for a child that exits nonzero during the end path with no
 * completion delivered (§4.6, review live9). An idle child counts too:
 * a harness that fails while persisting is a failure whether or not a
 * turn was open (review live17). */
export function drainFailureMessage(
  agent: string,
  outcome: SessionChildOutcome,
  turnOpen: boolean
): string {
  const detail = outcome.signal !== null ? `signal ${outcome.signal}` : `code ${outcome.code}`;
  return turnOpen
    ? `the ${agent} process exited with ${detail} during the shutdown drain before completing its open turn`
    : `the ${agent} process exited with ${detail} during the shutdown drain`;
}

/** The reason a crash end's synthesized turn completion carries: the
 * fatal that ended the session, which is not always the harness dying
 * (an outbound overflow, a registry failure, a caller-stdin error;
 * review live17). */
export function crashSynthesisReason(firstFatal: string | null): string {
  return firstFatal === null
    ? "the session ended on a failure before the turn completed"
    : `the session ended on a failure before the turn completed: ${firstFatal}`;
}
