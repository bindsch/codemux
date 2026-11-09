/**
 * The clean-working-directory rule the hermetic adapters share (agy's rule,
 * src/adapters/agy.ts validateRunRequest, written once for the parity lanes):
 * a hermetic run may not launch from a tree that carries an instruction or
 * configuration file the harness would load from the working directory, so
 * the named files are refused — walking from the run's own directory up to
 * the git root — before the launch, as a usage error naming the offending
 * path. A dangling symlink counts (lstat, not exists): the harness resolves
 * it, so the run must refuse it.
 */

import { dirname, join } from "node:path";
import { existsSync, lstatSync, type Stats } from "node:fs";
import { UsageRefusalError } from "./validation.js";

export interface CleanCwdHost {
  lstatSync: (path: string, options: { throwIfNoEntry: false }) => Stats | undefined;
  existsSync: (path: string) => boolean;
  dirname: (path: string) => string;
}

/** The real filesystem; injectable so tests can plant a tree. */
export const cleanCwdHost: CleanCwdHost = {
  lstatSync: (path, options) => lstatSync(path, options),
  existsSync,
  dirname,
};

/**
 * Refuses when any named file exists between `start` and the git root
 * (inclusive). The walk stops at the first `.git` directory or file — the
 * project root — or at the filesystem root when no repository encloses the
 * run. Every name is checked per directory, so a file anywhere in the walk
 * is caught, not only in the starting directory.
 */
export function assertCleanInstructionFiles(
  agent: string,
  start: string,
  names: readonly string[],
  host: CleanCwdHost = cleanCwdHost,
  /** The flag that imposes the rule, named in the refusal. */
  flag = "--hermetic"
): void {
  let directory = start;
  for (;;) {
    for (const name of names) {
      const path = join(directory, name);
      if (host.lstatSync(path, { throwIfNoEntry: false })) {
        throw new UsageRefusalError(
          `${agent} ${flag} requires a clean working directory owned by this run; offending path: ${path}`
        );
      }
    }
    if (host.existsSync(join(directory, ".git")) || host.dirname(directory) === directory) break;
    directory = host.dirname(directory);
  }
}
