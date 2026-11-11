/**
 * The goose agent's turn-per-process profile (turn-driver-core.ts): the
 * identity deferred to the first turn's startup banner (the opencode
 * model — goose mints its date-counter id, codemux scopes it with a UUID), the prompt
 * as the argv tail (`-t`), and `goose run --output-format json` per turn
 * with the `--resume --session-id <id>` pair on every resumed one
 * (src/session/goose-session.ts). A hermetic session REQUIRES the
 * provider override (turn-driver-homes.ts refuses without it — the
 * config file cannot ride into an empty home) and runs every turn under
 * the GOOSE_PATH_ROOT/XDG redirect at the session home. The GOOSE_*
 * turn environment rides the child environment through the per-turn
 * adapter chain, never argv.
 */

import type { TurnAgentProfile } from "./turn-driver-core.js";
import { gooseSessionHermeticAssignments } from "./turn-driver-homes.js";
import {
  buildGooseSessionCommand,
  gooseSessionCapabilities,
  parseGooseSessionTurn,
} from "./goose-session.js";

export const GOOSE_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "goose",
  capabilities: gooseSessionCapabilities(),
  identity: "deferred",
  promptCarrier: "argv",
  buildTurnCommand: (input) =>
    buildGooseSessionCommand({
      resumeSessionId: input.sessionId ?? undefined,
      prompt: input.text,
      hermeticEnvAssignments:
        input.hermeticHome === null
          ? undefined
          : gooseSessionHermeticAssignments(input.hermeticHome),
      // `--tools none` reapplies on every turn (the resumed-session
      // promise the run path makes).
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      // The sandbox-scoped Playwright server reapplies the same way
      // (src/goose-playwright.ts); the session gate refused a
      // non-sandboxed session long before this could be set.
      ...(input.playwrightMcp === true ? { playwrightMcp: true } : {}),
    }),
  parseTurnOutput: (stdout, knownSessionId) => {
    const parsed = parseGooseSessionTurn(stdout, { knownSessionId });
    return {
      answer: parsed.answer,
      usage: parsed.usage,
      modelEffective: null,
      sessionId: parsed.sessionId,
      noSessionId: parsed.noSessionId,
      wrongSession: parsed.wrongSession,
      noWire: parsed.noWire,
      failed: parsed.failureReason !== undefined,
      failureReason: parsed.failureReason ?? null,
    };
  },
};
