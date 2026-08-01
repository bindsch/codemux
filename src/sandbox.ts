import type { AutonomyLevel } from "./types.js";

export type ScodeFsMode = "ro" | "rw";
export const SCODE_TRUST_LEVELS = ["trusted", "standard", "untrusted"] as const;
export type ScodeTrustLevel = (typeof SCODE_TRUST_LEVELS)[number];

export interface SandboxOptions {
  trust?: ScodeTrustLevel;
  fsMode?: ScodeFsMode;
  noNet?: boolean;
  scrubEnv?: boolean;
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
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  const sanitized = { ...extraEnv };
  for (const name of Object.keys(sanitized)) {
    if (name.toUpperCase().startsWith("SCODE_")) {
      delete sanitized[name];
    }
  }
  return sanitized;
}
