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
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { hasActiveCapturedCommand } from "./process-runner.js";

export interface HermeticHome {
  /** The private HOME. */
  home: string;
  /** The private CODEX_HOME beneath it. */
  codexHome: string;
  /** Warns about a discarded rotation, then removes the home. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux-hermetic";
const RUN_PREFIX = "run-";

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler may leave a Codex child
// running in its home for as long as a run is allowed to last; a home is
// swept only once it is older than the longest run plus a margin.
const STALE_HOME_MS = 2 * 86_400_000;

/** Removes homes left behind by codemux processes that no longer exist. */
function sweepStaleHomes(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^run-(\d+)-/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    const path = join(parent, entry);
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (age < STALE_HOME_MS) continue;
    rmSync(path, { recursive: true, force: true });
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
  apiKeyAuth = false
): HermeticHome {
  const sourceAuth = join(sourceCodexHome, "auth.json");
  const linkLogin = !apiKeyAuth;
  if (linkLogin) assertRealLoginFile(sourceAuth);

  const parent = join(sourceCodexHome, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to ~/.codex could have replaced the parent
  // with a symlink, pointing the sweep's rm and the login link elsewhere.
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid())
  ) {
    throw new Error(`${parent} must be a directory owned by the current user`);
  }
  sweepStaleHomes(parent);
  // mkdtemp creates the directory mode 0700; the login inside is 0600.
  const home = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { mode: 0o700 });
  const authLink = join(codexHome, "auth.json");

  let linkKind: "hard" | "symlink" | "none" = "none";
  if (linkLogin) {
    try {
      linkSync(sourceAuth, authLink);
      linkKind = "hard";
    } catch {
      // A filesystem without hard links: a symlink still lets Codex's
      // in-place rewrite reach the real file.
      symlinkSync(sourceAuth, authLink);
      linkKind = "symlink";
    }
  }

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
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
  };
  process.once("exit", finalize);
  // While the run's command is in flight, the process runner owns the
  // signal: it terminates the tree, then exits, and the exit event fires
  // here. Between creating the home and that spawn (the scode version
  // probe sits there), nothing else handles a signal, so this does.
  const signalHandlers: Array<["SIGINT" | "SIGTERM" | "SIGHUP", () => void]> = [];
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    const handler = (): void => {
      if (hasActiveCapturedCommand()) return;
      finalize();
      process.exit(code);
    };
    signalHandlers.push([signal, handler]);
    process.on(signal, handler);
  }

  return { home, codexHome, finalize };
}
