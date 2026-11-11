import { resolveTrustedCommand } from "./executable-security.js";
import { buildScodeCommand, type SandboxOptions } from "./sandbox.js";
import type { AutonomyLevel } from "./types.js";

/** Resolve the same executable positions as run, TUI, and session spawns.
 * A missing or refused executable makes only this diagnostic row unavailable. */
export function verifiedScodeCommand(
  command: string[], cwd: string, autonomy: AutonomyLevel, options: SandboxOptions
): { command: string[]; error?: string } {
  try {
    const resolved = resolveTrustedCommand(command, "sandbox command", cwd, process.env.PATH ?? "");
    return { command: buildScodeCommand(resolved, cwd, autonomy, options) };
  } catch (error) {
    return { command: [], error: error instanceof Error ? error.message : String(error) };
  }
}
