/**
 * The stale-directory sweep for private per-run parents inside a real
 * harness home (`.codemux-hermetic`, `.codemux-scratch`, `.codemux-provider`):
 * run directories left by codemux processes that no longer exist, stale
 * session homes, and the shape and ownership checks a run can trust. Split
 * from hermetic-home.ts; that module re-exports the public names so every
 * importer keeps one address.
 */

import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pidProbeAlive } from "./process-table.js";
import { sessionHoldState, sessionRegistryPath, type SessionHold } from "./session/registry.js";
import { assertTrustedParentUnchanged, recordTrustedParent, removeUnderTrustedParent, type TrustedParentRecord } from "./safe-remove.js";

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
 * a removal needs a positive reading, never an exhausted probe. Exported
 * for the opencode hermetic sweep (opencode-hermetic.ts), which ages its
 * homes by the same tree-newest rule (review round 341, item 6). */
export function newestMtimeMs(path: string): number | null {
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
 * leaves the entry alone. Exported beside newestMtimeMs for the opencode
 * hermetic sweep, whose dead-owner pid gate carries the same proof. */
export function directoryMtimeMs(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Removes run directories (`run-<pid>-<random>`) left behind by codemux
 * processes that no longer exist, once they are also stale (the age gate
 * above), stale session homes (`session-home-…` — the session gate
 * above, plus the liveness skip below), and stale Claude project-settings
 * session directories (`session-<uuid>`, the run age gate plus the same
 * liveness skip — claude-project-config.ts). All ages are the tree-newest
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
 * (review D5, correctness 1), and so does a name with no parseable
 * id — not a registry key, so no ownership proof exists (review
 * round 381). The default consults the machine's one
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
 * the provider settings, the aider session directories).
 *
 * Every removal also revalidates the parent's recorded identity first
 * (review round 292): the sweep enumerates and then removes, and a
 * writable parent swapped for a symlink in between would aim the
 * recursive rm through it — rm follows an intermediate component — into
 * a same-named directory outside codemux's storage tree. The shared
 * trusted-parent removal (src/safe-remove.ts) refuses and reports
 * instead. */
function removeSweepEntry(path: string, record: TrustedParentRecord, what: string): void {
  removeUnderTrustedParent(path, record, `the ${what} ${path}`);
}

function sweepStaleRunDirs(
  parent: string,
  record: TrustedParentRecord,
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
      if (pid === process.pid || pidProbeAlive(pid)) continue;
      // The walk's null must not spare a DEAD run forever: nothing owns
      // the tree anymore, so an over-budget walk falls back to the
      // directory's own mtime (review D9, correctness-2) and the crash
      // leftover goes by its own age.
      const newest = newestMtimeMs(path) ?? directoryMtimeMs(path);
      if (newest === null || Date.now() - newest < STALE_RUN_DIR_MS) continue;
      removeSweepEntry(path, record, "stale run directory");
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
      // pid-gate reorder's twin, review D10, correctness-2 2). A name
      // with no parseable id is not a registry key — no ownership proof
      // exists — so it keeps the same spare (review round 381: it used
      // to skip the consult and be removed by age alone).
      if (id === undefined || holdStateOf(id) !== "free") continue;
      const newest = newestMtimeMs(path);
      if (newest !== null && Date.now() - newest < STALE_SESSION_HOME_MS) continue;
      // An over-budget walk (null) falls back to the own mtime above —
      // already past the gate — for exactly the keyed homes with a
      // positive `free`: that answer is the ownership proof the run
      // branch's pid gate provides, so a home grown past the cap is
      // reclaimed by age instead of leaking and being re-walked to the
      // cap forever (review D10, correctness-2 2; the run branch's D9
      // twin). An unstatable directory keeps the spare, as does every
      // no-id entry above.
      if (newest === null && own === null) continue;
      removeSweepEntry(path, record, "stale session home");
      continue;
    }
    const sessionDirMatch =
      /^session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(entry);
    if (sessionDirMatch) {
      // A Claude project-settings SESSION directory (claude-project-config.ts):
      // keyed by a native claude session id, deliberately persistent across
      // commands until `--final` or this sweep. It carries the session's own
      // transcript, so the registry consult is the ownership proof — the run
      // branch's pid gate has no equivalent here — and the age gate is the
      // run directory's two days, not the 28-day session-home span: without
      // `--final` a closed session waits for a resume that may never come,
      // and two quiet days with no owning record is the same "owner gone"
      // proof a dead run's pid provides.
      const id = sessionDirMatch[1];
      const own = directoryMtimeMs(path);
      if (own !== null && Date.now() - own < STALE_RUN_DIR_MS) continue;
      // Only a POSITIVE `free` ever removes (the session-home rule): `held`
      // is a live owner, `unknown` an unreadable registry, and both spare
      // it. The id guard is the type's, not the regex's — one capture
      // group always captures — kept in the session-home branch's shape.
      if (id === undefined || holdStateOf(id) !== "free") continue;
      const newest = newestMtimeMs(path) ?? own;
      // Null (unstatable or over-budget) keeps the `own` fallback that
      // already passed the gate: `free` is the ownership proof, the run
      // branch's D9 rule under that proof.
      if (newest === null || Date.now() - newest < STALE_RUN_DIR_MS) continue;
      removeSweepEntry(path, record, "stale project-settings session directory");
      continue;
    }
    // Any other entry is not this sweep's to judge — never walked, never
    // removed (previously the walk ran on every entry, named or not).
  }
}

/**
 * Refuses a path that is not a real directory owned by the current user and
 * not writable by group or world (review round 331, item 6): a writable
 * `.codemux-hermetic`/`.codemux-scratch`/`.codemux-provider` parent lets
 * another user replace run-directory entries and redirect subsequent
 * credential and config writes. `prepareRunDirParent` applies this to a
 * parent at creation time; the `--output-last-message` reader applies it to
 * the per-run directory and that parent again at read time, because a run
 * with write access to ~/.codex could have swapped either for a symlink in
 * between, pointing a read or a delete through it into a directory codemux
 * never chose.
 */
export function assertTrustedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o022) !== 0)
  ) {
    throw new Error(
      `${path} must be a directory owned by the current user and not group- or world-writable`
    );
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
  // The parent's identity is recorded before the sweep runs, and every
  // removal the sweep makes revalidates it (removeSweepEntry, review
  // round 292): the enumeration and the removals are separate steps, so
  // a writable parent swapped in between must be caught at the removal.
  const record = recordTrustedParent(parent);
  sweepStaleRunDirs(parent, record, holdStateOf, spareEntry);
  // A parent the sweep found swapped kept its entries and reported; the
  // run must not create its home through the replacement either (review
  // round 295).
  assertTrustedParentUnchanged(record, "the run directory parent");
  return parent;
}
