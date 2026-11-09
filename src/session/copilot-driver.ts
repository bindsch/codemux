/**
 * The copilot agent's turn-per-process profile (turn-driver-core.ts): a
 * codemux-minted identity claimed with `--session-id <mint>` on the
 * first turn and continued with `--resume <mint>` (the FULL id, never a
 * prefix) on every later one, the prompt on stdin, and the JSONL wire's
 * final result line as the turn's verdict (src/session/copilot-session.ts).
 * The base profile has no metrics artifact. copilot-profile.ts adds its
 * per-turn parser when the launcher prepares that artifact. A hermetic
 * session runs every turn under the COPILOT_HOME
 * redirect at the session home (the module's own env wrap).
 */

import { emptyUsage } from "../result-envelope.js";
import type { TurnAgentProfile } from "./turn-driver-core.js";
import {
  buildCopilotSessionCommand,
  copilotSessionCapabilities,
  parseCopilotSessionTurn,
} from "./copilot-session.js";

export const COPILOT_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "copilot",
  capabilities: copilotSessionCapabilities(),
  identity: "minted",
  promptCarrier: "stdin",
  buildTurnCommand: (input) => {
    if (input.sessionId === null) {
      throw new Error("the minted copilot identity names its id before any turn");
    }
    return buildCopilotSessionCommand({
      sessionId: input.sessionId,
      firstTurn: input.firstTurn,
      autonomy: input.autonomy,
      model: input.model,
      effort: input.effort,
      prompt: input.text,
      hermeticHome: input.hermeticHome ?? undefined,
      callerOwnedHome: input.callerHome !== undefined,
    });
  },
  parseTurnOutput: (stdout, knownSessionId) => {
    if (knownSessionId === null) {
      throw new Error("the minted copilot identity names its id before any turn");
    }
    const parsed = parseCopilotSessionTurn(stdout, { knownSessionId });
    return {
      answer: parsed.answer,
      usage: emptyUsage(),
      modelEffective: null,
      // The result line's sessionId echo: absent is the shape failure
      // (the minted identity is never deferred).
      sessionId: parsed.sessionId,
      noSessionId: parsed.sessionId === null,
      wrongSession: parsed.wrongSession,
      noWire: parsed.noWire,
      // The result line carries the harness's own exit-code report; it
      // is the structured verdict even when the process exit was 0.
      failed: parsed.reportedExitCode !== null && parsed.reportedExitCode !== 0,
      failureReason: parsed.errorText,
    };
  },
};
