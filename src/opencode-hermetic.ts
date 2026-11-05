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
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pidProbeAlive } from "./process-table.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";

export interface OpencodeHermeticHome {
  /** The private HOME, also the root of the redirected XDG directories. */
  home: string;
  /** Removes the home. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux-hermetic";
const RUN_PREFIX = "run-";

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
    if (pid === process.pid || pidProbeAlive(pid)) continue;
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

/** The one byte of operator state a hermetic run keeps: OpenCode reads its
 * default model from `model.json` in the state directory when neither a
 * flag nor a config names one, and a private state directory without it
 * made a hermetic run fall to the provider's first model — one the
 * subscription did not include (live gate, 2026-11-02). The file is a
 * model preference, not an instruction, skill, or hook, so carrying it
 * keeps a hermetic run on the model a plain run uses. Copied only when it
 * is a regular file owned by this user, at most 64 KiB, and valid JSON;
 * anything else is left behind with the reason returned. Null means
 * copied; undefined means there was nothing to copy. */
export function carryOpencodeModelState(
  realStateDir: string,
  home: string
): string | null | undefined {
  const source = join(realStateDir, "model.json");
  // One descriptor, opened without following links, judged by fstat and
  // read through the same descriptor: a path swapped between the check and
  // the read cannot substitute another file (round 28, edges 5).
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK") return `${source} is not a regular file`;
    return `${source} could not be opened: ${code ?? String(error)}`;
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return `${source} is not a regular file`;
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid()
    ) {
      return `${source} is not owned by the current user`;
    }
    if (stat.size > MODEL_STATE_MAX_BYTES) return `${source} is larger than ${MODEL_STATE_MAX_BYTES} bytes`;
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
      return `${source} is writable by other accounts (mode ${(stat.mode & 0o777).toString(8)})`;
    }
    try {
      // Read exactly the judged size through the same descriptor: a file
      // grown after the fstat is refused, not copied past the bound
      // (round 35, edges 4).
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
        // EOF before the judged size: the file shrank under the copy (an
        // OpenCode rewrite); a shorter document is never accepted (round 56).
        if (read === 0) return `${source} shrank below its judged size while being read`;
        offset += read;
      }
      const probe = Buffer.alloc(1);
      if (readSync(fd, probe, 0, 1, buffer.length) !== 0) return `${source} grew past its judged size while being read`;
      text = buffer.toString("utf8", 0, offset);
      JSON.parse(text);
    } catch (error) {
      return `${source} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    closeSync(fd);
  }
  const target = join(home, ".local", "state", "opencode");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "model.json"), text, { mode: 0o600, flag: "wx" });
  return null;
}

const MODEL_STATE_MAX_BYTES = 64 * 1024;

/**
 * Creates the private home. `realDataDir` is the real OpenCode data
 * directory (the one holding auth.json); the home is created beside it,
 * under `.codemux-hermetic/`.
 */
export function createOpencodeHermeticHome(
  realDataDir: string,
  realStateDir?: string
): OpencodeHermeticHome {
  const parent = join(realDataDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the data directory could have replaced the
  // parent with a symlink, pointing the sweep's rm elsewhere; the record
  // also lets the finalizer revalidate the parent (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  sweepStaleHomes(parent);
  const home = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));

  // Cleanup is registered before anything else touches the home: a copy
  // below that throws (disk full, a permission change) must not leave the
  // directory behind (review round 22, edges 3).
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // Thrown when refused or failed, so the run's cleanup reports the kept
    // directory; it stays retryable, and the exit hook retries and reports
    // (review round 97).
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private opencode home ${home}`);
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);
  if (realStateDir !== undefined) {
    let skipped: string | null | undefined;
    try {
      skipped = carryOpencodeModelState(realStateDir, home);
    } catch (error) {
      finalize();
      throw error;
    }
    if (typeof skipped === "string") {
      console.error(`Warning: hermetic opencode run keeps no model preference: ${skipped}`);
    }
  }

  return { home, finalize };
}
