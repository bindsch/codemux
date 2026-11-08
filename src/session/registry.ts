/**
 * The session registry (design §4.8): one JSON file, one entry per
 * session, at a codemux-owned path outside harness state. It is a lookup
 * hint and a cross-agent guard, never an authorization boundary — every
 * security-relevant value of a resumed process comes from the resume
 * command alone; the record contributes no flag, no env, and no path.
 *
 * This module holds the module surface and the registry path. The model
 * and the rules — strict shape validation (fail-closed on anything
 * unexpected), read, the locked atomic read-modify-write for
 * start/touch/end, the prune to the reader's caps (1000 entries, 4 MiB)
 * that evicts ended or dead-owner entries first and only under an
 * all-live overflow the oldest live entry, and the resume guard bundle —
 * live in registry/format.ts, registry/mutations.ts, and
 * registry/resume.ts. File mechanics — placement checks, the writer
 * lock, the atomic replace — live in registry-io.ts.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export { processIdentityAlive, currentProcessIdentity } from "./registry-io.js";
export {
  canonicalSandboxBlockPaths,
  readRegistry,
  REGISTRY_MAX_ENTRIES,
  type RegistryRead,
  type SandboxTrust,
  type SessionRecord,
} from "./registry/format.js";
export {
  discardUnconfirmedRecord,
  probeRegistryForStart,
  recordSessionEnd,
  recordSessionStart,
  recordSessionStartOffStream,
  releaseSessionRecord,
  touchSession,
  type NewSessionRecord,
  type UpdateOutcome,
} from "./registry/mutations.js";
export {
  claimForResume,
  lookupForResume,
  registryInside,
  sessionHoldState,
  type ResumeLookup,
  type ResumeProbe,
  type SessionHold,
} from "./registry/resume.js";

/** The codemux-owned registry path for a home directory (design §4.8):
 * macOS `~/Library/Application Support/codemux/live-sessions.json`,
 * otherwise `$HOME/.local/state/codemux/live-sessions.json` — derived
 * from `$HOME` alone so moving `XDG_STATE_HOME` cannot hide the record
 * while the transcripts stay put. */
export function sessionRegistryPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "codemux", "live-sessions.json");
  }
  return join(home, ".local", "state", "codemux", "live-sessions.json");
}
