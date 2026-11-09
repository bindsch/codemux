import { buildEvent } from "./protocol.js";

/** How a session's harness child ended, and the shared closing event
 * built from it. Split from process.ts to keep that file under the size
 * limit; process.ts re-exports every name. */
export interface SessionChildOutcome {
  code: number | null;
  signal: string | null;
}

/** Exit classification never depends on who sent a signal or when. */
export function harnessFailed(outcome: SessionChildOutcome | null): boolean {
  return outcome !== null && (outcome.signal !== null || outcome.code !== 0);
}

export function shutdownRequested(reason: string): boolean {
  return reason === "stdin-close" || reason === "shutdown" || reason === "signal";
}

/** The shared closing event preserves the raw child outcome for every harness. */
export function buildSessionEnded(
  seq: number,
  sessionId: string,
  outcome: SessionChildOutcome | null,
  fields: Record<string, unknown>
): string {
  return buildEvent(seq, sessionId, "session_ended", null, {
    ...fields,
    harness_exit: outcome,
    reason: harnessFailed(outcome) ? "harness_failed" : fields.reason,
  });
}
