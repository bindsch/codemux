/**
 * A private HOME for hermetic Codex runs.
 *
 * Codex reads the operator's customizations from two places: `$CODEX_HOME`
 * (config.toml, AGENTS.md, hooks.json, memories, plugins, the deprecated
 * skills directory, execpolicy rules) and `$HOME/.agents/skills`. No flag
 * turns all of that off, so a hermetic run gets a fresh directory as both
 * HOME and CODEX_HOME, holding nothing but the login.
 *
 * The directory lives inside the real CODEX_HOME (`.codemux-hermetic/`),
 * not under the temp root: scode treats `~/.codex` as harness state on
 * every platform, while its Linux sandbox mounts a fresh `/tmp` that would
 * hide a home created there, and a write policy for `~/.codex` then covers
 * the private login too.
 *
 * The login is `auth.json`, and Codex rotates the tokens inside it: a copy
 * would strand the refreshed token in the private home and could leave the
 * real file holding a token the server no longer accepts. So the private
 * home carries a HARD LINK to the real file. Codex writes auth.json in place
 * (truncate and rewrite, never rename), which updates the shared inode, so
 * the real login stays current. Should a future Codex replace the file
 * instead, the link diverges; the run then warns that its token rotation
 * was discarded. Nothing is ever written back over the real file: a
 * lock-free reconciliation cannot tell a rotation of this run from a
 * concurrent login, logout, or another run's refresh.
 */

import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { prepareRunDirParent } from "./hermetic-sweep.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
export { assertTrustedDirectory, prepareRunDirParent, MTIME_WALK_ENTRY_CAP } from "./hermetic-sweep.js";

export interface HermeticHome {
  /** The private HOME. */
  home: string;
  /** The private CODEX_HOME beneath it. */
  codexHome: string;
  /** Warns about a discarded rotation, then removes the home. */
  finalize: () => void;
}

/** The two ways a private home can share the real login file. Injectable so
 * tests can fail both kinds deterministically after the home exists. */
export interface LoginLinkOperations {
  hard: (source: string, destination: string) => void;
  symlink: (source: string, destination: string) => void;
}
const realLoginLinks: LoginLinkOperations = { hard: linkSync, symlink: symlinkSync };

// Shared with the Claude project-settings config directory
// (claude-project-config.ts), whose per-run directories live beside these.
export const PARENT_DIR_NAME = ".codemux-hermetic";
export const RUN_PREFIX = "run-";

function inodeOf(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

function assertRealLoginFile(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(
      `codex hermetic runs need a file login: ${path} does not exist. ` +
        "Log in with 'codex login' using cli_auth_credentials_store = \"file\" " +
        "(a Keychain-stored login is keyed to the real CODEX_HOME and cannot " +
        "be shared with the private home), or set CODEX_API_KEY."
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`codex login file ${path} must be a regular file`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`codex login file ${path} must be owned by the current user`);
  }
}

/**
 * Creates the private home. `sourceCodexHome` is the real CODEX_HOME whose
 * auth.json the run may use (and refresh). With `apiKeyAuth`, the run
 * authenticates through OPENAI_API_KEY in its environment and the home
 * holds no login at all, even when a file login exists: an API-key run
 * stays API-key-only and never touches the account login.
 */
export function createCodexHermeticHome(
  sourceCodexHome: string,
  apiKeyAuth = false,
  loginLinks: LoginLinkOperations = realLoginLinks
): HermeticHome {
  const sourceAuth = join(sourceCodexHome, "auth.json");
  const linkLogin = !apiKeyAuth;
  if (linkLogin) assertRealLoginFile(sourceAuth);

  const parent = prepareRunDirParent(sourceCodexHome, PARENT_DIR_NAME);
  // mkdtemp creates the directory mode 0700; the login inside is 0600.
  const home = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));
  const codexHome = join(home, ".codex");
  const authLink = join(codexHome, "auth.json");

  // The finalizer is registered before any operation that can throw
  // (kimi-hermetic's ordering): a home whose login link fails mid-creation
  // must not stay on disk, because the caller never receives a context to
  // clean up.
  let linkKind: "hard" | "symlink" | "none" = "none";
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    try {
      const diverged =
        linkKind === "none"
          ? false
          : linkKind === "hard"
            ? inodeOf(authLink) !== inodeOf(sourceAuth)
            : !lstatSync(authLink).isSymbolicLink();
      if (diverged) {
        console.error(
          "codex: the hermetic run replaced its login file instead of rewriting " +
            `it, so a token rotation from this run was discarded; ${sourceAuth} ` +
            "is unchanged. If codex reports an expired session, run 'codex login'."
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`codex: could not inspect the hermetic login: ${message}`);
    } finally {
      // rm never follows the link: it unlinks our name, or the symlink itself.
      rmSync(home, { recursive: true, force: true });
      process.off("exit", finalize);
      untrackPrivateDir(finalize);
    }
  };
  process.once("exit", finalize);
  trackPrivateDir(finalize);

  try {
    mkdirSync(codexHome, { mode: 0o700 });
    if (linkLogin) {
      try {
        loginLinks.hard(sourceAuth, authLink);
        linkKind = "hard";
      } catch {
        // A filesystem without hard links: a symlink still lets Codex's
        // in-place rewrite reach the real file.
        loginLinks.symlink(sourceAuth, authLink);
        linkKind = "symlink";
      }
    }
  } catch (error) {
    finalize();
    throw error;
  }

  return { home, codexHome, finalize };
}
