/**
 * The qwen agent's turn-per-process profile (turn-driver-core.ts): a
 * codemux-minted identity claimed with `--session-id <mint>` on the
 * first turn and continued with `--resume <mint>` on every later one,
 * the prompt on stdin, and the result message of the json array as the
 * turn's verdict (src/session/qwen-session.ts). Safe mode is always on
 * and is the whole hermetic claim, so the driver keeps no private home
 * (the opencode rule) — the record's private_home stays null under
 * --hermetic too. The provider override rides the child environment
 * (OPENAI_* through the per-turn adapter chain), never argv.
 */

import type { TurnAgentProfile } from "./turn-driver-core.js";
import {
  buildQwenSessionCommand,
  parseQwenSessionTurn,
  qwenSessionCapabilities,
} from "./qwen-session.js";

export const QWEN_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "qwen",
  capabilities: qwenSessionCapabilities(),
  identity: "minted",
  promptCarrier: "stdin",
  buildTurnCommand: (input) => {
    if (input.sessionId === null) {
      throw new Error("the minted qwen identity names its id before any turn");
    }
    return buildQwenSessionCommand({
      sessionId: input.sessionId,
      firstTurn: input.firstTurn,
      autonomy: input.autonomy,
      model: input.model,
      tools: input.tools,
      playwrightMcp: input.playwrightMcp,
      playwrightMcpPath: input.qwenPlaywrightPath,
      callerOwnedHome: input.callerHome !== undefined,
    });
  },
  parseTurnOutput: (stdout, knownSessionId) => {
    const parsed = parseQwenSessionTurn(stdout, { knownSessionId });
    return {
      answer: parsed.answer,
      usage: parsed.usage,
      modelEffective: null,
      sessionId: parsed.sessionId,
      noSessionId: parsed.noSessionId,
      wrongSession: parsed.wrongSession,
      noWire: parsed.noWire,
      // The result message's own is_error is the structured verdict,
      // whatever the exit code was (the run path's rule).
      failed: parsed.isError,
      failureReason: parsed.errorMessage,
    };
  },
};
