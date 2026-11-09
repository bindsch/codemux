/**
 * The pi agent's turn-per-process profile (turn-driver-core.ts): a
 * codemux-minted identity carried on EVERY turn (`--session-id <mint>`,
 * never --resume — pi opens the id or creates it), the prompt on stdin,
 * and the json-mode envelope's header line naming the session
 * (src/session/pi-session.ts). A hermetic session runs every turn with
 * --no-context-files and the PI_CODING_AGENT_DIR redirect at the session
 * home (turn-driver-homes.ts).
 */

import type { TurnAgentProfile, TurnCommandInput } from "./turn-driver-core.js";
import type { ToolSelection } from "../types.js";
import { piSessionHermeticAssignments } from "./turn-driver-homes.js";
import {
  buildPiSessionCommand,
  parsePiSessionTurn,
  piSessionCapabilities,
} from "./pi-session.js";

/** The shared launcher's pi fields. Optional until the shared plumbing lands. */
export interface PiTurnCommandInput extends TurnCommandInput {
  tools?: ToolSelection;
  sessionDir?: string;
  mcpExtensionPath?: string;
}

export function buildPiDriverTurnCommand(input: PiTurnCommandInput): string[] {
  if (input.sessionId === null) {
    throw new Error("the minted pi identity names its id before any turn");
  }
  return buildPiSessionCommand({
    sessionId: input.sessionId,
    sessionDir: input.sessionDir,
    mcpExtensionPath: input.mcpExtensionPath,
    autonomy: input.autonomy,
    tools: input.tools,
    model: input.model,
    providerModelId: input.providerModelId,
    effort: input.effort,
    hermetic: input.hermeticHome !== null,
    hermeticEnvAssignments:
      input.hermeticHome === null
        ? undefined
        : piSessionHermeticAssignments(input.hermeticHome),
  });
}

export const PI_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "pi",
  capabilities: piSessionCapabilities(),
  identity: "minted",
  promptCarrier: "stdin",
  buildTurnCommand: buildPiDriverTurnCommand,
  parseTurnOutput: (stdout, knownSessionId) => {
    const parsed = parsePiSessionTurn(stdout, { knownSessionId });
    // Json mode keeps the process exit 0 for stopReason failures, so the
    // structured report is the verdict (the module's pin).
    const failed =
      parsed.stopReason === "error" || parsed.stopReason === "aborted" ||
      parsed.errorText !== null;
    return {
      answer: parsed.answer,
      usage: parsed.usage,
      modelEffective: parsed.servedModel,
      sessionId: parsed.sessionId,
      noSessionId: parsed.noSessionId,
      wrongSession: parsed.wrongSession,
      noWire: parsed.noWire,
      failed,
      failureReason: parsed.errorText ?? parsed.stopReason,
    };
  },
};
