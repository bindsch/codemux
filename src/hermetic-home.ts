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
import { sessionHoldState, sessionRegistryPath, type SessionHold } from "./session/registry.js";

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

// Homes not yet finalized. One set of signal handlers exists while this is
// non-empty: between creating a home and spawning the run (the scode
// version probe sits there) nothing else handles a signal. While the run's
// command is in flight, the process runner owns the signal instead: it
// terminates the tree, then exits, and the exit event finalizes the homes.
const liveHomes = new Set<() => void>();
const SIGNALS = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function onSignal(code: number): void {
  if (hasActiveCapturedCommand()) return;
  for (const finalize of [...liveHomes]) finalize();
  process.exit(code);
}

function trackHome(finalize: () => void): void {
  liveHomes.add(finalize);
  if (signalHandlers.size > 0) return;
  for (const [signal, code] of SIGNALS) {
    const handler = (): void => onSignal(code);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function untrackHome(finalize: () => void): void {
  liveHomes.delete(finalize);
  if (liveHomes.size > 0) return;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

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
// running in its home for as long as a run is allowed to last; a run
// directory is swept only once it is older than the longest run plus a
// margin.
const STALE_RUN_DIR_MS = 2 * 86_400_000;

// A session home (`session-home-…`) carries resumable state: no process
// owns it while the session is closed, and its key holds no pid, so it is
// swept by age — at the age aider's session directories use — EXCEPT an
// id the registry holds live (below), the rule aider's own sweep already
// carries. Both gates age by the NEWEST mtime anywhere in the directory's tree,
// never the top directory's own mtime: the harness writes its
// thread state into subdirectories (sessions/…), which does not move the
// parent's mtime, so a top-dir age deleted the homes of live,
// long-running sessions 28 days after their creation (review D2,
// security 2). A tree nothing has written to for the gate's span is idle
// past any session's lifetime — and a tree too big to walk is judged by
// the directory's own mtime when the registry has POSITIVELY freed the
// id (sweepStaleRunDirs below, review D10).
const STALE_SESSION_HOME_MS = 28 * 86_400_000;

// The walk's entry budget (review D7, correctness-2 2): these trees sit
// under `~/.codex`, which the sandboxed child can write, so a child that
// creates a deep or wide tree there must not slow every later codemux
// codex run by making the freshness probe walk all of it. Over budget the
// walk gives up and answers null — a run-directory caller falls back to
// the directory's own mtime (below), and so does a session-home caller
// whose id the registry has POSITIVELY freed (the ownership proof the
// run branch's pid gate provides); every other session home is spared,
// the safe direction for a removal (review D10, correctness-2 2).
// Exported for the sweep's regression test.
export const MTIME_WALK_ENTRY_CAP = 4096;

/** The newest mtime anywhere under `path`, `path` itself included. The
 * walk uses lstat and never follows a symlink, so a link the sandboxed
 * child planted cannot aim the freshness probe outside the tree. Null
 * when the path itself cannot be stat'd, or when the tree exceeds the
 * entry cap above — a run directory then falls back to its own mtime
 * (directoryMtimeMs, below), and so does a session home the registry
 * has positively freed; any other session home is spared —
 * a removal needs a positive reading, never an exhausted probe. */
function newestMtimeMs(path: string): number | null {
  let newest: number | null = null;
  let budget = MTIME_WALK_ENTRY_CAP;
  const consider = (mtimeMs: number): void => {
    if (newest === null || mtimeMs > newest) newest = mtimeMs;
  };
  // Returns false only when the budget ran out mid-tree.
  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return false;
      const child = join(dir, entry);
      try {
        const stat = lstatSync(child);
        consider(stat.mtimeMs);
        if (stat.isDirectory() && !walk(child)) return false;
      } catch {
        continue;
      }
    }
    return true;
  };
  try {
    consider(lstatSync(path).mtimeMs);
  } catch {
    return null;
  }
  if (!walk(path)) return null;
  return newest;
}

/** The entry's own mtime, no walk: a run directory's fallback when the
 * capped walk cannot finish (review D9, correctness-2). Its pid gate has
 * already shown no codemux owns the tree, so an over-budget walk must
 * not spare it forever — a crashed run whose caches filled its HOME past
 * the cap leaked the directory under `~/.codex` and cost every later run
 * a walk to the cap. Null when the path cannot be stat'd, when the sweep
 * leaves the entry alone. */
function directoryMtimeMs(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Removes run directories (`run-<pid>-<random>`) left behind by codemux
 * processes that no longer exist, once they are also stale (the age gate
 * above), and stale session homes (`session-home-…` — the session gate
 * above, plus the liveness skip below). Both ages are the tree-newest
 * mtime (above), and the walk is bounded: a run-shaped entry's pid gate
 * comes from its NAME (no walk for a live run), a session home's
 * registry check comes BEFORE the walk (no walk for a held or unknown
 * id — a live session's home may sit past the cap, and re-walking it on
 * every run is the recurring cost the cap exists to bound; review D10,
 * correctness-2 2), and an over-budget tree answers null: a run
 * directory past its pid gate falls back to the directory's OWN mtime,
 * so a huge dead tree is reclaimed by age instead of leaking and being
 * re-walked to the cap forever (review D9, correctness-2) — and so does
 * a session home whose id the registry has POSITIVELY freed, for the
 * same reason under the same proof (review D10, correctness-2 2). Every
 * other session home is spared on null (review D7, correctness-2 2: a
 * child that can write `~/.codex` must not make the sweep walk a huge
 * tree on every run).
 * `.codemux-hermetic` and
 * `.codemux-scratch` hold run
 * directories, and so does codex's `.codemux-provider`
 * (codex-provider.ts), which holds the session homes beside them.
 *
 * A session home past the age gate is still spared when the registry
 * holds its id live (an OPEN record whose owner is alive —
 * `sessionHoldState` answering `held`): a resumed codex session can sit
 * open for weeks writing nothing, and this sweep fires from ANY codemux
 * run's `prepareRunDirParent`, which would delete the live session's
 * CODEX_HOME out from under its running app-server (review D4,
 * security). Removal needs a POSITIVE `free` answer: `unknown` (an
 * unreadable registry — a busy lock, an I/O error, a corrupt file)
 * spares the home, because a read failure folded into "not held"
 * deleted a live session's CODEX_HOME during a transient failure
 * (review D5, correctness 1). The default consults the machine's one
 * registry (`sessionRegistryPath()`, derived from HOME exactly as the
 * session CLI derives it); the parameter exists so tests can point the
 * check at their own registry.
 */
/** One bad entry must not block the run, or every later run (review D11,
 * correctness 2 2): a sandboxed child can leave an undeletable subtree
 * inside a stale entry — a directory without write permission — and an
 * EACCES out of this sweep would fail every later codemux run that
 * reaches prepareRunDirParent until someone removed it by hand. The
 * entry stays (retrying never cleans it either), the sweep moves on, and
 * the operator learns why — the other sweeps' rule (opencode-hermetic,
 * the provider settings, the aider session directories). */
function removeSweepEntry(path: string, what: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    console.error(`codemux: could not remove the ${what} ${path}${detail}`);
  }
}

function sweepStaleRunDirs(
  parent: string,
  holdStateOf: (id: string) => SessionHold = (id) =>
    sessionHoldState(sessionRegistryPath(), id),
  spareEntry?: string
): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    // An entry this caller is about to open (a resume's keyed home) is
    // not this sweep's to judge — skipped before any stat or walk, so
    // the caller's own setup cannot delete what it came for (review
    // D10, correctness-2 3).
    if (entry === spareEntry) continue;
    const path = join(parent, entry);
    const runMatch = /^run-(\d+)-/.exec(entry);
    if (runMatch) {
      // The pid gate runs on the NAME, before any tree walk: the parent
      // sits under `~/.codex`, which the sandboxed child can write, and a
      // LIVE run's tree (deep or wide, the child's to fill) was walked
      // for nothing here on every prepareRunDirParent call (review D7,
      // correctness-2 2).
      const pid = Number(runMatch[1]);
      if (pid === process.pid || processAlive(pid)) continue;
      // The walk's null must not spare a DEAD run forever: nothing owns
      // the tree anymore, so an over-budget walk falls back to the
      // directory's own mtime (review D9, correctness-2) and the crash
      // leftover goes by its own age.
      const newest = newestMtimeMs(path) ?? directoryMtimeMs(path);
      if (newest === null || Date.now() - newest < STALE_RUN_DIR_MS) continue;
      removeSweepEntry(path, "stale run directory");
      continue;
    }
    if (entry.startsWith("session-home-")) {
      // Cheap gate first: the directory's own mtime is a FLOOR on the
      // tree-newest age (the walk includes the root itself), so a home
      // young by its own mtime needs neither the registry nor the walk.
      const own = directoryMtimeMs(path);
      if (own !== null && Date.now() - own < STALE_SESSION_HOME_MS) continue;
      // The id is everything past the endpoint hash; a codex thread id
      // may itself contain `-`, so the hash (exactly 12 hex) is the
      // anchor and the rest is the id whole.
      const id = /^session-home-[0-9a-f]{12}-(.+)$/.exec(entry)?.[1];
      // The registry runs BEFORE the walk, and only a POSITIVE `free`
      // ever removes (review D5, correctness 1): a held or unknown id is
      // spared without paying for the tree at all — a live session's home
      // may sit past the walk cap, and walking it on every later codemux
      // run is exactly the recurring cost the cap exists to bound (the
      // pid-gate reorder's twin, review D10, correctness-2 2).
      if (id !== undefined && holdStateOf(id) !== "free") continue;
      const newest = newestMtimeMs(path);
      if (newest !== null && Date.now() - newest < STALE_SESSION_HOME_MS) continue;
      // An over-budget walk (null) falls back to the own mtime above —
      // already past the gate — for exactly the keyed homes with a
      // positive `free`: that answer is the ownership proof the run
      // branch's pid gate provides, so a home grown past the cap is
      // reclaimed by age instead of leaking and being re-walked to the
      // cap forever (review D10, correctness-2 2; the run branch's D9
      // twin). An entry whose name carries no parseable id is not a
      // registry key — no proof exists — and keeps the D7 spare, as does
      // an unstatable directory.
      if (newest === null && (id === undefined || own === null)) continue;
      removeSweepEntry(path, "stale session home");
      continue;
    }
    // Any other entry is not this sweep's to judge — never walked, never
    // removed (previously the walk ran on every entry, named or not).
  }
}

