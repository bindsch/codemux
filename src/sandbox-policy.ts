import type { AgentId, AutonomyLevel } from "./types.js";
import {
  mapAutonomyToScodeTrust,
  type SandboxOptions,
  type ScodeTrustLevel,
} from "./sandbox.js";

export interface AgentSandboxDefaults {
  trustByAutonomy?: Partial<Record<AutonomyLevel, ScodeTrustLevel>>;
  noNet?: boolean;
  scrubEnv?: boolean;
}

export interface SandboxPolicyOverrides {
  trust?: ScodeTrustLevel;
  noNet?: boolean;
  scrubEnv?: boolean;
  allowNet?: boolean;
  keepEnv?: boolean;
  disableAgentDefaults?: boolean;
}

// Per-harness policy surface. Defaults are intentionally conservative to avoid
// breaking existing workflows while still allowing strict per-harness tuning.
export const AGENT_SANDBOX_DEFAULTS: Record<AgentId, AgentSandboxDefaults> = {
  // Native 4-level harnesses: keep low at untrusted, then standard.
  claude: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
  codex: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
  droid: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
  goose: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
  gemini: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
  // Coarser autonomy harnesses: keep medium stricter as well.
  opencode: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "untrusted",
      high: "standard",
    },
  },
  pi: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "untrusted",
      high: "standard",
    },
  },
  qwen: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
  zai: {
    trustByAutonomy: {
      "read-only": "untrusted",
      low: "untrusted",
      medium: "standard",
      high: "standard",
    },
  },
};

export function hasSandboxPolicyConflicts(
  overrides: Pick<SandboxPolicyOverrides, "noNet" | "allowNet" | "scrubEnv" | "keepEnv">
): string[] {
  const conflicts: string[] = [];
  if (overrides.noNet && overrides.allowNet) {
    conflicts.push("--sandbox-no-net cannot be combined with --sandbox-allow-net");
  }
  if (overrides.scrubEnv && overrides.keepEnv) {
    conflicts.push("--sandbox-scrub-env cannot be combined with --sandbox-keep-env");
  }
  return conflicts;
}

export function resolveSandboxOptionsForAgent(
  agentId: AgentId,
  autonomy: AutonomyLevel | undefined,
  overrides: SandboxPolicyOverrides = {}
): SandboxOptions {
  const defaults = overrides.disableAgentDefaults
    ? {}
    : AGENT_SANDBOX_DEFAULTS[agentId];

  const trustFromDefaults =
    (autonomy && defaults.trustByAutonomy?.[autonomy]) || mapAutonomyToScodeTrust(autonomy);

  let trust: ScodeTrustLevel = trustFromDefaults;
  if (overrides.trust) {
    trust = overrides.trust;
  }

  let noNet = Boolean(defaults.noNet);
  if (overrides.noNet) {
    noNet = true;
  }
  if (overrides.allowNet) {
    noNet = false;
  }

  let scrubEnv = Boolean(defaults.scrubEnv);
  if (overrides.scrubEnv) {
    scrubEnv = true;
  }
  if (overrides.keepEnv) {
    scrubEnv = false;
  }

  const options: SandboxOptions = { trust };
  if (noNet) {
    options.noNet = true;
  }
  if (scrubEnv) {
    options.scrubEnv = true;
  }
  return options;
}
