/**
 * The aider session driver's options record (src/session/aider-driver.ts
 * owns the lifecycle; aider-finalize.ts holds the shared state and the
 * end path). Declared in its own file so the driver's class chain stays
 * under its size bound; re-exported from aider-finalize.ts, the module
 * the driver and the tests import it from.
 */

import type { AutonomyLevel, ReasoningEffort, ToolSelection } from "../types.js";
import type { SessionProcess } from "./process.js";
import type { SandboxTrust } from "./registry.js";
import type { CallerHarnessHome } from "./harness-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";

export interface AiderDriverOptions {
  /** The codemux-minted session id (the registry key and the history
   * directory's name); aider has no native session id. */
  sessionId: string;
  /** True when this session resumes a recorded one (the id is
   * registry-vouched and the history file must already exist). */
  resume: boolean;
  autonomy: AutonomyLevel;
  /** The `--model` value (already `openai/`-prefixed under a provider
   * override — the CLI owns that mapping). Reported as-is. */
  model?: string;
  /** The `-m` value as typed when it resolved through `config.models`,
   * else null: reported as `model_alias` on the model-bearing events and
   * recorded with every ledger line (design P5). */
  modelAlias?: string | null;
  /** The `--weak-model` value; set only under a provider override. */
  weakModel?: string;
  /** Provider output limit, applied through owned native model settings. */
  maxOutputTokens?: number;
  effort?: ReasoningEffort;
  /** Native confirmations always answer no when explicitly denied. */
  permissionPolicy?: "default" | "deny";
  tools?: ToolSelection;
  /** The per-session chat history file (aiderSessionHistoryPath). */
  historyPath: string;
  /** A HERMETIC session's private home: the session-keyed directory
   * under `~/.aider/.codemux-hermetic` the launcher opens settled
   * (cli-drivers.ts), which the history file lives flat inside and every
   * turn wraps HOME at through the command's env(1) middle
   * (aiderSessionHermeticAssignments). Undefined for a plain session —
   * and undefined hermetic would fail open, so the driver arm refuses
   * that combination at construction. */
  hermeticHome?: string;
  privateHome?: SessionPrivateHome | null;
  final?: boolean;
  callerHome?: CallerHarnessHome;
  /** The validated working directory — also the registry's cwd record. */
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  /** The caller's --sandbox-block paths, canonicalized; recorded and
   * compared on resume (registry/format.ts). */
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  sandboxStrict?: boolean;
  passEnv: readonly string[];
  authorPrefix: boolean;
  sessionTimeoutMs: number | null;
  turnTimeoutMs?: number | null;
  /** Null disables registry writes (unit tests); the CLI always passes one. */
  registryPath: string | null;
  /** The harness state home recorded for this session (§4.8). */
  harnessHome: string;
  /** The provider identity recorded for the resume guard (review D3):
   * the override's base URL, or null for the operator's own login. */
  providerBaseUrl: string | null;
  /** Spawns one process per turn; a throw is reported as a codemux
   * failure, never an unhandled rejection. */
  spawnTurn: (argv: string[], abandoned?: () => boolean) => Promise<SessionProcess>;
  /** The bound the end path gives an in-flight spawn before giving up
   * on it (review round 110): the CLI's --shutdown-grace. Default
   * DEFAULT_SHUTDOWN_GRACE_MS. */
  spawnGraceMs?: number;
  sink?: (line: string) => Promise<void> | void;
}
