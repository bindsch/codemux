/**
 * The private-login content of a hermetic agy SESSION's private home
 * (the SessionPrivateHome contract, private-home-types.ts): the populate
 * callback the launcher runs inside a fresh home, and the verification a
 * `--resume` runs against the reopened one. The run path's
 * preparePrivateHome (adapters/agy.ts) is the reference — this is the
 * same login selection with session lifetime: no operator state is ever
 * linked into the home, no settings.json is written (the caller owns
 * that file and codemux must never overwrite what it wrote), the login
 * is created once per session, and every refresh stays inside the home.
 */

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AGY_MIRROR_PATH,
  agyKeychainHost,
  ensureAgyMirrorDefault,
  insertAgyKeychainItem,
  prepareAgyPrivateKeychain,
  recoverAgyKeychainSearchList,
  unlockAgyMirrorBestEffort,
  verifyAgyKeychainSearchList,
} from "../agy-keychain.js";
import { resolveTrustedExecutable } from "../executable-security.js";
import { AGY_SESSION_HOME_PREFIX, markAgyPrivateHome } from "../adapters/agy-homes.js";
import { readAgyTokenForCopy } from "../adapters/agy-settings.js";
import { UsageRefusalError } from "../validation.js";

/** The file-token path under a home, relative — spelled once for the
 * operator's real home (the copy source) and the private one (the
 * destination). */
const TOKEN_PATH = ".gemini/antigravity-cli/antigravity-oauth-token";

/** The login marker a populate writes at the home root (mode 0600): the
 * arm that populated the home, so a resume proves exactly that arm's
 * credential instead of a file's existence — the populate order creates
 * the keychain mirror before the login selection, so an api-key or
 * file-token home carries an empty mirror (round 413, item 3). */
const LOGIN_MARKER = ".codemux-login";

/** The arm names the marker carries (round 413, item 3). */
export type AgySessionLoginArm = "api-key" | "token" | "keychain";

/** What a fresh populate selected, reported so tests and the launcher
 * can pin the arm that ran. */
export type AgySessionLoginSource = "api-key" | "file-token" | "keychain";

export interface AgySessionHomeOptions {
  /** The codemux process's environment — the operator's real HOME for
   * keychain recovery and the token source, never the private home. */
  environment: NodeJS.ProcessEnv;
  /** The session's --cwd, forwarded to the keychain client for
   * executable resolution exactly as the run path forwards one. */
  cwd?: string;
  /** True when the sandbox policy scrubs ambient credentials (scode
   * --scrub-env, or --trust untrusted) with no keep exemption for the
   * agy names: a scrubbed key never selects the api-key arm. Computed
   * by the caller the way the run path computes it (adapters/agy.ts). */
  scrubbing: boolean;
  /** Names the sandbox policy keeps through a scrub (--pass-env): an
   * API key kept this way still selects the api-key arm. */
  keepEnv?: readonly string[];
}

function hasApiKey(options: AgySessionHomeOptions): boolean {
  return ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some(
    (name) =>
      Boolean(options.environment[name]) &&
      (!options.scrubbing || (options.keepEnv?.includes(name) ?? false))
  );
}

/** A regular file, not a link: the resume check reads presence only, so
 * a swapped link answers "no login" and fails closed instead of
 * following whatever it points at. */
function regularFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ?? false;
}

/**
 * Populate a fresh hermetic session home: recover the user's Keychain
 * search list (every launch does, so a crashed run or session leaves
 * nothing behind), identify the home for the pid-owned sweep, prepare
 * the private Keychain and its private default, then select the login —
 * API key, else the operator's file token copied mode 0600, else the
 * real Keychain item copied into the private Keychain. No settings.json
 * is written and no operator state is linked. A failure repairs the
 * search list as far as it can and rethrows; the launcher removes the
 * fresh home (private-home.ts populateOrRemove).
 */
export function populateAgySessionPrivateHome(
  dir: string,
  options: AgySessionHomeOptions
): AgySessionLoginSource {
  const { environment, cwd } = options;
  try {
    recoverAgyKeychainSearchList(environment, cwd);
    markAgyPrivateHome(dir);
    const password = prepareAgyPrivateKeychain(dir, environment, cwd);
    const state = join(dir, ".gemini", "antigravity-cli");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    let source: AgySessionLoginSource;
    if (hasApiKey(options)) {
      source = "api-key";
    } else {
      // The token is read once, non-following and bounded
      // (readAgyTokenForCopy): a symlink or an oversized source refuses
      // naming the reason; null is "no file token" and falls to the
      // Keychain arm. The copy is byte for byte, mode 0600, exclusive.
      const fileToken = readAgyTokenForCopy(join(agyKeychainHost.home(), TOKEN_PATH));
      if (fileToken !== null) {
        writeFileSync(join(state, "antigravity-oauth-token"), fileToken, { flag: "wx", mode: 0o600 });
        source = "file-token";
      } else {
        insertAgyKeychainItem(dir, environment, password, cwd);
        source = "keychain";
      }
    }
    // The marker names the arm the resume check proves (round 413,
    // item 3). It carries no credential, and a write that cannot
    // complete fails the populate — the launcher removes the home.
    writeFileSync(
      join(dir, LOGIN_MARKER),
      source === "file-token" ? "token" : source,
      { mode: 0o600 }
    );
    return source;
  } catch (error) {
    // The home's removal is the launcher's; the Keychain hygiene is
    // here, because only this side knows the populate reached the
    // keychain at all. Best-effort, appended to the real error.
    try {
      recoverAgyKeychainSearchList(environment, cwd);
      verifyAgyKeychainSearchList(environment);
    } catch (cleanupError) {
      if (error instanceof Error) {
        error.message +=
          `; keychain recovery after the failure did not verify: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`;
      }
    }
    throw error;
  }
}

