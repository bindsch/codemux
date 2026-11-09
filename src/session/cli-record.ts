/** The pre-spawn registry record steps of `codemux session`, split from
 * src/session/cli.ts (the action ran past its file-size budget): the
 * writable-registry probe for the agents whose id arrives only in the
 * first turn's output, then the claude-family and aider
 * recordBeforeSpawn writes. Each failure exits 1 through the caller's
 * release path — the registry is an environment failure, not a usage
 * one — after abandoning what a fresh session had created. */

import type { AgentId } from "../types.js";
import type { AiderSessionDriver } from "./aider-driver.js";
import type { ClaudeSessionDriver } from "./driver.js";
import { exitWithCode } from "./cli-usage.js";
import { probeRegistryForStart } from "./registry.js";

export function recordSessionBeforeSpawn({
  registryPath,
  agentId,
  resumeId,
  claudeDriver,
  claudeSessionId,
  aiderDriver,
  aiderSessionId,
  releaseOwnedRecord,
  abandonSessionProjectDir,
}: {
  registryPath: string;
  agentId: AgentId;
  resumeId: string | undefined;
  /** The claude-family driver once built; null for every other agent. */
  claudeDriver: Pick<ClaudeSessionDriver, "recordBeforeSpawn"> | null;
  /** The claude family's session id (claudeBuilt.sessionId). */
  claudeSessionId: string | null;
  aiderDriver: Pick<AiderSessionDriver, "recordBeforeSpawn" | "removeFreshHistory"> | null;
  aiderSessionId: string | null;
  releaseOwnedRecord: () => void;
  abandonSessionProjectDir: () => void;
}): { freshOwnedId: string | null } {
  if (resumeId === undefined && (agentId === "agy" || agentId === "opencode" || agentId === "kimi")) {
    // agy, opencode, and kimi name a fresh conversation only in their
    // first turn's output (kimi's resume hint is that turn's last
    // line), so that turn runs before the record can exist; the
    // registry is proven writable first (review live22). Fresh
    // sessions only: a resume's claim just wrote the same file, and a
    // failing probe here would otherwise exit past the claim's release
    // (round 31, contracts 1).
    const probe = probeRegistryForStart(registryPath);
    if (!probe.ok) {
      releaseOwnedRecord();
      exitWithCode(1, `cannot record the session in the registry: ${probe.error} (registry: ${registryPath})`);
    }
  }
  if (claudeDriver !== null && claudeSessionId !== null) {
    // A claude-family session is recorded before the spawn, fresh or
    // resumed (review live22): its init frame follows the caller's
    // first input, so recording there let that turn run untracked when
    // the write failed (§4.8: an untracked live session must not run).
    // codemux chose the id, or the claim above vouched for it, so
    // nothing waits on the harness.
    const failure = claudeDriver.recordBeforeSpawn();
    if (failure !== null) {
      // The private config directory of a session that never recorded
      // is an orphan: nothing will ever resume it. Removed BEFORE the
      // release (review round 10, edges 4); the release itself stamps
      // nothing final (round 16, edges 1).
      abandonSessionProjectDir();
      releaseOwnedRecord();
      exitWithCode(1, `cannot record the session in the registry: ${failure} (registry: ${registryPath})`);
    }
    return { freshOwnedId: claudeSessionId };
  }
  if (aiderDriver !== null && aiderSessionId !== null) {
    // The same pre-spawn record for the other codemux-owned identity:
    // the fresh session's history file and the start record are in
    // place before anything spawns; a resume rewrites only the record,
    // never the history.
    const failure = aiderDriver.recordBeforeSpawn();
    if (failure !== null) {
      releaseOwnedRecord();
      // A fresh session's history directory was just created ahead of
      // this record; with the record failed, nothing points at it, so
      // remove it now rather than orphan it to the 28-day sweep
      // (review D2, correctness-2 3). No-op on a resume.
      aiderDriver.removeFreshHistory();
      exitWithCode(1, `cannot record the session in the registry: ${failure} (registry: ${registryPath})`);
    }
    return { freshOwnedId: aiderSessionId };
  }
  return { freshOwnedId: null };
}
