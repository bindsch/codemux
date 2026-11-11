/**
 * A private HOME for hermetic Droid runs.
 *
 * Droid reads the operator's customizations from the brand home
 * `~/.factory` — settings.json (BYOK entries, defaults), skills, hooks,
 * the login file auth.json — plus the guideline directories `.factory`,
 * `.factory-dev`, `.agents` and `.agent` and the skill directory
 * `.claude`, all resolved from the same root. The root comes from
 * FACTORY_HOME_OVERRIDE, else HOME, else USERPROFILE, else the cwd
 * (droid 0.221.0 binary strings: `process.env[Q.FACTORY_HOME_OVERRIDE] ??
 * process.env[Q.HOME] ?? process.env[Q.USERPROFILE] ?? process.cwd()`,
 * read 2026-11-09), so a hermetic run gives the child a fresh HOME with
 * FACTORY_HOME_OVERRIDE unset: every one of those paths then resolves
 * inside the private home, which holds nothing but a hard link to the
 * login file. A passed-through FACTORY_HOME_OVERRIDE would beat the
 * private HOME, so hermetic runs do not pass it through (the adapter
 * refuses the combination).
 *
 * The directory lives inside the real brand home (`.codemux-hermetic/`),
 * not under the temp root: scode treats `~/.factory` as harness state on
 * every platform, while its Linux sandbox mounts a fresh `/tmp` that
 * would hide a home created there, and a write policy for `~/.factory`
 * then covers the private login too.
 *
 * The login is `auth.json`, and droid rewrites tokens in place, so the
 * private home carries a HARD LINK to the real file (the codex rule): a
 * rotation through the link updates the shared inode and the real login
 * stays current. A missing login links nothing — the run then
 * authenticates with FACTORY_API_KEY from the environment or fails
 * droid's own login check, which is the operator's to fix. Self-update is
 * disabled for the child (FACTORY_DROID_AUTO_UPDATE_ENABLED=false), the
 * same containment kimi's hermetic home applies: private update state
 * must not decide whether the shared binary replaces itself.
 */

import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { PARENT_DIR_NAME, RUN_PREFIX, prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";

export interface DroidHermeticHome {
  /** The private HOME. */
  home: string;
  /** The private brand home beneath it (`<home>/.factory`). */
  brandHome: string;
  /** Warns about a discarded rotation, then removes the home. */
  finalize: () => void;
}

/** The two ways a private home can share the real login file. Injectable so
 * tests can fail both kinds deterministically after the home exists. */
export interface DroidLoginLinkOperations {
  hard: (source: string, destination: string) => void;
  symlink: (source: string, destination: string) => void;
}
const realLoginLinks: DroidLoginLinkOperations = { hard: linkSync, symlink: symlinkSync };

/** The argv prefix that redirects the child's home resolution: FACTORY_HOME_OVERRIDE
 * unset (an exported value would outrank HOME), HOME pointed at the private
 * home, and self-update off. Shared by the adapter's buildRunCommand. */
// Private update state does not stop droid from replacing the shared
// executable (the kimi rule).
export const DROID_HERMETIC_ENV_ASSIGNMENTS = ["FACTORY_DROID_AUTO_UPDATE_ENABLED=false"] as const;
export const DROID_HERMETIC_ENV_OMISSIONS = ["FACTORY_HOME_OVERRIDE"] as const;

function inodeOf(path: string): number | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.ino : null;
  } catch {
    return null;
  }
}

/**
 * Creates the private home. `sourceBrandHome` is the real brand home
 * (`~/.factory`) whose auth.json the run may use (and refresh).
 */
export function createDroidHermeticHome(
  sourceBrandHome: string,
  loginLinks: DroidLoginLinkOperations = realLoginLinks,
  printOnly = false
): DroidHermeticHome {
  if (printOnly) {
    const home = join(sourceBrandHome, PARENT_DIR_NAME, "preview");
    return { home, brandHome: join(home, ".factory"), finalize: () => {} };
  }
  const sourceAuth = join(sourceBrandHome, "auth.json");
  const parent = prepareRunDirParent(sourceBrandHome, PARENT_DIR_NAME);
  // Recorded for the finalizer's revalidation (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));
  chmodSync(home, 0o700); // the mode is stated whatever the umask is
  const brandHome = join(home, ".factory");
  const authLink = join(brandHome, "auth.json");

  let linkKind: "hard" | "symlink" | "none" = "none";
  let finalized = false;
  let inspected = false;
  const inspectLogin = (): void => {
    if (linkKind === "none") return;
    try {
      const diverged =
        linkKind === "hard"
          ? inodeOf(authLink) !== inodeOf(sourceAuth)
          : !lstatSync(authLink).isSymbolicLink();
      if (diverged) {
        console.error(
          "droid: the hermetic run replaced its login file instead of rewriting " +
            `it, so a token rotation from this run was discarded; ${sourceAuth} ` +
            "is unchanged. If droid reports an expired session, log in again."
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`droid: could not inspect the hermetic login: ${message}`);
    }
  };
  const finalize = (): void => {
    if (finalized) return;
    if (!inspected) {
      inspected = true;
      inspectLogin();
    }
    // rm never follows the link: it unlinks our name, and only under the
    // parent recorded above. Thrown when refused or failed, so the
    // adapter's cleanup reports the kept home; it stays retryable, and
    // the hook retries and reports (round 97).
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private hermetic home ${home}`);
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);

  try {
    mkdirSync(brandHome, { mode: 0o700 });
    chmodSync(brandHome, 0o700); // the mode is stated whatever the umask is
    let stat;
    try {
      stat = lstatSync(sourceAuth);
    } catch {
      // No file login: FACTORY_API_KEY or nothing — droid's own login
      // check answers, never a fabricated one here.
      stat = undefined;
    }
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`droid hermetic runs need a file login: ${sourceAuth} is not a regular file`);
      }
      try {
        loginLinks.hard(sourceAuth, authLink);
        linkKind = "hard";
      } catch {
        // A filesystem without hard links: a symlink still lets droid's
        // in-place rewrite reach the real file.
        loginLinks.symlink(sourceAuth, authLink);
        linkKind = "symlink";
      }
    }
  } catch (error) {
    finalize();
    throw error;
  }

  return { home, brandHome, finalize };
}