/** What a resumed home's login check found: the arm the marker names,
 * proven on that arm's own credential (round 413, item 3). */
export type AgySessionResumeLogin = AgySessionLoginArm;

/** The harness state home a hermetic session records, on its stable
 * session-keyed spelling: `<parent>/session-<id>/.gemini/antigravity-
 * cli`. A fresh session's live home is still run-shaped when the record
 * is written (the id arrives with the first result, the settle with the
 * end), so the record names the path a `--resume` computes — the codex
 * override session's rule (cli-drivers.ts) — and both a fresh record
 * and a resumed one spell the same directory. */
export function settledAgyHarnessHome(privateHomeDir: string, sessionId: string): string {
  return join(
    dirname(privateHomeDir),
    `${AGY_SESSION_HOME_PREFIX}${sessionId}`,
    ".gemini",
    "antigravity-cli"
  );
}

/** The arm the home's login marker names. A missing or unreadable
 * marker, or one naming an unknown arm, refuses: the home proves no
 * arm, so nothing is verified (round 413, item 3). */
function loginArm(dir: string): AgySessionLoginArm {
  let marker: string;
  try {
    marker = readFileSync(join(dir, LOGIN_MARKER), "utf8").trim();
  } catch {
    throw new UsageRefusalError(
      `the resumed agy private home ${dir} carries no login marker (${LOGIN_MARKER}): ` +
        "the arm that populated it cannot be proven, so the session cannot resume"
    );
  }
  if (marker !== "api-key" && marker !== "token" && marker !== "keychain") {
    throw new UsageRefusalError(
      `the resumed agy private home ${dir} names an unknown login arm in ` +
        `${LOGIN_MARKER}: "${marker}" — the session cannot resume`
    );
  }
  return marker;
}

/** Find-generic-password pinned to the private mirror (round 413,
 * item 3): the same service/account pair the insert arm reads
 * (src/agy-keychain.ts, insertAgyKeychainItem's find) with no `-w` —
 * the item's existence is proven without reading the secret — and the
 * trailing keychain path, the same spelling the insert arm's add uses,
 * pins the search to the private mirror so an empty mirror cannot
 * borrow the real login's existence. Subprocess errors and output are
 * swallowed: either may contain credentials. */
function mirrorHoldsLogin(dir: string, environment: NodeJS.ProcessEnv, cwd?: string): boolean {
  const path = agyKeychainHost.securityPath(environment);
  if (!path) return false;
  try {
    const security = resolveTrustedExecutable(path, "security", cwd);
    const result = agyKeychainHost.spawnSync(
      [
        security,
        "find-generic-password",
        "-s",
        "gemini",
        "-a",
        "antigravity",
        join(dir, AGY_MIRROR_PATH),
      ],
      {
        env: { HOME: dir, PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    return result.exitCode === 0 && !result.signalCode;
  } catch {
    return false;
  }
}

/**
 * Verify a resumed session home still carries its login, without
 * rewriting anything: the home's login marker names the arm, and that
 * arm's own credential is proven — the key surviving in the environment
 * (honoring keepEnv), the copied token file, or the gemini login item
 * findable in the private mirror through the security host (never the
 * mirror file's existence). A drifted private default is re-selected
 * and the mirror re-unlocked on the keychain arm only. A missing
 * marker or a missing credential refuses — a resume would launch agy
 * unauthenticated and, worse, agy could then store a fresh login into
 * the private home, so the failure is closed at the boundary.
 */
export function verifyAgySessionPrivateHome(
  dir: string,
  options: AgySessionHomeOptions
): AgySessionResumeLogin {
  const { environment, cwd } = options;
  recoverAgyKeychainSearchList(environment, cwd);
  const arm = loginArm(dir);
  if (arm === "api-key") {
    if (hasApiKey(options)) return "api-key";
    throw new UsageRefusalError(
      `the resumed agy private home ${dir} was populated with the API-key arm, ` +
        "but no API key survives in the environment — the session cannot resume " +
        "unauthenticated"
    );
  }
  if (arm === "token") {
    if (regularFile(join(dir, TOKEN_PATH))) return "token";
    throw new UsageRefusalError(
      `the resumed agy private home ${dir} was populated with the file-token ` +
        "arm, but the copied token file is gone — the session cannot resume " +
        "unauthenticated"
    );
  }
  if (!regularFile(join(dir, AGY_MIRROR_PATH)) || !mirrorHoldsLogin(dir, environment, cwd)) {
    throw new UsageRefusalError(
      `the resumed agy private home ${dir} was populated with the keychain arm, ` +
        "but its private mirror holds no gemini login item — the session cannot " +
        "resume unauthenticated"
    );
  }
  unlockAgyMirrorBestEffort(dir, environment, cwd);
  ensureAgyMirrorDefault(dir, environment, cwd);
  return "keychain";
}
