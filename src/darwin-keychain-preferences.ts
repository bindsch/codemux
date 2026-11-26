// A home's Library/Preferences/com.apple.security.plist can record a
// default keychain and a login keychain. macOS reads element zero of the
// `DefaultKeychain` array and uses that keychain without checking that the
// file exists; with no usable default record it reads `LoginKeychain` the
// same way. A store then goes to a missing keychain, however the Keychains
// directory is linked. Measured with SecKeychainCopyDefault (query only):
// - a file macOS cannot parse, and a value that is not an array, are
//   ignored, and the login keychain is used;
// - an empty `DefaultKeychain` array means no default keychain (-25307);
// - a `LoginKeychain` record naming a missing file means no default
//   keychain (-25307) although login.keychain-db exists;
// - a first element that is not a dictionary with a string `DbName` falls
//   back to the login keychain. That fallback is undocumented, so codemux
//   does not rely on it and treats the record as unusable.
// A recorded `login.keychain` (the old name) stands for `login.keychain-db`.
// scode 0.6.11 applies the same rules before it grants the login store
// (recorded_keychain_from_preferences).
//
// The file is read with /usr/bin/plutil, a fixed macOS tool that prints
// property-list values. Nothing here opens a keychain.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const PLUTIL = "/usr/bin/plutil";

export type KeychainRecordKey = "DefaultKeychain" | "LoginKeychain";
const RECORD_KEYS: readonly KeychainRecordKey[] = ["DefaultKeychain", "LoginKeychain"];
const LABEL: Record<KeychainRecordKey, string> = { DefaultKeychain: "default", LoginKeychain: "login" };

/** What a home's preference file says under one key.
 * `unreadable`: the file exists but cannot be read or classified.
 * `unusable`: an array whose first element names no usable keychain. */
export type RecordedKeychain =
  | { kind: "none" }
  | { kind: "unreadable"; file: string }
  | { kind: "unusable"; file: string }
  | { kind: "recorded"; file: string; path: string; exists: boolean };
export type RecordedDefaultKeychain = RecordedKeychain;

/** Through links. A path under a file (ENOTDIR) or an unreadable one is not a file. */
function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function readable(path: string): boolean {
  try { accessSync(path, constants.R_OK); return true; } catch { return false; }
}

/** The tool could not be run to an exit status: not started, or ended by a
 * signal. That is not an answer about the file. */
class PlutilDidNotRun extends Error {}

/** One plutil call; its output without the one newline plutil adds, or
 * null when it exits non-zero. Nothing else is trimmed: a recorded name is
 * validated exactly as recorded. */
