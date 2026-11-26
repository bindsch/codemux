// The scode version check a sandboxed run makes before anything else
// starts: before the experiment MCP server, before a harness version
// probe, before the sandbox itself. The shared runner checks the same
// floor again at the spawn; this one exists so that a refusal comes first.
import { assertCompatibleScode, resolveScodeExecutableForEnv, scodeLaunchFloor, SCODE_MINIMUM_VERSION } from "../cli-runtime/scode.js";
import type { AgentId } from "../types.js";

/**
 * Refuse a scode below the launch floor. `ownFloor` is the agent's entry
 * in SCODE_FLOORS, the table doctor reads, so a launch refusal and the
 * SANDBOX-TOO-OLD row cannot disagree on the number. On macOS every agent
 * has a floor (0.6.11, the release that denies the keychain services);
 * elsewhere an agent without its own floor is left to the shared runner,
 * as before. Wherever a floor applies, a missing scode is refused here
 * too, so nothing starts before that refusal.
 */
export async function assertEarlyScodeFloor(
  agent: AgentId, ownFloor: string | undefined, env: Record<string, string>, cwd: string
): Promise<void> {
  const floor = scodeLaunchFloor(ownFloor);
  if (ownFloor === undefined && floor === SCODE_MINIMUM_VERSION) return;
  const scode = resolveScodeExecutableForEnv(env, cwd);
  if (!scode) {
    throw new Error(`every sandboxed ${agent} run requires scode ${floor} or newer`);
  }
  try { await assertCompatibleScode(scode, cwd, env, ownFloor); }
  catch (error) {
    throw new Error(`every sandboxed ${agent} run requires scode ${floor} or newer: ${error instanceof Error ? error.message : String(error)}`);
  }
}
