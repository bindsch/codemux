import { defaultKeychainResolves, linkAccountKeychain } from "../darwin-keychain-home.js";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { AGY_SESSION_HOME_PREFIX, markAgyPrivateHome } from "../adapters/agy-homes.js";
import { AGY_FILE_TOKEN, AGY_NATIVE_PATHS, agyLoginPaths, ensureAgyLinkParent, linkAgyLogin, type AgyAuthOptions } from "../agy-auth.js";
import { UsageRefusalError } from "../validation.js";
import { AGY_LOGIN_MARKER, LEGACY_AGY_LOGIN_MARKERS, migrateLegacyAgyHome, readAgyLoginMarker } from "./agy-legacy-home.js";

export interface AgySessionHomeOptions extends AgyAuthOptions {
  cwd?: string;
  /** The platform whose native login paths apply; the host's by default. */
  platform?: NodeJS.Platform;
  /** How long a resume waits for another process's migration of its 2.0.3
   * home (agy-legacy-home.ts); ten seconds by default. */
  legacyMigrationWaitMs?: number;
  /** False for an unsandboxed session; the API-key arm then prints the
   * Keychain notice below. */
  sandboxed?: boolean;
}

export const AGY_KEYCHAIN_REACHABLE = "this unsandboxed agy session authenticates with an API key, and its private HOME links the account's " +
  "keychain directory (so that macOS shows no keychain dialog): the macOS Keychain is reachable, and codemux could not establish that agy " +
  "ignores a stored login when a key is set; run it sandboxed (the default), where the Keychain is denied; see docs/isolation.md.";

/** One line on stderr for an unsandboxed API-key agy session whose HOME
 * reaches the Keychain. Sandboxed, the launch carries --no-login-store and
 * scode 0.6.11 denies the keychain services, so nothing is printed. */
export function noticeAgyKeychainReachable(
  home: string, sandboxed: boolean | undefined, platform: NodeJS.Platform = process.platform,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): void {
  if (platform === "darwin" && sandboxed === false && defaultKeychainResolves(home)) write(`Info: ${AGY_KEYCHAIN_REACHABLE}`);
}
export type AgySessionLoginArm = "api-key" | "native";
export type AgySessionLoginSource = AgySessionLoginArm;
export type AgySessionResumeLogin = AgySessionLoginArm;
/** agy uses its own live store; no credential snapshot can become stale. */
export function populateAgySessionPrivateHome(
  dir: string, options: AgySessionHomeOptions
): AgySessionLoginSource {
  markAgyPrivateHome(dir);
  mkdirSync(join(dir, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
  const arm = usableKey(options) ? "api-key" : "native";
  // The login is linked only when it is in use: an API-key session gets no link.
  if (arm === "native") linkAgyLogin(dir, options.environment.HOME || homedir(), options.platform);
  // Both arms: the child's HOME must resolve a default keychain (darwin-keychain-home.ts).
  linkAccountKeychain(dir, { platform: options.platform });
  if (arm === "api-key") noticeAgyKeychainReachable(dir, options.sandboxed, options.platform);
  writeFileSync(join(dir, AGY_LOGIN_MARKER), arm, { flag: "wx", mode: 0o600 });
  return arm;
}

export function settledAgyHarnessHome(privateHomeDir: string, sessionId: string): string {
  return join(dirname(privateHomeDir), `${AGY_SESSION_HOME_PREFIX}${sessionId}`, ".gemini", "antigravity-cli");
}

function usableKey(options: AgySessionHomeOptions): boolean {
  return ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((name) =>
    Boolean(options.environment[name]?.trim()) &&
    (!options.scrubbing || (options.keepEnv?.includes(name) ?? false)));
}

/** Resume checks filesystem links only; native login status remains agy's.
 * A home written by 2.0.3 (marker `token` or `keychain`) carried private
 * login copies, not links: it is moved to the native links first
 * (agy-legacy-home.ts), then verified like any other home. A link the
 * operator's login gained since the last turn is added; a link that points
 * elsewhere, or a file in a link's place, refuses. */
export function verifyAgySessionPrivateHome(
  dir: string, options: AgySessionHomeOptions
): AgySessionResumeLogin {
  let marker = readAgyLoginMarker(dir);
  if (marker === null) throw new UsageRefusalError("the resumed agy private home carries no login marker; session state cannot be verified; start a new session");
  if (marker === "api-key" && usableKey(options)) {
    linkAccountKeychain(dir, { platform: options.platform }); // a home made before 2.0.7 has no link yet
    noticeAgyKeychainReachable(dir, options.sandboxed, options.platform);
    return "api-key";
  }
  const source = options.environment.HOME || homedir();
  const platform = options.platform ?? process.platform;
  if (LEGACY_AGY_LOGIN_MARKERS.has(marker)) {
    if (!migrateLegacyAgyHome(dir, source, platform, { waitMs: options.legacyMigrationWaitMs ?? 10_000 })) {
      throw new UsageRefusalError(`another codemux process is still moving the resumed agy private home ${dir} to the native login; retry the resume`);
    }
    marker = readAgyLoginMarker(dir) ?? "";
  }
  if (marker !== "native") {
    throw new UsageRefusalError("the resumed agy private home lacks its recorded authentication configuration; restore GEMINI_API_KEY or GOOGLE_API_KEY or start a new session");
  }
  const token = join(source, AGY_FILE_TOKEN);
  let removedEmpty: string | null = null;
  for (const path of [...agyLoginPaths(source, platform), ...(existsSync(token) ? [token] : [])]) {
    // relative(), not a slice: HOME may end in a separator.
    const rel = relative(source, path);
    const destination = join(dir, rel);
    // An empty Keychains directory left where the link was is replaced, as
    // at the first launch (linkAgyLogin). rmdir removes nothing else.
    if (rel === AGY_NATIVE_PATHS[0] && lstatSync(destination, { throwIfNoEntry: false })?.isDirectory() === true) {
      // The parents are checked first: a `Library` that became a link
      // would make this the removal of a directory outside the home.
      ensureAgyLinkParent(dir, rel);
      try { rmdirSync(destination); removedEmpty = destination; } catch { /* not empty: refused below */ }
    }
    if (lstatSync(destination, { throwIfNoEntry: false }) === undefined) {
      ensureAgyLinkParent(dir, rel);
      try { symlinkSync(path, destination); }
      catch (error) {
        // A refused resume leaves the home as it was: the empty directory
        // removed above is put back when the link cannot be made.
        if (removedEmpty === destination) { try { mkdirSync(destination, { mode: 0o700 }); } catch { /* reported by the throw below */ } }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new UsageRefusalError(`the resumed agy login link changed while it was being restored: ${destination}; start a new session`);
      }
      continue;
    }
    let target: string;
    try { target = readlinkSync(destination); }
    catch { throw new UsageRefusalError(`the resumed agy login link was replaced: the private home holds its own file or directory at ${destination}, where the link to ${path} belongs; start a new session`); }
    if (target !== path) throw new UsageRefusalError(`the resumed agy login link changed: ${destination}; start a new session`);
  }
  // A native session resumed with an API key now set reaches both logins;
  // this is said once every link has been restored.
  if (usableKey(options)) noticeAgyKeychainReachable(dir, options.sandboxed, options.platform);
  return "native";
}
