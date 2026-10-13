import type { AutonomyLevel } from "./types.js";

export type ScodeFsMode = "ro" | "rw";
export const SCODE_TRUST_LEVELS = ["trusted", "standard", "untrusted"] as const;
export type ScodeTrustLevel = (typeof SCODE_TRUST_LEVELS)[number];

export interface SandboxOptions {
  trust?: ScodeTrustLevel;
  fsMode?: ScodeFsMode;
  noNet?: boolean;
  scrubEnv?: boolean;
  /**
   * Environment names codemux itself injected into the child (the
   * adapter's standing and per-run variables). When scrubbing is on
   * (--sandbox-scrub-env, or scode's untrusted trust preset, which
   * implies --scrub-env) they ride scode's --keep-env exemption, so
   * the scrub strips the ambient environment without stripping the
   * configuration codemux chose -- a credential above all (a provider
   * override's key, or zai's gateway token).
   */
  keepEnv?: readonly string[];
  /**
   * True when the run cannot proceed without that exemption (a
   * credential codemux injected is the run's only one — a provider
   * override's key with the operator's own omitted on purpose, or zai's
   * gateway token): a scode without --keep-env then refuses the launch
   * instead of running it stripped.
   */
  keepEnvRequired?: boolean;
  /** Request scode's per-run scratch accounting (SCODE_ACCOUNT_FILE). */
  accountFile?: string;
  /** Opaque correlation token recorded in the accounting line (SCODE_ACCOUNT_ID). */
  accountId?: string;
}

export function mapAutonomyToScodeFsMode(autonomy?: AutonomyLevel): ScodeFsMode {
  return autonomy === undefined || autonomy === "read-only" ? "ro" : "rw";
}

export function mapAutonomyToScodeTrust(_autonomy?: AutonomyLevel): ScodeTrustLevel {
  return "standard";
}

export function buildScodeCommand(
  command: string[],
  cwd?: string,
  autonomy?: AutonomyLevel,
  options?: SandboxOptions,
  executable = "scode"
): string[] {
  if (
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("sandbox command must contain non-NUL string arguments");
  }
  const scodeCmd = [executable];

  if (cwd) {
    scodeCmd.push("-C", cwd);
  }

  const trust = options?.trust ?? mapAutonomyToScodeTrust(autonomy);
  scodeCmd.push("--trust", trust);
  const fsMode = trust === "untrusted"
    ? "ro"
    : options?.fsMode ?? mapAutonomyToScodeFsMode(autonomy);
  scodeCmd.push(fsMode === "ro" ? "--ro" : "--rw");
  if (options?.noNet) {
    scodeCmd.push("--no-net");
  }
  if (options?.scrubEnv) {
    scodeCmd.push("--scrub-env");
  }
  if (options?.keepEnv && options.keepEnv.length > 0) {
    scodeCmd.push("--keep-env", options.keepEnv.join(","));
  }

  scodeCmd.push("--", ...command);

  return scodeCmd;
}

/** Whether an environment name is a credential codemux itself injected:
 * the claude family's gateway token (`ANTHROPIC_AUTH_TOKEN`, zai's fixed
 * gateway above all — injected with no provider override to name it — and
 * claude's override) or any provider key (`*_API_KEY`, the codex, kimi,
 * and other override spellings). Under a scrub (--sandbox-scrub-env, or
 * scode's untrusted trust preset implying it) such a name cannot ride
 * the ambient environment (the scrub strips that too), so the
 * exemption is the only way the child keeps its credential — the
 * run cannot proceed without it (round al11's re-review, edges 1). */
export function isCredentialEnvName(name: string): boolean {
  return name === "ANTHROPIC_AUTH_TOKEN" || name.endsWith("_API_KEY");
}

/** The sandbox options with scode's --keep-env exemption attached for the
 * environment codemux itself injected (the adapter's standing and
 * per-run variables): when scrubbing is on those names ride the
 * exemption, so the scrub strips the ambient environment without
 * stripping the configuration codemux deliberately injected. Scrubbing
 * is on when codemux itself asked for it (`scrubEnv`) OR the trust
 * preset implies it (`trust === "untrusted"` — scode 0.6.0's untrusted
 * preset is --strict + --no-net + --scrub-env + --ro, per its --help),
 * so the exemption rides both spellings. Not on any other launch: scode
 * prints "--keep-env has no effect without --scrub-env" on stderr for
 * every run that carries the flag without a scrub (verified on the
 * installed 0.6.0), so the flag rides only where it can act. A scode
 * config file's `scrub_env: true` is invisible to codemux and stays the
 * operator's responsibility (README "Sandbox Integration"). The
 * exemption is REQUIRED — a scode without --keep-env refuses rather
 * than run it stripped — when the caller passed `keepEnvRequired` (a
 * provider override: its key is the run's only credential, the
 * operator's own having been omitted on purpose) OR the injected
 * environment itself carries a credential-shaped name
 * (isCredentialEnvName — zai's gateway token, injected with no override
 * mechanism to mark it). Options with no scrub possible or no injected
 * environment come back unchanged. One rule serves run (launch.ts),
 * tui (index.ts), and session spawns (session/cli.ts). */
export function withKeepEnvExemption(
  sandboxOptions: SandboxOptions,
  injectedEnv: Record<string, string>,
  keepEnvRequired: boolean
): SandboxOptions {
  const scrubbing =
    sandboxOptions.scrubEnv === true || sandboxOptions.trust === "untrusted";
  if (!scrubbing || Object.keys(injectedEnv).length === 0) {
    return sandboxOptions;
  }
  return {
    ...sandboxOptions,
    keepEnv: Object.keys(injectedEnv),
    keepEnvRequired:
      keepEnvRequired ||
      Object.keys(injectedEnv).some((name) => isCredentialEnvName(name)),
  };
}

export function buildSandboxEnv(
  extraEnv: Record<string, string> = {},
  sandboxOptions?: SandboxOptions
): Record<string, string> {
  const sanitized = { ...extraEnv };
  for (const name of Object.keys(sanitized)) {
    if (name.toUpperCase().startsWith("SCODE_")) {
      delete sanitized[name];
    }
  }
  // The only SCODE_* names codemux sets itself: scratch-accounting opt-ins
  // requested through --sandbox-account / --sandbox-account-id. scode
  // consumes both into private state and never passes them to the sandboxed
  // child, so setting them here does not leak into the harness environment.
  // That is confidentiality, not integrity (see scode): keep the sink
  // outside the sandbox's writable area.
  if (sandboxOptions?.accountFile) {
    sanitized.SCODE_ACCOUNT_FILE = sandboxOptions.accountFile;
  }
  if (sandboxOptions?.accountId) {
    sanitized.SCODE_ACCOUNT_ID = sandboxOptions.accountId;
  }
  return sanitized;
}
