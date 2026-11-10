/**
 * The droid agent's turn-per-process profile (turn-driver-core.ts): the
 * identity deferred to the first turn's completion event (the opencode
 * model — droid mints the id, codemux adopts it), the prompt on stdin,
 * `droid exec --output-format stream-json` per turn with `-s <id>` on every
 * resumed one (src/session/droid-session.ts). A hermetic session runs
 * every turn under the run path's env(1) HOME redirect
 * (turn-driver-homes.ts), and an override session rides the per-turn
 * BYOK settings file (the --settings extension the driver passes).
 */

import type { TurnAgentProfile } from "./turn-driver-core.js";
import { droidSessionHermeticAssignments } from "./turn-driver-homes.js";
import {
  buildDroidSessionCommand,
  droidSessionCapabilities,
  parseDroidSessionTurn,
} from "./droid-session.js";

export const DROID_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "droid",
  capabilities: droidSessionCapabilities(),
  identity: "deferred",
  promptCarrier: "stdin",
  buildTurnCommand: (input) =>
    buildDroidSessionCommand({
      resumeSessionId: input.sessionId ?? undefined,
      // The raw spelling feeds the effort mapping; the BYOK entry's id
      // (the run path's rule) feeds -m — never one field for both.
      model: input.model,
      providerModelId: input.providerModelId,
      autonomy: input.autonomy,
      effort: input.effort,
      settingsPath: input.providerSettingsPath,
      hermeticEnvAssignments:
        input.hermeticHome === null
          ? undefined
          : droidSessionHermeticAssignments(input.hermeticHome),
      // `--tools none` reapplies on every turn (the run path's
      // --only-tools carrier).
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
    }),
  parseTurnOutput: (stdout, knownSessionId) => {
    const parsed = parseDroidSessionTurn(stdout, { knownSessionId });
    return {
      answer: parsed.answer,
      usage: parsed.usage,
      modelEffective: null,
      sessionId: parsed.sessionId,
      noSessionId: parsed.noSessionId,
      wrongSession: parsed.wrongSession,
      noWire: parsed.noWire,
      // A failed droid turn fails on the exit code: under stream-json a
      // failure also prints an error event (parsed into errorMessage), and
      // a launch that printed no event at all is the noWire fatal.
      failed: false,
      failureReason: null,
    };
  },
};
