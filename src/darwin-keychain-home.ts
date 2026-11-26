// macOS resolves a process's default keychain under its HOME:
// $HOME/Library/Keychains/login.keychain-db. A process whose HOME is a
// private directory has no default keychain (SecKeychainCopyDefault
// returns -25307), and when it stores a keychain item macOS shows the
// dialog 'A keychain cannot be found to store "<name>"' on the user's
// screen. Every private home codemux gives a child therefore links the
// account's keychain directory, and every spawn of a child checks it again.
//
// Nothing here opens, reads or writes a keychain. The code creates
// directories and symbolic links, replaces an empty Library/Keychains
// directory by the link, checks that paths exist, and reads the keychain
// preference file with /usr/bin/plutil (darwin-keychain-preferences.ts).
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountHome } from "./account-home.js";
import { readChild } from "./child-homes.js";
export { childHomes } from "./child-homes.js";
import { keychainRecordState } from "./darwin-keychain-preferences.js";
import { UsageRefusalError } from "./validation.js";

export const KEYCHAIN_DIRECTORY = "Library/Keychains";
export const LOGIN_KEYCHAIN = "login.keychain-db";
export const SECURITY_PREFERENCES = "Library/Preferences/com.apple.security.plist";

export interface KeychainHomeOptions {
  /** The platform to act for; the host's by default. */
  platform?: NodeJS.Platform;
  /** The account home from the password database; looked up by default.
   * Null means it could not be established. */
  accountHome?: string | null;
  /** The property-list tool; /usr/bin/plutil by default. */
  plutil?: string;
}

/** What `linkAccountKeychain` found or did. */
export type KeychainLinkResult =
  | "not-darwin"
  | "account-home"
  | "no-account-keychain"
  | "resolves"
  | "linked";

function refuse(home: string, reason: string): never {
  throw new UsageRefusalError(
    `cannot start a child process with HOME=${home}: ${reason}. ` +
    "macOS finds no default keychain under that HOME and would show the dialog " +
    "'A keychain cannot be found to store ...' when the child stores a keychain item. " +
    `Remove, rename or correct the entry, or use another home; codemux links ${KEYCHAIN_DIRECTORY} to the account's keychain directory when it is absent`);
}

