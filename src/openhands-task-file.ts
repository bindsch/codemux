/**
 * The per-run task file behind openhands's prompt carrier.
 *
 * OpenHands 1.16.0 has no stdin transport: the task is `-t/--task <text>`
 * (argv) or `-f/--file <path>` (argparsers/main_parser.py, read
 * 2026-11-09). A prompt that rides argv is bounded by the OS limit and
 * codemux's own argv rule, so every codemux launch writes the prompt to
 * a file this module owns and passes `--file <path>`: the prompt never
 * touches argv, the argv byte bound does not apply, and the file rides
 * the same lifecycle as the run (created in prepareRun, removed in
 * cleanupRun and at process exit).
 *
 * The file lives under the real openhands directory in `.codemux/`, a
 * directory no openhands discovery scans (hooks come from
 * `{working_dir}/.openhands/hooks.json` and `~/.openhands/hooks.json`
 * only — sdk/hooks/config.py HookConfig.load at 1.16.0, read
 * 2026-11-09) and one scode keeps reachable as harness state; never
 * under the temp root, whose Linux sandbox mount would hide it — the
 * kimi no-tools file's rule (src/kimi-no-tools.ts).
 */

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidProbeAlive } from "./process-table.js";
import {
  assertTrustedParentUnchanged,
  recordTrustedParent,
  removeUnderTrustedParent,
  removeUnderTrustedParentOrThrow,
  reportingHook,
  type TrustedParentRecord,
} from "./safe-remove.js";

export interface OpenhandsTaskFile {
  /** The path to pass as `--file`. */
  path: string;
  /** Removes the file. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const FILE_PREFIX = "task-";

// A codemux that died without its exit handler leaves the file behind; it is
// swept only once older than any run could still be reading it.
const STALE_FILE_MS = 2 * 86_400_000;

/** Removes files left behind by codemux processes that no longer exist.
 * A regular file is the only entry this sweep owns; anything else
 * carrying the name stays with a report (the kimi no-tools sweep's
 * rule, src/kimi-no-tools.ts). */
function sweepStaleFiles(parent: string, record: TrustedParentRecord): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^task-(\d+)-/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pidProbeAlive(pid)) continue;
    const path = join(parent, entry);
    // The age comes from the lstat itself (statSync would follow a
    // symlink to time its target), and the identity check runs before
    // any removal is attempted.
    const identity = lstatSync(path, { throwIfNoEntry: false });
    if (identity === undefined) continue;
    if (Date.now() - identity.mtimeMs < STALE_FILE_MS) continue;
    if (!identity.isFile()) {
      console.error(
        `codemux: the stale openhands task file ${path} is not a regular file; the file was kept`
      );
      continue;
    }
    // One bad entry must not block the run, or every later run: the
    // entry stays, the sweep moves on, and the operator learns why.
    removeUnderTrustedParent(path, record, `the stale openhands task file ${path}`);
  }
}

/**
 * Writes the task file carrying this run's prompt. `openhandsDir` is the
 * real openhands directory (`~/.openhands`).
 */
export function writeOpenhandsTaskFile(
  openhandsDir: string,
  prompt: string
): OpenhandsTaskFile {
  const parent = join(openhandsDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Recorded before the sweep runs, and every removal revalidates the
  // record (src/safe-remove.ts): an openhands child with write access to
  // the directory could replace `.codemux` with a symlink in between,
  // so a bare rm removed the same-named file wherever the replacement
  // pointed.
  const parentRecord: TrustedParentRecord = recordTrustedParent(parent);
  sweepStaleFiles(parent, parentRecord);
  assertTrustedParentUnchanged(parentRecord, "the openhands task file parent");
  const path = join(parent, `${FILE_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}.txt`);
  // The create is exclusive, and EEXIST removes nothing: an entry
  // already at the name is not this run's. A write that fails removes
  // the just-made file through the same revalidated removal the
  // finalizer uses, and the original error reaches the caller.
  try {
    writeFileSync(path, prompt, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      removeUnderTrustedParent(path, parentRecord, `the openhands task file ${path}`);
    }
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // Thrown when refused or failed, so the run's cleanup reports the
    // kept file; it stays retryable, and the exit hook retries and
    // reports.
    removeUnderTrustedParentOrThrow(path, parentRecord, `the openhands task file ${path}`);
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);

  return { path, finalize };
}