function plutil(tool: string, args: string[], input?: string): string | null {
  const result = spawnSync(tool, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
  if (result.error !== undefined || result.status === null) throw new PlutilDidNotRun();
  return result.status === 0 ? (result.stdout ?? "").replace(/\n$/, "") : null;
}

/** Whether this plutil answers `-type` queries (macOS 12 and later),
 * asked about a known document. */
function classifies(tool: string): boolean {
  return plutil(tool, ["-type", "k", "-"], '<plist version="1.0"><dict><key>k</key><array/></dict></plist>') === "array";
}

// A control character, a trailing newline included, names another file.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Read the keychain recorded under `key` in `<home>/<relative>`. A regular
 * file is read, also through a link (codemux links the account's file
 * there, and macOS reads through it).
 *
 * - A missing entry, a directory, an empty file, a file plutil cannot
 *   parse, and a value that is absent or not an array record none.
 * - A file that cannot be read, or a plutil without `-type`, is
 *   `unreadable`: an unread record is not "nothing recorded".
 * - An array whose element zero is not a dictionary with a non-empty
 *   string `DbName`, or whose name has a control character or is neither
 *   absolute nor `~/`-relative, is `unusable`.
 * - Otherwise the name is recorded. A leading `~/` is relative to `home`,
 *   the HOME the child runs with, and a name ending in `.keychain` whose
 *   file is missing stands for its `-db` sibling.
 *
 * Without plutil nothing is read. `file` names another file to read with
 * the same `home` (the account's file, before it is linked into the home).
 */
export function recordedKeychain(home: string, relative: string, key: KeychainRecordKey, tool = PLUTIL, file = join(home, relative)): RecordedKeychain {
  try { return readRecordedKeychain(home, key, tool, file); }
  catch (error) {
    // A failed run of the tool leaves the record unread, which is not
    // "nothing recorded".
    if (error instanceof PlutilDidNotRun) return { kind: "unreadable", file };
    throw error;
  }
}

function readRecordedKeychain(home: string, key: KeychainRecordKey, tool: string, file: string): RecordedKeychain {
  // plutil is part of macOS. A host without it is one that only simulates
  // the platform (the suite on Linux): it has no keychain and no dialog,
  // and nothing is read there.
  if (!isFile(file) || !isFile(tool)) return { kind: "none" };
  if (!readable(file)) return { kind: "unreadable", file };
  if (statSync(file).size === 0) return { kind: "none" };
  if (plutil(tool, ["-lint", file]) === null) return { kind: "none" };
  if (!classifies(tool)) return { kind: "unreadable", file };
  if (plutil(tool, ["-type", key, file]) !== "array") return { kind: "none" };
  const named = plutil(tool, ["-type", `${key}.0`, file]) === "dictionary" &&
    plutil(tool, ["-type", `${key}.0.DbName`, file]) === "string";
  const recorded = named ? plutil(tool, ["-extract", `${key}.0.DbName`, "raw", "-o", "-", file]) : null;
  if (recorded === null || recorded === "" || CONTROL.test(recorded)) return { kind: "unusable", file };
  if (!recorded.startsWith("~/") && !isAbsolute(recorded)) return { kind: "unusable", file };
  // A `..` segment would be folded away here and walked by macOS: the two
  // can name different files, so such a record is not judged at all.
  if (recorded.split("/").includes("..")) return { kind: "unusable", file };
  const path = expandRecordedKeychain(home, recorded, isFile);
  return { kind: "recorded", file, path, exists: isFile(path) };
}

export function recordedDefaultKeychain(home: string, relative: string, tool = PLUTIL, file?: string): RecordedKeychain {
  return recordedKeychain(home, relative, "DefaultKeychain", tool, file);
}

/** Why the preference file leaves a process with this HOME without a
 * usable default keychain, or null. Both records are held to the same
 * rule; a valid default record does not excuse a broken login record.
 * `recorded` tells whether either key names an existing keychain. */
export function keychainRecordState(home: string, relative: string, tool = PLUTIL, file?: string): { problem: string | null; recorded: boolean } {
  let recorded = false;
  for (const key of RECORD_KEYS) {
    const seen = recordedKeychain(home, relative, key, tool, file);
    if (seen.kind === "unreadable") return { problem: `the preference file cannot be checked: ${seen.file}`, recorded };
    if (seen.kind === "unusable") return { problem: `the preference file records no ${LABEL[key]} keychain: ${seen.file}`, recorded };
    if (seen.kind === "recorded") {
      if (!seen.exists) {
        return { problem: `the recorded ${LABEL[key]} keychain does not exist: ${seen.path} (recorded in the keychain preference file ${seen.file})`, recorded };
      }
      recorded = true;
    }
  }
  return { problem: null, recorded };
}

/** The path a recorded name stands for: a leading `~/` is read against
 * `home`, and a name ending in `.keychain` whose file is missing stands
 * for its `-db` sibling. The caller has refused relative names. */
export function expandRecordedKeychain(home: string, recorded: string, exists: (path: string) => boolean): string {
  const path = recorded.startsWith("~/") ? join(home, recorded.slice(2)) : recorded;
  return !exists(path) && path.endsWith(".keychain") ? `${path}-db` : path;
}
