// The private probe-home bookkeeping the agy adapter's lifecycle uses: a
// home is created only together with its descriptor-verified identity, and
// removed only after that identity is reconfirmed on disk. Extracted from
// adapters/agy.ts (file-size round) without behavior change; the adapter
// keeps the Keychain, token-copy, and share-state passes that surround it.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readFileBytesBounded } from "../file-io.js";
import { PROBE_FILE_MAX_BYTES, PROBE_MARKER, findDirectory, markAgyPrivateHome, sameDirectory } from "./agy-homes.js";
import { AGY_MIRROR_PATH } from "../agy-keychain.js";
import type { RunContext } from "./base.js";

export interface OwnedAgyProbeHome {
  home: string; parent: string; parentDev: number; parentIno: number; homeDev: number; homeIno: number;
  marker: string; parentFd: number; homeFd: number; finished?: boolean; cleanupError?: Error; removalStarted?: boolean;
}

/** One context owns at most one home; the map is the only ownership record. */
export const ownedProbeHomes = new WeakMap<RunContext, OwnedAgyProbeHome>();

export const PROBE_TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";

/** Creates the probe root's next home and registers it as `context`'s own.
 * Throws with every descriptor it opened already closed and the home
 * removed when any step fails, so a failed creation leaves nothing behind
 * (the adapter's catch then has no home to clean). */
export function createAgyProbeHome(context: RunContext, realHome: string): OwnedAgyProbeHome {
  if (!isAbsolute(realHome)) throw new Error("agy probe HOME must be absolute");
  let root = join(realHome, ".gemini", ".codemux-isolation-probes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error("agy probe home root cannot be a symlink");
  root = realpathSync(root);
  const parentFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let parentStat;
  try { parentStat = fstatSync(parentFd); }
  catch (error) { closeSync(parentFd); throw error; }
  let home: string;
  try { home = mkdtempSync(join(root, "run-")); }
  catch (error) { closeSync(parentFd); throw error; }
  let homeFd: number | undefined;
  try {
    homeFd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const homeStat = fstatSync(homeFd);
    const marker = markAgyPrivateHome(home);
    const owned: OwnedAgyProbeHome = { home, parent: root, parentDev: parentStat.dev, parentIno: parentStat.ino,
      homeDev: homeStat.dev, homeIno: homeStat.ino, marker, parentFd, homeFd };
    ownedProbeHomes.set(context, owned);
    context.agyProbe!.home = home;
    return owned;
  } catch (error) {
    try { rmSync(home, { recursive: true }); }
    finally {
      try { if (homeFd !== undefined) closeSync(homeFd); }
      finally { closeSync(parentFd); }
    }
    throw error;
  }
}

/** Validates and removes an owned home. `searchError` carries a Keychain
 * search-list repair failure: reported with the removal's own error, or
 * thrown alone when the removal itself succeeded. False only once nothing
 * a retry could remove is left; every other failure keeps the descriptors
 * so the next call revalidates and removes again (review round 137). */
export function removeAgyProbeHome(owned: OwnedAgyProbeHome, searchError: unknown, atExit: boolean): void {
  let homePath = owned.home;
  let retryable = true;
  let succeeded = false;
  try {
    const parent = fstatSync(owned.parentFd);
    const home = fstatSync(owned.homeFd);
    if (!parent.isDirectory() || parent.dev !== owned.parentDev || parent.ino !== owned.parentIno ||
        !home.isDirectory() || home.dev !== owned.homeDev || home.ino !== owned.homeIno) {
      throw new Error("refusing cleanup of a replaced agy probe home or parent");
    }
    let parentPath = owned.parent;
    if (!lstatSync(parentPath, { throwIfNoEntry: false })) {
      parentPath = findDirectory(dirname(parentPath), parent) ?? "";
    }
    if (!parentPath || !sameDirectory(parentPath, parent) || realpathSync(parentPath) !== parentPath) {
      throw new Error("refusing cleanup of a replaced agy probe parent or one that cannot be found");
    }
    if (!lstatSync(owned.home, { throwIfNoEntry: false })) {
      homePath = findDirectory(parentPath, home) ?? "";
      // Not found under its parent: a retry has nothing to remove. Still
      // reported below, because a moved-away home may hold the token copy
      // (review round 144).
      if (!homePath) retryable = false;
    }
    if (!homePath || !sameDirectory(homePath, home)) {
      throw new Error("refusing cleanup of a replaced agy probe home or one that cannot be found");
    }
    // A removal that failed halfway may have deleted the marker already,
    // and the retry accepts its absence: the descriptor checks above still
    // prove this is the directory the run created. A marker that is
    // present must read as this run's, once, bounded, without following a
    // link (review rounds 143 and 199); decoded with nothing stripped, so
    // a byte-order mark still differs (review round 204).
    const markerPath = join(homePath, PROBE_MARKER);
    let markerText: string | null;
    try {
      markerText = readFileBytesBounded(markerPath, {
        maxBytes: PROBE_FILE_MAX_BYTES,
        label: "agy probe marker",
        noFollow: true,
      }).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("refusing cleanup of a replaced agy probe home or parent");
      }
      markerText = null;
    }
    if (markerText === null ? owned.removalStarted !== true : markerText !== owned.marker) {
      throw new Error("refusing cleanup of a replaced agy probe home or parent");
    }
    owned.removalStarted = true;
    rmSync(homePath, { recursive: true });
    retryable = false;
    if (searchError) throw searchError;
    succeeded = true;
  } catch (error) {
    const remaining = homePath || owned.home;
    owned.cleanupError = new Error(`agy probe cleanup failed: ${error instanceof Error ? error.message : String(error)}; ` +
      (searchError && error !== searchError ? `${String(searchError)}; ` : "") +
      `token copy may remain at ${join(remaining, PROBE_TOKEN)} or keychain mirror at ${join(remaining, AGY_MIRROR_PATH)} ` +
      `(home device ${owned.homeDev}, inode ${owned.homeIno})`);
    throw owned.cleanupError;
  } finally {
    if (succeeded) owned.cleanupError = undefined; // an earlier attempt's report no longer applies
    if (!retryable) owned.finished = true;
    if (!retryable || atExit) {
      try { closeSync(owned.homeFd); }
      finally { closeSync(owned.parentFd); }
    }
  }
}
