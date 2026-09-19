import type { AutonomyLevel } from "./types.js";

export type ScodeFsMode = "ro" | "rw";
export const SCODE_TRUST_LEVELS = ["trusted", "standard", "untrusted"] as const;
export type ScodeTrustLevel = (typeof SCODE_TRUST_LEVELS)[number];

export interface SandboxOptions {
  trust?: ScodeTrustLevel;
  fsMode?: ScodeFsMode;
  noNet?: boolean;
  scrubEnv?: boolean;
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

  scodeCmd.push("--", ...command);

  return scodeCmd;
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
