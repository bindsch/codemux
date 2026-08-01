import type { AgentId, AutonomyLevel } from "./types.js";
import type {
  SandboxOptions,
  ScodeFsMode,
  ScodeTrustLevel,
} from "./sandbox.js";

export interface SandboxPolicyOverrides {
  trust?: ScodeTrustLevel;
  noNet?: boolean;
  scrubEnv?: boolean;
}

// These are security invariants, not defaults: callers cannot disable them.
const ENFORCED_FS_MODE: Readonly<
  Partial<Record<AgentId, Readonly<Partial<Record<AutonomyLevel, ScodeFsMode>>>>>
> = Object.freeze({
  codex: Object.freeze({ "read-only": "ro" }),
  opencode: Object.freeze({ "read-only": "ro" }),
});

export function resolveSandboxOptionsForAgent(
  agentId: AgentId,
  autonomy: AutonomyLevel | undefined,
  overrides: SandboxPolicyOverrides = {}
): SandboxOptions {
  const options: SandboxOptions = {
    trust: overrides.trust ?? "standard",
  };
  const fsMode = autonomy ? ENFORCED_FS_MODE[agentId]?.[autonomy] : undefined;
  if (fsMode) options.fsMode = fsMode;
  if (overrides.noNet) options.noNet = true;
  if (overrides.scrubEnv) options.scrubEnv = true;
  return options;
}