/**
 * Refuses a path that is not a real directory owned by the current user.
 * `prepareRunDirParent` applies this to a parent at creation time; the
 * `--output-last-message` reader applies it to the per-run directory and
 * that parent again at read time, because a run with write access to
 * ~/.codex could have swapped either for a symlink in between, pointing a
 * read or a delete through it into a directory codemux never chose.
 */
export function assertTrustedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid())
  ) {
    throw new Error(`${path} must be a directory owned by the current user`);
  }
}

/**
 * Creates the parent a run's per-run directories live under inside the real
 * CODEX_HOME (`.codemux-hermetic` for private homes, `.codemux-scratch` for
 * `--output-last-message` files, `.codemux-provider` for provider-override
 * and session homes): made if missing, checked for the shape and ownership
 * a run can trust, and swept of run directories left by codemux processes
 * that no longer exist and of session homes gone stale (the liveness skip
 * of sweepStaleRunDirs applies; `holdStateOf` overrides its default
 * registry for tests). Returns the parent's path.
 */
export function prepareRunDirParent(
  codexHome: string,
  name: string,
  holdStateOf?: (id: string) => SessionHold,
  /** An entry name this caller is about to open — a codex override
   * resume's keyed session home: the sweep must not delete what the
   * caller came for even past the age gate (the registry answers `free`
   * for an ended record, and the resume itself is the counter-claim;
   * review D10, correctness-2 3). */
  spareEntry?: string
): string {
  const parent = join(codexHome, name);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertTrustedDirectory(parent);
  sweepStaleRunDirs(parent, holdStateOf, spareEntry);
  return parent;
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

  const parent = prepareRunDirParent(sourceCodexHome, PARENT_DIR_NAME);
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
      untrackHome(finalize);
    }
  };
  process.once("exit", finalize);
  trackHome(finalize);

  return { home, codexHome, finalize };
}
