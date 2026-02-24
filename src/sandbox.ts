import type { AutonomyLevel } from "./types.js";

export type ScodeFsMode = "ro" | "rw";
export const SCODE_TRUST_LEVELS = ["trusted", "standard", "untrusted"] as const;
export type ScodeTrustLevel = (typeof SCODE_TRUST_LEVELS)[number];

export interface SandboxOptions {
  trust?: ScodeTrustLevel;
  noNet?: boolean;
  scrubEnv?: boolean;
}

export function mapAutonomyToScodeFsMode(autonomy?: AutonomyLevel): ScodeFsMode {
  return autonomy === "read-only" ? "ro" : "rw";
}

export function mapAutonomyToScodeTrust(autonomy?: AutonomyLevel): ScodeTrustLevel {
  return autonomy === "read-only" ? "untrusted" : "standard";
}

export function buildScodeCommand(
  command: string[],
  cwd?: string,
  autonomy?: AutonomyLevel,
  options?: SandboxOptions
): string[] {
  const scodeCmd = ["scode"];

  if (cwd) {
    scodeCmd.push("-C", cwd);
  }

  scodeCmd.push("--trust", options?.trust ?? mapAutonomyToScodeTrust(autonomy));
  scodeCmd.push(mapAutonomyToScodeFsMode(autonomy) === "ro" ? "--ro" : "--rw");
  if (options?.noNet) {
    scodeCmd.push("--no-net");
  }
  if (options?.scrubEnv) {
    scodeCmd.push("--scrub-env");
  }

  scodeCmd.push("--", ...command);

  return scodeCmd;
}

export function buildSandboxEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const env = {
    ...process.env,
    ...(extraEnv ?? {}),
  } as Record<string, string>;

  // Oracle browser mode needs Chrome sandbox disabled when running under sandbox-exec.
  if (env.ORACLE_CHROME_NO_SANDBOX === undefined) {
    env.ORACLE_CHROME_NO_SANDBOX = "1";
  }

  // Playwright MCP supports env-driven no-sandbox mode.
  // This applies across harnesses when they launch @playwright/mcp.
  if (env.PLAYWRIGHT_MCP_NO_SANDBOX === undefined) {
    env.PLAYWRIGHT_MCP_NO_SANDBOX = "1";
  }

  return env;
}
