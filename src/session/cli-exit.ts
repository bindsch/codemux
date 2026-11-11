// The session command's exits and cleanups: the --print-sandbox print, the
// catch-all for an unexpected error, and the private-directory removals the
// action body shares between its paths. Every finalizer the abort path owns
// runs in these, so cli.ts's action body stays a straight line.
import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import { handleUnexpectedError } from "../cli-runtime.js";
import type { CodexSessionProviderHome } from "../codex-provider.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { SessionDriver } from "./stdin-frame.js";

/**
 * The print-only exit: it runs every finalizer the abort path owns and
 * leaves through the process's exit code — never process.exit past them —
 * while removing nothing that predates it (review round 14, contracts-2
 * blocker): nothing ran, so --final has no effect here (the note below
 * says so), a RESUMED project-settings directory stays byte-identical for
 * the real attempt — its transcript is not this print's to delete — and
 * the registry is untouched: a print-only invocation never claims, so it
 * never releases or stamps either (review round 17, edges 2; the decision
 * sits ahead of the claim in cli.ts). releaseOwnedRecord stays as the
 * no-op guard. Fresh previews return representative paths without
 * creating directories, copying credentials, or sweeping old state.
 * Their abandon/remove finalizers are no-ops. Resumed previews validate
 * existing homes without modifying them.
 */
export function exitPrintedSandbox(exit: {
  codexSessionHome: CodexSessionProviderHome | null;
  finalFlag: boolean;
  sessionProjectDir: ProjectSettingsSessionDir | null;
  sessionProjectDirResumed: boolean;
  sessionPrivateHome?: SessionPrivateHome | null;
  sessionPrivateHomeResumed?: boolean;
  releaseOwnedRecord: () => void;
}): void {
  exit.codexSessionHome?.abandon();
  if (exit.finalFlag) {
    console.error("codemux: --final ignored: nothing ran");
  }
  if (exit.sessionProjectDir !== null && !exit.sessionProjectDirResumed) {
    exit.sessionProjectDir.remove();
  }
  if (
    exit.sessionPrivateHome != null &&
    exit.sessionPrivateHomeResumed !== true
  ) {
    try {
      exit.sessionPrivateHome.remove();
    } catch (error) {
      console.error(
        `codemux: cannot remove the fresh hermetic session home ${exit.sessionPrivateHome.dir} ` +
          `(${error instanceof Error ? error.message : String(error)}); the stale sweep removes it later`
      );
    }
  }
  exit.releaseOwnedRecord();
  process.exitCode = 0;
}

/**
 * An unexpected exit that never reached the spawn must not strand a fresh
 * codex override home either (review D5, correctness 3) — abandoned here,
 * not orphaned to the stale-run sweep. Once the spawn began, the home's
 * lifetime belongs to the inner catch and the driver's end path: a
 * settled home's abandon is a no-op, and a live child's CODEX_HOME is
 * never deleted under it from here. A driver that never reached its own
 * end path still holds the process's signal handlers; a second dispose on
 * one that did is a no-op.
 */
export function handleSessionAbort(
  error: unknown,
  state: {
    spawnBegan: boolean;
    codexSessionHome: CodexSessionProviderHome | null;
    abandonSessionProjectDir: () => void;
    releaseOwnedRecord: () => void;
    builtDriver: SessionDriver | null;
  }
): void {
  if (!state.spawnBegan) {
    state.codexSessionHome?.abandon();
    // A cleanup that itself threw must not mask the original error or
    // strand the claim: reported after the release and the driver
    // disposal, both of which still run (review round 14, edges 6).
    let cleanupError: unknown = null;
    try {
      state.abandonSessionProjectDir();
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    // The claim taken ahead of the launch preparation — or a fresh start
    // record a later step never confirmed — is released here too (review
    // round 13, edges 3): a throw between the claim and the spawn must
    // not leave the record held under a live pid.
    state.releaseOwnedRecord();
    if (cleanupError !== null) {
      console.error(
        `codemux: could not clean up the session's private directory: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`
      );
    }
  }
  state.builtDriver?.dispose();
  handleUnexpectedError(error);
}

/** Removes the --final private directory — the claude family's session
 * directory or a codex/kimi/agy private home, both spelled {dir, remove} —
 * reporting a failure on stderr instead of throwing, and answers whether
 * the directory is gone. The claude driver's end path runs this twice and
 * stamps the record to match: final when removed, ended and resumable with
 * exit 1 when both attempts failed (rounds 14-15); the agy driver's end
 * path runs its own two-attempt removal the same way. The CLI's finally
 * calls it where the driver end paths leave removal to the CLI: the codex
 * and kimi homes, and a fresh claude directory the end path decided
 * nothing about. */
export function removeFinalProjectDir(
  dir: Pick<ProjectSettingsSessionDir, "dir" | "remove"> | null
): boolean {
  if (dir === null) return true;
  try {
    dir.remove();
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `codemux: could not remove the session's private directory ${dir.dir} ` +
        `(${reason}); the directory was kept`
    );
    return false;
  }
}

/** The spawn-throw path's cleanup: no driver end path runs for a spawn
 * that threw, so the claim is released here (a lost release reports like
 * the drivers'). A fresh codex override home is removed, a resumed one
 * left to the sweep. The release runs in finally: a throwing removal once
 * skipped it and stranded the record — and the outer abort handler skips
 * the release too, because the spawn already began (round 23, edges 2).
 * The removal failure is reported on stderr like the --final removal's. */
export function cleanupAfterSpawnThrow(state: {
  codexSessionHome: CodexSessionProviderHome | null;
  sessionProjectDir: ProjectSettingsSessionDir | null;
  abandonSessionProjectDir: () => void;
  releaseOwnedRecord: () => void;
}): void {
  try {
    state.codexSessionHome?.abandon();
    state.abandonSessionProjectDir();
  } catch (cleanupError) {
    const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    const dir = state.sessionProjectDir === null ? "" : ` ${state.sessionProjectDir.dir}`;
    console.error(
      `codemux: could not remove the session's private directory${dir} after the failed spawn (${reason}); the directory was kept`
    );
  } finally {
    state.releaseOwnedRecord();
  }
}
