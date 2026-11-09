/** The completion event the end path synthesizes for a turn still open
 * once the child settled (design §4.1: every turn_started is answered),
 * together with its finish verdict. Extracted from the end path itself
 * (src/session/driver.ts) when that file reached the 500-line cap; the
 * orchestration around it — the transition, the emit, the ledger line —
 * stays there. */

import { crashSynthesisReason, drainFailureMessage, type SessionChildOutcome } from "./process.js";
import { buildEvent } from "./protocol.js";
import { emptyUsage } from "../result-envelope.js";
import type { SessionEndReason } from "./driver-io.js";

/** finish: failed for a crash end, a drain failure, or any fatal raised
 * during an orderly end's drain (an overlong line, an unknown response
 * id — review live22); interrupted otherwise. The reason mirrors the
 * fatal or the drain failure that reported the failure; an orderly end
 * says the session ended before the turn completed. Usage is all-null
 * (never guessed zeros): nothing reported a turn the harness never
 * answered. */
export function synthesizedTurnCompletion(
  seq: number,
  sessionId: string,
  turnId: string | null,
  reason: SessionEndReason,
  drainFailureCode: number | null,
  firstFatal: string | null,
  agent: string,
  childOutcome: SessionChildOutcome,
  modelAlias: string | null
): { event: string; finish: "failed" | "interrupted" } {
  const finish: "failed" | "interrupted" =
    reason === "crash" || drainFailureCode !== null || firstFatal !== null
      ? "failed"
      : "interrupted";
  const reasonText =
    reason === "crash"
      ? crashSynthesisReason(firstFatal)
      : drainFailureCode !== null
        ? drainFailureMessage(agent, childOutcome, true)
        : firstFatal !== null
          ? crashSynthesisReason(firstFatal)
          : `the session ended (${reason}) before the turn completed`;
  return {
    event: buildEvent(seq, sessionId, "turn_completed", null, {
      turn_id: turnId,
      finish,
      reason: reasonText,
      usage: emptyUsage(),
      // The harness never answered this turn, so no provider naming
      // (message.model) ever completed it: no served model is attributed
      // to a synthesized completion (design P5's fail-closed rule).
      model_served: null,
      model_served_source: null,
      model_alias: modelAlias,
    }),
    finish,
  };
}
