import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { NATIVE_LOGIN_PATHS, nativeLoginPaths } from "./native-login-paths.js";
import { UsageRefusalError } from "./validation.js";

export interface AgyAuthOptions {
  environment: NodeJS.ProcessEnv;
  scrubbing: boolean;
  keepEnv?: readonly string[];
}

export const AGY_NATIVE_PATHS = NATIVE_LOGIN_PATHS;
export const AGY_FILE_TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";

/** Create the directories between `home` and a link's place one level at a
 * time, never through a symlink. A persistent session home is writable by
 * its sandboxed child, which could replace `Library` or
 * `.gemini/antigravity-cli` with a symlink; a recursive mkdir followed it
 * and codemux then created the login link outside the home (review round
 * 5). Any existing component that is not a real directory refuses. */
export function ensureAgyLinkParent(home: string, relative: string): void {
  // The home itself is the caller's trusted root; only what lies under it
  // can have been replaced by the child.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let current = home;
  for (const part of dirname(relative).split(sep).filter((name) => name !== "" && name !== ".")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      try { mkdirSync(current, { mode: 0o700 }); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!lstatSync(current).isDirectory()) {
      throw new UsageRefusalError(
        `cannot link the agy login: ${current} is a symbolic link or a file where the home needs its own directory; ` +
        "codemux never follows or replaces it; remove it, use another home, or authenticate with GEMINI_API_KEY or GOOGLE_API_KEY");
    }
  }
}

/** Share paths, never read credentials or alter the user's native store.
 * Security.framework expands preference and login paths relative to HOME.
 * agy remains the sole reader and writer of its own native login item.
 * An entry already at a link's place is never deleted or replaced: the
 * same link passes, anything else is a refusal that names the path. */
export function linkAgyLogin(home: string, source: string, platform = process.platform): void {
  for (const relative of [...(platform === "darwin" ? AGY_NATIVE_PATHS : []), AGY_FILE_TOKEN]) {
    const from = join(source, relative);
    if (!existsSync(from)) continue;
    const to = join(home, relative);
    ensureAgyLinkParent(home, relative);
    try { symlinkSync(from, to); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(to).isSymbolicLink()) {
        throw new UsageRefusalError(
          `cannot link the agy login: the home holds its own file or directory at ${to}, where the link to ${from} belongs; ` +
          "codemux never deletes it; move it away, use another home, or authenticate with GEMINI_API_KEY or GOOGLE_API_KEY");
      }
      if (resolve(dirname(to), readlinkSync(to)) !== resolve(from)) {
        throw new UsageRefusalError(
          `cannot link the agy login: ${to} already links somewhere other than ${from}; codemux never replaces it; remove that link or use another home`);
      }
    }
  }
}

/** Discover native paths; the sandbox grants preferences read-only. */
export function agyLoginPaths(source: string, platform = process.platform): string[] {
  return nativeLoginPaths(source, platform);
}

/** Files codemux 2.0.1 to 2.0.3 kept beside the call log for a private
 * copy of the agy login. Nothing reads them now. */
export const RETIRED_AGY_MIRROR_FILES = [
  "agy-mirror-template.keychain-db",
  "agy-mirror-template.keychain-db.password",
  "agy-mirror-template.keychain-db.lock",
] as const;

/** Remove the retired copy store, by plain unlink of codemux's own regular
 * files. Best effort: a failure leaves an unused file, never a broken run. */
export function removeRetiredAgyMirror(stateDir: string): void {
  for (const name of RETIRED_AGY_MIRROR_FILES) {
    const path = join(stateDir, name);
    try {
      if (lstatSync(path).isFile()) unlinkSync(path);
    } catch {
      // Absent or not removable: nothing depends on it.
    }
  }
}
