import { isAbsolute } from "node:path";
import { canonicalSandboxBlockPath } from "./session/registry/format.js";
import type { AgentId, AutonomyLevel } from "./types.js";
import type {
  SandboxOptions,
  ScodeFsMode,
  ScodeTrustLevel,
} from "./sandbox.js";

export interface SandboxPolicyOverrides {
  strict?: boolean;
  trust?: ScodeTrustLevel;
  noNet?: boolean;
  scrubEnv?: boolean;
  /** Request scode's per-run scratch accounting (see SandboxOptions). */
  accountFile?: string;
  accountId?: string;
  /** Extra paths scode must block (see SandboxOptions). */
  blockPaths?: readonly string[];
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
    // Carry the adapter identity through policy copies and executable resolution.
    // Native installs can resolve to version-named files shared by several agents.
    agentId,
    trust: overrides.trust ?? "standard",
  };
  const fsMode = autonomy ? ENFORCED_FS_MODE[agentId]?.[autonomy] : undefined;
  if (fsMode) options.fsMode = fsMode;
  if (overrides.noNet) options.noNet = true;
  if (overrides.strict) options.strict = true;
  if (overrides.scrubEnv) options.scrubEnv = true;
  if (overrides.accountFile) options.accountFile = overrides.accountFile;
  if (overrides.accountId) options.accountId = overrides.accountId;
  if (overrides.blockPaths && overrides.blockPaths.length > 0) {
    // Canonical here, at the boundary every caller crosses: a programmatic
    // request could otherwise name a symlink and retarget it before scode
    // reads --block (round 29, edges 2); the CLI's own canonicalization
    // then becomes a duplicate, not the only gate.
    options.blockPaths = overrides.blockPaths.map((path) => canonicalBlockPath(path));
  }
  return options;
}

/** The canonical spelling of a block path: the one rule the session
 * registry and the launch-time conflict check already apply
 * (canonicalSandboxBlockPath), so a programmatic caller of
 * resolveSandboxOptionsForAgent gets the same resolution the CLI's flag
 * parser gives (round 30, edges 3; round 32, contracts 7). */
export function canonicalBlockPath(path: string): string {
  // Absolute only, as the CLI requires: a relative path would resolve
  // against this process's cwd, not the run's (round 34, edges 1).
  if (!isAbsolute(path)) throw new Error(`--sandbox-block requires absolute paths: ${path}`);
  return canonicalSandboxBlockPath(path);
}
