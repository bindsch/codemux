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
import type { SessionPrivateHome } from "./private-home-types.js";

export interface OpenCodeDriverOptions {
  /** The native session id to resume, or null to start fresh. */
  resumeSessionId: string | null;
  autonomy: AutonomyLevel;
  /** The resolved model id — the CLI's resolved model, override included —
   * reported on session_started and recorded in the registry like every
   * other agent (design §2.3's normalization; the wire id stays in the
   * argv). */
  model?: string;
  /** The `-m` value as typed when it resolved through `config.models`,
   * else null: reported as `model_alias` on the model-bearing events and
   * recorded with every ledger line (design P5). */
  modelAlias?: string | null;
  /** The `--model` value the per-turn argv carries: the resolved model
   * with the provider prefix the CLI computed (opencode needs the
   * provider-qualified id on the wire); the CLI owns that mapping. */
  wireModel?: string;
  effort?: ReasoningEffort;
  /** Native per-turn deny config; the JSON wire has no approval channel. */
  permissionPolicy?: "default" | "deny";
  /** The validated working directory — also the registry's cwd record. */
  cwd: string;
  /** Hermetic sessions require privateHome and keep their native database there. */
  hermetic: boolean;
  /** Whether the session runs the project-settings isolation: `--pure`
   * dropped and the working directory's own config loaded. Recorded as
   * `project_settings` and refused as a resume mismatch in both
   * directions. */
  projectSettings?: boolean;
  sandboxed: boolean;
  /** The trust the session actually runs at; recorded and reported as-is. */
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  sandboxStrict?: boolean;
  /** The `--pass-env` names the child runs with; recorded for the
   * resume guard. */
  passEnv: readonly string[];
  authorPrefix: boolean;
  sessionTimeoutMs: number | null;
  /** The current turn is stopped at this deadline; the session stays open. */
  turnTimeoutMs?: number | null;
  /** Session-lifetime isolation supplied by the launcher. */
  privateHome?: SessionPrivateHome | null;
  final?: boolean;
  tools?: "default" | "none";
  playwrightMcp?: boolean;
  pathEnv?: string;
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
  spawnTurn: (argv: string[], abandoned?: () => boolean,
    executableChecks?: readonly import("../executable-security.js").ExecutableCheck[]) => Promise<SessionProcess>;
  /** The bound the end path gives an in-flight spawn before giving up
   * on it (review round 110): the CLI's --shutdown-grace. Default
   * DEFAULT_SHUTDOWN_GRACE_MS. */
  spawnGraceMs?: number;
  sink?: (line: string) => Promise<void> | void;
}
