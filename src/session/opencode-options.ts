/**
 * The opencode session driver's options record (src/session/
 * opencode-driver.ts owns the lifecycle; opencode-finalize.ts holds the
 * shared state and the end path). Declared in its own file so the
 * driver's class chain stays under its size bound; re-exported from
 * opencode-finalize.ts, the module the driver and the tests import it
 * from.
 */

import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import type { SessionProcess } from "./process.js";
import type { SandboxTrust } from "./registry.js";

export interface OpenCodeDriverOptions {
  /** The native session id to resume, or null to start fresh. */
  resumeSessionId: string | null;
  autonomy: AutonomyLevel;
  /** The wire model (`--model`), already provider-prefixed when an
   * override is active — the CLI owns that mapping, the driver passes it
   * through. Reported on session_started as-is. */
  model?: string;
  effort?: ReasoningEffort;
  /** The validated working directory — also the registry's cwd record. */
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  /** The trust the session actually runs at; recorded and reported as-is. */
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  /** The `--pass-env` names the child runs with; recorded for the
   * resume guard. */
  passEnv: readonly string[];
  authorPrefix: boolean;
  sessionTimeoutMs: number | null;
  /** Null disables registry writes (unit tests); the CLI always passes one. */
  registryPath: string | null;
  /** Overrides the off-stream start record's retry budget (attempts and
   * retry sleep) for tests that prove the busy-exhaustion path without
   * holding a rival lock for the shipped ~10 s. */
  registryStartBudget?: { attempts: number; retryMs: number };
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. */
  providerBaseUrl: string | null;
  /** Spawns one process per turn (the CLI's scode/env wiring around
   * SessionProcess); a throw is reported as a codemux failure, never an
   * unhandled rejection. */
  spawnTurn: (argv: string[], abandoned?: () => boolean) => Promise<SessionProcess>;
  /** The bound the end path gives an in-flight spawn before giving up
   * on it (review round 110): the CLI's --shutdown-grace. Default
   * DEFAULT_SHUTDOWN_GRACE_MS. */
  spawnGraceMs?: number;
  sink?: (line: string) => Promise<void> | void;
}
