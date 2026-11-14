/**
 * The per-session private home a hermetic session gives its harness: the
 * directory the child uses as its home root, kept across turns and across
 * `--resume`, removed by `--final` at session end or by the stale sweep once
 * the registry record is free. The launcher (src/session/private-home.ts)
 * creates it; each driver consumes it and reports its path on
 * `session_started.private_home`. This file holds the contract alone so the
 * drivers and the launcher compile independently.
 */
export interface SessionPrivateHome {
  /** Absolute path of the private directory the child uses as its home
   * root. Follows the settle rename: a fresh run-shaped home's `dir` is
   * `run-<pid>-<random>` until `settle(id)` renames it, `session-<id>`
   * after (the launcher's contract, src/session/private-home.ts). */
  readonly dir: string;
  /** True when `--resume` reopened a directory older than this process. */
  readonly resumed: boolean;
  /** True once the directory sits on its session-keyed name; for codex,
   * also once its rollout paths were rebased (codex-home.ts). */
  readonly settled: boolean;
  /** Rename the fresh run-shaped directory onto `session-<id>`; idempotent. */
  settle(sessionId: string): void;
  /** Remove the directory (`--final`, or an abandoned fresh home): one
   * attempt that throws the reason when the removal is refused or fails
   * and answers true once the directory is gone — idempotent after
   * success. Callers that want retries own the loop (the drivers'
   * two-attempt `--final` sequences). */
  remove(): boolean;
  /** Real state paths scode must block while `dir` is re-allowed. */
  readonly blockedPaths: readonly string[];
}
