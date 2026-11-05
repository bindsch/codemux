/**
 * Revalidated removal for private per-run directories (review round 96,
 * whole tree). Every finalizer that recursively removes a run directory
 * under a writable parent revalidates the parent first: it must still be
 * the real directory recorded at creation — lstat says directory (a
 * symlink is not), its realpath is unchanged, so a swapped ancestor link
 * is caught too, and its device and inode are unchanged, so another
 * directory put at the same path is caught as well. A sandboxed child with write access to the
 * grandparent can otherwise replace the parent with a symlink between
 * creation and cleanup, and a recursive removal then resolves that
 * component like any path operation would — into a directory codemux
 * never chose, removing the same-named child under it (rm does not
 * follow a link at the run directory's own name; the parent is the
 * component to check). The codex provider and the Claude project-settings
 * config already refused on the lstat half; this module is the one shared
 * implementation every such finalizer uses.
 *
 * A parent that no longer exists at its path is a refusal too (review
 * round 97): a rename moves the run directory with it, so a missing path
 * does not prove the directory is gone, and codemux cannot follow it.
 *
 * Two forms. A finalizer the adapter's cleanup calls directly uses the
 * throwing one, so a kept directory reaches the run's result; the same
 * finalizer registered as an exit or signal hook goes through
 * reportingHook, because a hook that throws replaces the process's exit
 * code and skips the hooks after it.
 */

import { lstatSync, realpathSync, rmSync } from "node:fs";
import { assertTrustedDirectory } from "./hermetic-sweep.js";

/** A parent directory recorded at creation time for later revalidation. */
export interface TrustedParentRecord {
  /** The parent's path as it was created. */
  path: string;
  /** The parent's realpath at creation time. */
  real: string;
  /** The parent's device and inode at creation time: its identity. A
   * different directory put at the same path has the same pathname and
   * realpath but not these (review round 98). */
  dev: bigint;
  ino: bigint;
}

/**
 * Records a just-made (or just-opened) parent. Throws the
 * trusted-directory refusal when the parent is not a real directory owned
 * by the current user, so a bad parent still fails the launch itself.
 */
export function recordTrustedParent(parent: string): TrustedParentRecord {
  assertTrustedDirectory(parent);
  const stat = lstatSync(parent, { bigint: true });
  return { path: parent, real: realpathSync(parent), dev: stat.dev, ino: stat.ino };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recursively removes `dir` after revalidating its parent against the
 * record. Throws when the removal was refused (the parent is no longer
 * the recorded directory, or is missing) or failed; the directory is
 * kept and the message names it. Whether a later attempt may retry is
 * the caller's rule.
 */
export function removeUnderTrustedParentOrThrow(
  dir: string,
  record: TrustedParentRecord,
  label: string
): void {
  try {
    try {
      assertTrustedDirectory(record.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(
        `${record.path} no longer exists; a renamed parent still holds the directory`
      );
    }
    // Identity, not only the name: the path must still resolve to the
    // recorded location and be the recorded directory itself. Node has
    // no descriptor-relative removal, so a swap between this check and
    // the removal below stays possible; the check closes every swap made
    // before cleanup starts. Pinning the parent with process.chdir and
    // removing by a relative name would close the rest, but it changes
    // the working directory of the whole process while other file
    // operations may be in flight, so it is not done (review round 137).
    const stat = lstatSync(record.path, { bigint: true });
    if (
      realpathSync(record.path) !== record.real ||
      stat.dev !== record.dev ||
      stat.ino !== record.ino
    ) {
      throw new Error(`${record.path} is no longer the directory this run created`);
    }
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`could not remove ${label} (${reasonOf(error)}); the directory was kept`);
  }
}

/**
 * The non-throwing form: answers true when the directory is gone, false
 * when the removal was refused or failed, and tells the operator once.
 * Safe from an exit handler.
 */
export function removeUnderTrustedParent(
  dir: string,
  record: TrustedParentRecord,
  label: string
): boolean {
  try {
    removeUnderTrustedParentOrThrow(dir, record, label);
    return true;
  } catch (error) {
    console.error(`codemux: ${reasonOf(error)}`);
    return false;
  }
}

/**
 * Wraps a throwing finalizer for an exit or signal hook: a failure is
 * reported on stderr instead of thrown.
 */
export function reportingHook(finalize: () => void): () => void {
  return () => {
    try {
      finalize();
    } catch (error) {
      console.error(`codemux: ${reasonOf(error)}`);
    }
  };
}
