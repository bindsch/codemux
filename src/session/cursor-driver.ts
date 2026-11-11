/**
 * The cursor agent's turn-per-process profile (turn-driver-core.ts): a
 * codemux-minted UUIDv4 identity claimed on the fresh turn
 * (--new-session-id) and resumed on every later one (--resume), the
 * prompt on stdin, and the one result line of
 * `--output-format stream-json` as the turn's whole verdict
 * (src/session/cursor-session.ts). Not hermetic-capable: the session CLI
 * refuses --hermetic for cursor, and the driver's private home stays
 * null.
 */

import { emptyUsage } from "../result-envelope.js";
import type { TurnAgentProfile } from "./turn-driver-core.js";
import {
  buildCursorSessionCommand,
  cursorSessionCapabilities,
  parseCursorSessionTurn,
} from "./cursor-session.js";

export const CURSOR_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "cursor",
  capabilities: cursorSessionCapabilities(),
  identity: "minted",
  promptCarrier: "stdin",
  buildTurnCommand: (input) => {
    if (input.sessionId === null) {
      throw new Error("the minted cursor identity names its id before any turn");
    }
    return buildCursorSessionCommand({
      autonomy: input.autonomy,
      sessionId: input.sessionId,
      startSession: input.firstTurn,
      model: input.model,
      // `--tools none` reapplies on every turn (the run path's
      // --allowed-tools carrier, so a resumed session keeps the tool set
      // the first turn promised).
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
    });
  },
  parseTurnOutput: (stdout, knownSessionId) => {
    if (knownSessionId === null) {
      // The minted identity is never null at a turn's exit; a null here
      // is the driver's own contract broken.
      return {
        answer: null,
        usage: emptyUsage(),
        modelEffective: null,
        sessionId: null,
        noSessionId: true,
        wrongSession: false,
        noWire: false,
        failed: true,
        failureReason: null,
      };
    }
    const parsed = parseCursorSessionTurn(stdout, { sessionId: knownSessionId });
    return {
      answer: parsed.answer,
      usage: parsed.usage,
      modelEffective: null,
      sessionId: parsed.sessionId,
      noSessionId: parsed.noSessionId,
      wrongSession: parsed.wrongSession,
      noWire: parsed.noWire,
      failed: parsed.failed,
      failureReason: parsed.failureReason,
    };
  },
};
