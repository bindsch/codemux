import { join } from "node:path";
import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";
import type { TurnAgentProfile } from "./turn-driver-types.js";

export const CLINE_SESSION_FLOOR = "3.0.74";
// cli-v3.0.74 helpers.ts randomSessionId(): Date.now() + nanoid(5) + _cli.
// https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/utils/helpers.ts#L40-L42
export const CLINE_SESSION_ID_PATTERN = /^\d{13,}_[A-Za-z0-9_-]{5}_cli$/;

export function clineSessionCapabilities(): SessionCapabilities {
  return { live_input: true, user_during_turn: false, steer: false, interrupt: true,
    permissions: false, deltas: true, file_changes: false, usage_stream: false, resume: true };
}

/** ACP dispatch happens before --data-dir handling, so the launcher must
 * supply every storage path in the environment. The constant local backend
 * also prevents implicit attachment to an operator Hub. Prompt and keys
 * never occur in this command, including its sandbox preview. */
export function buildClineSessionCommand(input: {
  home?: string | null; effort?: ReasoningEffort; autonomy?: AutonomyLevel; permissionPolicy?: "default" | "deny";
}): string[] {
  // ACP's autoApproveTools bypasses its permission callback. Keep it false
  // for explicit deny, even when the requested autonomy would allow approval.
  // https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/acpAgent.ts#L703-L709
  const approve = input.permissionPolicy !== "deny" && (input.autonomy === "medium" || input.autonomy === "high");
  return ["env", "CLINE_SESSION_BACKEND_MODE=local", "cline", "--acp", "--auto-approve", String(approve),
    ...(input.home ? ["--config", join(input.home, ".cline")] : []),
    ...(input.effort === undefined ? [] : ["--thinking", input.effort])];
}

export const CLINE_ACP_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "cline", identity: "deferred", promptCarrier: "stdin",
  capabilities: clineSessionCapabilities(),
  buildTurnCommand: (input) => buildClineSessionCommand({ home: input.hermeticHome, effort: input.effort, autonomy: input.autonomy }),
  // The ACP driver consumes frames itself; this marks the shared engine's
  // stream-verdict path so it uses the accumulated turn usage and errors.
  parseStreamLine: () => ({ kind: "unknown" }),
};
