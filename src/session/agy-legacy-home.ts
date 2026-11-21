// Hermetic agy session homes written by codemux 2.0.1 to 2.0.3 held a
// private copy of the login: a copied regular token file (marker `token`),
// or a private `Library/Keychains/` directory with a codemux-made
// `login.keychain-db` mirror (marker `keychain`; on macOS every home got
// the directory, with an empty mirror on the other arms), plus the private
// security preference file that selected the mirror. This module replaces
// those copies with the native-login links a current home carries. Every
// file it removes is codemux's own, inside the private home; the operator's
// real login is never read, copied or changed.

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tryExclusiveFlock } from "../flock.js";
import { AGY_SESSION_HOME_PREFIX } from "../adapters/agy-homes.js";
import { AGY_FILE_TOKEN, AGY_NATIVE_PATHS, ensureAgyLinkParent, linkAgyLogin } from "../agy-auth.js";
import { UsageRefusalError } from "../validation.js";
import { sessionHoldState, sessionRegistryPath, type SessionHold } from "./registry.js";

export const AGY_LOGIN_MARKER = ".codemux-login";
/** 2.0.3's spellings of the arm a current home records as `native`. */
export const LEGACY_AGY_LOGIN_MARKERS: ReadonlySet<string> = new Set(["token", "keychain"]);

/** What a codemux mirror directory may hold: the mirror, the atomic-write
 * siblings the Keychain library leaves beside it, and its lock files. */
const MIRROR_FILE = /^(?:login\.keychain-db(?:\.sb-[A-Za-z0-9-]+)?|\.fl[0-9A-Fa-f]+)$/;

function regularFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Refuse when a component between `home` and `relative`'s last name
 * exists and is not a real directory. Creates nothing. */
function assertOwnDirectories(home: string, relative: string): void {
  let current = home;
  for (const part of dirname(relative).split(sep).filter((name) => name !== "" && name !== ".")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (!stat.isDirectory()) {
      throw new UsageRefusalError(`the resumed agy private home holds a symbolic link or a file at ${current} ` +
        "where it needs its own directory; codemux never follows or replaces it; start a new session");
    }
  }
}

/** The mirror files of a private Keychains directory, or a refusal when it
 * holds anything codemux did not put there. A link is not a directory: a
 * home that already carries the native link has nothing to remove. */
function mirrorFiles(directory: string): string[] | null {
  if (!(lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() ?? false)) return null;
  const names = readdirSync(directory);
  for (const name of names) {
    if (!MIRROR_FILE.test(name) || !regularFile(join(directory, name))) {
      throw new UsageRefusalError(
        `the resumed agy private home holds a file codemux did not create in ${directory}: ${name}; ` +
          "it cannot be moved to the native login; start a new session");
    }
  }
  return names;
}

/** The lock file a migration holds in the home it rewrites. It is never
 * unlinked: ownership is the kernel's flock on it, which ends with the
 * owner's descriptor, so a crashed migration leaves no stale lock. */
export const AGY_MIGRATION_LOCK = ".codemux-login.lock";
const MIGRATION_RETRY_MS = 25;

export interface LegacyAgyMigrationOptions {
  /** How long to wait for another process's migration of this home. Zero
   * gives up at once (the idle sweep); a resume waits. */
  waitMs?: number;
  /** Runs under the lock, before anything is removed (tests hold it open). */
  held?: () => void;
}

/**
 * Replace a 2.0.3 home's private login copies with the native-login links
 * and rewrite its marker to `native`. Idempotent: an interrupted pass keeps
 * the legacy marker and the next one finishes it. The directory check runs
 * before anything is removed, so a refusal leaves the home as it was.
 *
 * One process migrates a home at a time (review round 4): the idle sweep
 * of one codemux and a resume in another both reached this for the same
 * home, and the loser died on a raw ENOENT from a file the winner had
 * already removed. The loser now waits for the lock and finds the marker
 * already `native`; it answers false when the wait runs out.
 */
export function migrateLegacyAgyHome(dir: string, source: string, platform: NodeJS.Platform = process.platform,
  options: LegacyAgyMigrationOptions = {}): boolean {
  const lock = join(dir, AGY_MIGRATION_LOCK);
  let fd: number;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    // A link planted at the lock's name is never followed (O_NOFOLLOW).
    if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    throw new UsageRefusalError(`the agy private home's migration lock ${lock} is a symbolic link; ` +
      "codemux never follows or replaces it; remove it or start a new session");
  }
  try {
    const deadline = Date.now() + (options.waitMs ?? 0);
    while (!tryExclusiveFlock(fd)) {
      if (Date.now() >= deadline) return false;
      Bun.sleepSync(MIGRATION_RETRY_MS);
    }
    options.held?.();
    // Another process may have finished this home during the wait.
    if (LEGACY_AGY_LOGIN_MARKERS.has(readAgyLoginMarker(dir) ?? "")) migrateLockedLegacyAgyHome(dir, source, platform);
    return true;
  } finally { closeSync(fd); }
}