function sameDirectory(left: string, right: string): boolean {
  if (left === right) return true;
  // The file system decides, not the spelling: `/home/missing/..` is not
  // `/home` to a process that walks the path, and it resolves nothing.
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

/** Whether a login keychain is reachable through `<home>/Library/Keychains`:
 * a regular file, also through links. A directory, FIFO or socket of that
 * name is not a keychain database. */
export function keychainResolves(home: string): boolean {
  try { return statSync(join(home, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN)).isFile(); } catch { return false; }
}

/** The refusal text for a preference file that records a missing keychain,
 * or null. The wording follows scode 0.6.11. */
function missingRecord(home: string, options: KeychainHomeOptions): string | null {
  return keychainRecordState(home, SECURITY_PREFERENCES, options.plutil).problem;
}

/** Whether a process with this HOME has a default keychain, by a rule at
 * least as strict as the one macOS applies: every keychain its preference
 * file records under `DefaultKeychain` or `LoginKeychain` exists, and when
 * it records none, `login.keychain-db` does. */
export function defaultKeychainResolves(home: string, options: KeychainHomeOptions = {}): boolean {
  const state = keychainRecordState(home, SECURITY_PREFERENCES, options.plutil);
  return state.problem === null && (state.recorded || keychainResolves(home));
}

/** `<home>/Library` as the home's own directory. A link there is never
 * followed: the keychain link would be created outside the home. */
function ensureLibrary(home: string): void {
  const library = join(home, "Library");
  if (lstatSync(library, { throwIfNoEntry: false }) === undefined) {
    try {
      // Each missing directory is made in turn and given its mode outright:
      // under a umask that strips the owner's write bit, a recursive mkdir
      // would make a parent the next level cannot be created in.
      const missing: string[] = [];
      for (let path = library; lstatSync(path, { throwIfNoEntry: false }) === undefined; path = dirname(path)) {
        missing.unshift(path);
        if (dirname(path) === path) break;
      }
      for (const path of missing) {
        // Another launch preparing the same home may have made it meanwhile.
        try { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
    } catch (error) { refuse(home, `${library} cannot be created (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  }
  const entry = lstatSync(library);
  if (!entry.isDirectory()) {
    refuse(home, `${library} is a ${entry.isSymbolicLink() ? "symbolic link" : "file"} and no default keychain resolves through it`);
  }
}

function sameTarget(link: string, directory: string): boolean {
  try { return realpathSync(link) === realpathSync(directory); } catch { return false; }
}

/** Put the link to `source` at `<home>/Library/Keychains`: in place of a
 * missing entry or an empty directory. Another process may create or
 * remove the entry between two steps; each pass re-reads it. */
function linkKeychainDirectory(home: string, source: string, resolved: () => boolean, record: () => string | null): void {
  const target = join(home, KEYCHAIN_DIRECTORY);
  let removed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (resolved()) return; // also when another process linked it meanwhile
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry === undefined) {
      try { symlinkSync(source, target); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // Put back the empty directory this call removed: a refused
          // launch leaves the home as it was found.
          if (removed) { try { mkdirSync(target, { mode: 0o700 }); } catch { /* reported below */ } }
          refuse(home, `the link ${target} cannot be created (${code ?? "error"})`);
        }
      }
      continue;
    }
    if (!entry.isDirectory()) {
      // The link to the account's directory is in place; the caller judges the result.
      if (resolved() || (entry.isSymbolicLink() && sameTarget(target, source))) return;
      refuse(home, `${target} is a ${entry.isSymbolicLink() ? "symbolic link" : "file"} through which no login keychain resolves`);
    }
    try { rmdirSync(target); removed = true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT: another process removed the empty directory. ENOTDIR: it
      // already replaced the directory with the link. The next pass decides.
      // A directory that holds a login keychain is here only because the
      // home's preference file records another, missing one: say that.
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        refuse(home, (keychainResolves(home) ? record() : null) ?? `${target} is a directory with its own content and no ${LOGIN_KEYCHAIN}`);
      }
    }
  }
  refuse(home, `${target} kept changing while it was being linked`);
}

/** Link the account's preference file, which can record the default
 * keychain, when the home has none. It is linked only if what it records
 * exists as seen from this home (a `~/` path is read against the child's
 * HOME); otherwise the reason is returned and the caller refuses. Any
 * other failure leaves the home as it was; the caller checks the result. */
function linkSecurityPreferences(home: string, account: string, options: KeychainHomeOptions): string | null {
  const source = join(account, SECURITY_PREFERENCES);
  const target = join(home, SECURITY_PREFERENCES);
  try {
    if (!existsSync(source) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) return null;
    // What the account's file records must exist as seen from this home.
    // If it does not, the file cannot be shared, and without it the child
    // would use another default keychain than the account's: the caller
    // refuses instead.
    const unshared = keychainRecordState(home, SECURITY_PREFERENCES, options.plutil, source).problem;
    if (unshared !== null) return unshared;
    if (!lstatSync(join(home, "Library")).isDirectory()) return null;
    const preferences = join(home, "Library", "Preferences");
    if (lstatSync(preferences, { throwIfNoEntry: false }) === undefined) {
      // Another launch preparing the same home may make it at the same time.
      try { mkdirSync(preferences, { mode: 0o700 }); chmodSync(preferences, 0o700); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (lstatSync(preferences).isDirectory()) {
      try { symlinkSync(source, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  } catch {
    // The home does not allow it; the check below decides what that means.
  }
  // A file that records a keychain and could not be linked leaves the
  // child with another default than the account's.
  if (lstatSync(target, { throwIfNoEntry: false }) === undefined &&
      keychainRecordState(account, SECURITY_PREFERENCES, options.plutil).recorded) {
    return `it could not be linked at ${target}`;
  }
  return null;
}

/**
 * Make a private home resolve a default keychain as the account home does.
 *
 * Does nothing off macOS, when `home` is the account home, and when the
 * account itself resolves no default keychain (a private home is then no
 * worse than the real one). A home that already resolves one is kept. In
 * any other home a missing `Library/Keychains` entry becomes a symbolic
 * link to the account's keychain directory, an empty directory is
 * replaced by that link, and the account's preference file is linked when
 * the home has none. A home that still resolves no default keychain is a
 * refusal, so the caller stops instead of starting a child that can raise
 * the dialog. Safe to call repeatedly and from several processes.
 */
export function linkAccountKeychain(given: string, options: KeychainHomeOptions = {}): KeychainLinkResult {
  if ((options.platform ?? process.platform) !== "darwin") return "not-darwin";
  // A HOME spelled through `..` is what the file system makes of it, not
  // what the spelling collapses to: `/home/missing/..` is no directory to
  // the child, and `link/..` is the parent of the link's target. Every
  // check below works on the path a process would reach.
  let home = given;
  if (home.split("/").includes("..")) {
    // The native call walks the path as the kernel does; the JavaScript
    // one collapses `..` by spelling first.
    try { home = realpathSync.native(home); }
    catch { refuse(home, "HOME is spelled through `..` and names no existing directory"); }
  }
  const resolves = (directory: string): boolean => defaultKeychainResolves(directory, options);
  const account = options.accountHome === undefined ? accountHome() : options.accountHome;
  if (account === null) {
    // Without the account home nothing can be linked or compared. A HOME
    // that resolves a default keychain by itself is still fine; any other
    // one stops here: an error is acceptable, the dialog is not.
    // A Library that is a link is refused here as on the main path.
    if (home !== "" && lstatSync(join(home, "Library"), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      refuse(home, `${join(home, "Library")} is a symbolic link, and a home's Library must be its own directory`);
    }
    if (home !== "" && resolves(home)) return "resolves";
    refuse(home, (home === "" ? null : missingRecord(home, options)) ??
      "the account home cannot be read from the directory service, so the account's keychain directory cannot be linked, " +
      `and no ${LOGIN_KEYCHAIN} resolves under this HOME`);
  }
  // The account home itself is never judged or changed: macOS decides what
  // resolves there, and a refusal would stop every ordinary launch.
  if (home !== "" && sameDirectory(home, account)) return "account-home";
  // A Library that is a link leads outside the home whatever resolves
  // through it; it is refused before anything is judged by its content.
  const library = join(home, "Library");
  if (home !== "" && lstatSync(library, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    refuse(home, `${library} is a symbolic link, and a home's Library must be its own directory`);
  }
  // A home with a default keychain of its own, not the account's directory,
  // needs nothing from the account: the state of the account's preference
  // file does not concern it.
  if (home !== "" && resolves(home) && !sameTarget(join(home, KEYCHAIN_DIRECTORY), join(account, KEYCHAIN_DIRECTORY))) {
    return "resolves";
  }
  if (!resolves(account)) {
    // An account whose own preference file is broken or cannot be checked
    // is not an account without a keychain: its keychain may work under
    // the real HOME, and a private home left unlinked would show the
    // dialog. Only an account with nothing recorded and no login keychain
    // has nothing to link.
    const accountProblem = missingRecord(account, options);
    if (accountProblem !== null) refuse(home, `the account's own keychain preference file cannot be shared: ${accountProblem}`);
    return "no-account-keychain";
  }
  if (home === "") refuse(home, "HOME is empty, and macOS then reads no account home");
  let result: KeychainLinkResult = "resolves";
  const source = join(account, KEYCHAIN_DIRECTORY);
  if (!resolves(home)) {
    // A home that already resolves a keychain of its own is kept as it
    // is: neither link is added to it. A missing HOME is created here on
    // purpose (private and caller-owned homes are made on first use).
    ensureLibrary(home);
    if (existsSync(source)) linkKeychainDirectory(home, source, () => resolves(home), () => missingRecord(home, options));
    result = "linked";
  }
  // A home that uses the account's keychain directory must also see the
  // account's choice of default keychain. This is checked on every call,
  // not only when the directory link is made: a call that refused here
  // left that link in place, and the next call must refuse again.
  if (result === "linked" || sameTarget(join(home, KEYCHAIN_DIRECTORY), source)) {
    const unshared = linkSecurityPreferences(home, account, options);
    if (unshared !== null) {
      refuse(home, `the account's keychain preference file cannot be shared with this home: ${unshared}`);
    }
  }
  if (!resolves(home)) {
    refuse(home, missingRecord(home, options) ?? `no ${LOGIN_KEYCHAIN} resolves under ${join(home, KEYCHAIN_DIRECTORY)} and its preference file records no default keychain`);
  }
  return result;
}

const PRECHECK_WINDOW_MS = 2_000;
/** Launches whose homes were checked a moment ago, each waiting for its own
 * spawn. One entry answers one spawn: it is removed when used. */
const prechecked = new Map<string, number>();

/**
 * The same check, made by a launch before it re-verifies its executables.
 * It lets that launch's own spawn skip the check, so no file work sits
 * between the executable re-verification and the spawn. Only that spawn:
 * the entry names the exact argv, HOME values and directory, and is used
 * once. Every other spawn is checked in full.
 */
export function precheckChildKeychainHomes(
  command: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined, cwd?: string,
  options: KeychainHomeOptions = {}
): void {
  if ((options.platform ?? process.platform) !== "darwin") return;
  guardChildKeychainHomes(command, env, cwd, options);
  if (prechecked.size > 64) prechecked.clear();
  prechecked.set(precheckKey(command, env, cwd), Date.now());
}

function precheckKey(command: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined, cwd?: string): string {
  return JSON.stringify([command, (env ?? process.env).HOME ?? null, cwd ?? null]);
}

/** The launch-time check every guarded spawn runs: link the account
 * keychain into each HOME the child runs under, or refuse the launch. */
export function guardChildKeychainHomes(
  command: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined, cwd?: string,
  options: KeychainHomeOptions = {}, atSpawn = false
): void {
  if ((options.platform ?? process.platform) !== "darwin") return;
  // Only the spawn itself may be answered by its launch's precheck.
  if (atSpawn) {
    const key = precheckKey(command, env, cwd);
    const at = prechecked.get(key);
    if (at !== undefined) {
      prechecked.delete(key);
      if (Date.now() - at < PRECHECK_WINDOW_MS) return;
    }
  }
  // A spawn into a working directory that does not exist fails. Linking a
  // relative HOME under it first would create the directory.
  if (cwd !== undefined && statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new UsageRefusalError(`cannot start the command: its working directory does not exist: ${cwd}`);
  }
  const child = readChild(command, env, cwd);
  for (const directory of child.directories) {
    // env(1) fails in a directory that does not exist. Linking a HOME
    // under it would create the directory and turn that failure into a
    // launch somewhere the caller never made.
    if (lstatSync(directory, { throwIfNoEntry: false }) === undefined || !statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new UsageRefusalError(`cannot start the command: \`-C ${directory}\` names a directory that does not exist`);
    }
  }
  for (const home of child.homes) linkAccountKeychain(home, options);
}
