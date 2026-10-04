/**
 * A private HOME for hermetic OpenCode runs.
 *
 * OpenCode reads the operator's customizations through paths derived from the
 * account home and the XDG variables: the global config, the global AGENTS.md,
 * agents, commands, modes and skills under XDG_CONFIG_HOME/opencode
 * (packages/core/src/global.ts), the legacy ~/.opencode directory that stays
 * in the search list, and the ~/.claude and ~/.agents trees. Project files
 * (AGENTS.md, CLAUDE.md, opencode.json, .opencode directories) come from the
 * working directory. No flag turns all of that off, but every path derives
 * from $HOME or XDG_*, so a hermetic run points those at a fresh directory
 * and closes the two remaining channels with flags in the adapter.
 *
 * The login is the one thing that must survive: OpenCode keeps auth.json in
 * the data directory (XDG_DATA_HOME/opencode/auth.json, packages/opencode/
 * src/auth/index.ts) and rewrites that file in place, so the run keeps the
 * REAL data directory through an explicit XDG_DATA_HOME and the operator's
 * login with it -- no link, and a token rotation reaches the real file.
 * Keeping the login real keeps its configuration channels real too, so a
 * hermetic run inspects the login state before the launch and refuses a
 * login that carries remote configuration (opencode-remote-config.ts).
 *
 * The private home lives inside the real data directory
 * (`~/.local/share/opencode/.codemux-hermetic/`), which scode treats as
 * harness state on every platform, never under the temp root (the Linux
 * sandbox mounts a fresh /tmp that would hide it). Unlike the Codex home it
 * holds no login, so a codemux that dies between creating it and launching
 * the run leaves only an empty directory behind; the sweep below removes it
 * on a later run. While a run is in flight the process runner owns signals;
 * the module's own `process.once("exit", …)` finalizer below is the
 * codemux-died-anyway backstop (run-exit-cleanup.ts calls the same
 * idempotent finalize through the context, so the two agree).
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface OpencodeHermeticHome {
  /** The private HOME, also the root of the redirected XDG directories. */
  home: string;
  /** Removes the home. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux-hermetic";
const RUN_PREFIX = "run-";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler may leave an OpenCode child
// running in its home for as long as a run is allowed to last; a home is
// swept only once it is older than the longest run plus a margin.
const STALE_HOME_MS = 2 * 86_400_000;

/** Removes homes left behind by codemux processes that no longer exist. */
function sweepStaleHomes(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^run-(\d+)-/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    const path = join(parent, entry);
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (age < STALE_HOME_MS) continue;
    // One bad entry must not block the run, or every later run: the entry
    // stays, the sweep moves on, and the operator learns why (an entry the
    // sweep cannot remove is never cleaned up by retrying it either). The
    // h4 hardening missed this sweep — the sixth — so an unremovable home
    // still failed every later OpenCode hermetic launch until the h6
    // review caught it.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.error(`opencode: could not remove the stale hermetic home ${path}${detail}`);
    }
  }
}

/**
 * Creates the private home. `realDataDir` is the real OpenCode data
 * directory (the one holding auth.json); the home is created beside it,
 * under `.codemux-hermetic/`.
 */
export function createOpencodeHermeticHome(
  realDataDir: string
): OpencodeHermeticHome {
  const parent = join(realDataDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the data directory could have replaced the
  // parent with a symlink, pointing the sweep's rm elsewhere.
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid())
  ) {
    throw new Error(`${parent} must be a directory owned by the current user`);
  }
  sweepStaleHomes(parent);
  const home = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    rmSync(home, { recursive: true, force: true });
    process.off("exit", finalize);
  };
  process.once("exit", finalize);

  return { home, finalize };
}