/** Whether `path` is the native link codemux itself makes for `relative`. */
function nativeLink(dir: string, source: string, relative: string): boolean {
  const path = join(dir, relative);
  return (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false) && readlinkSync(path) === join(source, relative);
}

function migrateLockedLegacyAgyHome(dir: string, source: string, platform: NodeJS.Platform): void {
  const keychains = join(dir, AGY_NATIVE_PATHS[0]);
  // The directories above the private Keychains directory must be the
  // home's own before it is listed: through a planted `Library` link the
  // listing, and a refusal quoting it, would name the operator's files.
  assertOwnDirectories(dir, AGY_NATIVE_PATHS[0]);
  const mirror = mirrorFiles(keychains);
  const token = join(dir, AGY_FILE_TOKEN);
  // The marker sits in a home its sandboxed child can write, so it alone
  // never starts a migration (review round 5). The 2.0.3 layout must be
  // there too: the copied token or the private Keychains directory. A pass
  // that was interrupted after removing them left the native links, which
  // lets the next pass finish.
  if (!regularFile(token) && mirror === null &&
      ![AGY_FILE_TOKEN, AGY_NATIVE_PATHS[0]].some((relative) => nativeLink(dir, source, relative))) {
    throw new UsageRefusalError(
      `the agy private home ${dir} is marked as holding a 2.0.x login copy but holds neither the copied token nor the private Keychains directory; ` +
      "the marker alone is not trusted; start a new session");
  }
  // Validate every link parent before removing anything: a refusal here
  // must leave the 2.0.3 layout in place so a later resume can retry.
  for (const relative of [...(platform === "darwin" ? AGY_NATIVE_PATHS : []), AGY_FILE_TOKEN]) {
    ensureAgyLinkParent(dir, relative);
  }
  if (regularFile(token)) unlinkSync(token);
  if (mirror !== null) {
    for (const name of mirror) unlinkSync(join(keychains, name));
    rmdirSync(keychains);
  }
  // The private preference file selected the mirror just removed.
  const preferences = join(dir, AGY_NATIVE_PATHS[1]);
  if (regularFile(preferences)) unlinkSync(preferences);
  linkAgyLogin(dir, source, platform);
  writeAgyLoginMarker(dir, "native");
}

/** Replace the marker through a staging file the child cannot aim: a
 * random name, created exclusively and never through a symlink, so a link
 * planted at a predictable staging name cannot make codemux write into
 * the file it points at (review round 5). The rename replaces the marker
 * entry itself, whatever it is. */
function writeAgyLoginMarker(dir: string, value: string): void {
  const marker = join(dir, AGY_LOGIN_MARKER);
  const staged = `${marker}.tmp-${randomBytes(12).toString("hex")}`;
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, value); } finally { closeSync(fd); }
    renameSync(staged, marker);
  } catch (error) {
    try { unlinkSync(staged); } catch { /* nothing staged */ }
    throw error;
  }
}

const MAX_MARKER_BYTES = 64;

/** The login marker a home carries, or null when it has none. The marker
 * is a small regular file: a symlink or any other entry at its name is
 * not read, so a link a child planted there selects nothing. */
export function readAgyLoginMarker(dir: string): string | null {
  let fd: number;
  try { fd = openSync(join(dir, AGY_LOGIN_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_MARKER_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, MAX_MARKER_BYTES, 0)).toString("utf8").trim();
  } catch { return null; }
  finally { closeSync(fd); }
}

/**
 * Move every settled 2.0.3 session home under `parent` that no live session
 * holds to the native login, so a copied login does not stay on disk until
 * its session is resumed or swept. Only a positive `free` registry answer
 * acts: a live or unreadable record leaves the home alone, and its own
 * resume migrates it. Best effort: a home that cannot be migrated is left
 * for that resume, which reports the reason.
 */
export function migrateIdleLegacyAgyHomes(
  parent: string, source: string, spareId?: string,
  holdStateOf: (id: string) => SessionHold = (id) => sessionHoldState(sessionRegistryPath(), id),
  platform: NodeJS.Platform = process.platform
): void {
  let names: string[];
  try { names = readdirSync(parent); }
  catch { return; }
  for (const name of names) {
    if (!name.startsWith(AGY_SESSION_HOME_PREFIX)) continue;
    const id = name.slice(AGY_SESSION_HOME_PREFIX.length);
    const dir = join(parent, name);
    try {
      if (id === spareId || !lstatSync(dir).isDirectory()) continue;
      if (!LEGACY_AGY_LOGIN_MARKERS.has(readAgyLoginMarker(dir) ?? "")) continue;
      if (holdStateOf(id) !== "free") continue;
      migrateLegacyAgyHome(dir, source, platform);
    } catch {
      // Left as it was; a resume of this session reports the reason.
    }
  }
}
