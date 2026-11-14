import { resolveTrustedCommand } from "./executable-security.js";
import { buildScodeCommand, type SandboxOptions } from "./sandbox.js";
import type { AutonomyLevel } from "./types.js";
import { assertCompatibleScode, resolveScodeExecutable, scodeSupportsAllowRo } from "./cli-runtime/scode.js";

export interface VerifiedScodeFeatures {
  allowRo: boolean;
  error?: string;
}

/** Probe once for the whole diagnostic table, using the launch version gate.
 * Without scode, retain the conservative static preview. */
export async function verifiedScodeFeatures(cwd: string): Promise<VerifiedScodeFeatures> {
  try {
    const scode = resolveScodeExecutable(cwd);
    if (!scode) return { allowRo: false };
    const version = await assertCompatibleScode(scode, cwd, process.env as Record<string, string>);
    return { allowRo: scodeSupportsAllowRo(version) };
  } catch (error) {
    return { allowRo: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolve the same executable positions as run, TUI, and session spawns.
 * A missing or refused executable makes only this diagnostic row unavailable. */
export function verifiedScodeCommand(
  command: string[], cwd: string, autonomy: AutonomyLevel, options: SandboxOptions,
  features: VerifiedScodeFeatures = { allowRo: false }
): { command: string[]; error?: string } {
  try {
    const resolved = resolveTrustedCommand(command, "sandbox command", cwd, process.env.PATH ?? "");
    if (features.error) return { command: [], error: features.error };
    return { command: buildScodeCommand(resolved, cwd, autonomy, options, "scode", process.env, features.allowRo) };
  } catch (error) {
    return { command: [], error: error instanceof Error ? error.message : String(error) };
  }
}
