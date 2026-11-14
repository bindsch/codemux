import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { assertTrustedDirectory } from "../hermetic-home.js";
import { openSessionPrivateHome, type SessionPrivateHomeOpen } from "./private-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";

/** Codex 0.166/0.167's state database. Only codemux-owned, idle homes use
 * this repair: ordinary and caller-owned CODEX_HOME directories never do. */
const STATE_DATABASE = "state_5.sqlite";

function regularFile(path: string): boolean {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o002) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Codex relocation requires an owned, unlinked regular file: ${path}`);
  }
  return true;
}

/** Inside the private root, Codex inherits the caller's umask. Group
 * writes are harmless behind that root; links and world writes are not. */
function rolloutDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o002) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Codex relocation requires an owned directory that is not world-writable: ${path}`);
  }
}

/** Rebase the selected rollout, never discover a different one by scanning.
 * Paginated threads trust SQLite even when the old absolute path is gone.
 * Run after the child exits and the home moves, or under the resume claim
 * before spawning to recover homes settled by earlier codemux versions.
 * No native history, timestamps, or other metadata are changed. */
export function repairCodexHomeRollouts(codexHome: string): void {
  const nested = basename(codexHome) === ".codex";
  const home = nested ? dirname(codexHome) : codexHome;
  if (!/^session-(?:home-)?[A-Za-z0-9_-]+$/.test(basename(home))) {
    throw new Error(`Codex relocation requires a session-keyed home: ${home}`);
  }
  assertTrustedDirectory(dirname(home));
  assertTrustedDirectory(home);
  // A fake/older harness need not have made a database at all.
  try { rolloutDirectory(codexHome); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const path = join(codexHome, STATE_DATABASE);
  if (!regularFile(path)) return;
  for (const suffix of ["-wal", "-shm", "-journal"]) regularFile(path + suffix);
  const db = new Database(path, { readwrite: true, create: false });
  try {
    db.transaction(() => {
      const rows = db.query<{ id: string; rollout_path: string }, []>("SELECT id, rollout_path FROM threads").all();
      const update = db.query("UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?");
      for (const row of rows) {
        const fromParent = relative(dirname(home), row.rollout_path).split(sep);
        if (!/^run-\d+-[A-Za-z0-9_-]+$/.test(fromParent[0] ?? "")) continue;
        const tail = fromParent.slice(nested ? 2 : 1);
        if (nested && fromParent[1] !== ".codex") continue;
        if (tail[0] !== "sessions" && tail[0] !== "archived_sessions") continue;
        const target = join(codexHome, ...tail);
        // Refuse links at every component, including the selected rollout.
        let component = codexHome;
        for (const part of tail.slice(0, -1)) {
          component = join(component, part);
          rolloutDirectory(component);
        }
        // Native lookup accepts either the plain file or its .zst sibling.
        if (!regularFile(target) && !regularFile(target + ".zst")) {
          throw new Error(`Codex relocated rollout is missing: ${target}`);
        }
        update.run(target, row.id, row.rollout_path);
      }
    })();
  } finally { db.close(); }
}

/** Keep shared home ownership/cleanup intact; a failed repair must not
 * advertise a resumable home. Resume also repairs pre-fix settled homes. */
export function openCodexSessionPrivateHome(open: SessionPrivateHomeOpen): SessionPrivateHome {
  const home = openSessionPrivateHome(open);
  if (open.printOnly) return home;
  if (open.resume) repairCodexHomeRollouts(join(home.dir, ".codex"));
  let repaired = home.settled;
  return {
    get dir() { return home.dir; },
    get settled() { return home.settled && repaired; },
    resumed: home.resumed,
    blockedPaths: home.blockedPaths,
    remove: () => home.remove(),
    settle(id) {
      home.settle(id);
      repairCodexHomeRollouts(join(home.dir, ".codex"));
      repaired = true;
    },
  };
}
