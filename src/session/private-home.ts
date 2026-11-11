/**
 * The per-session private home a hermetic session gives its harness
 * (private-home-types.ts holds the contract): one directory under the
 * brand home's `.codemux-hermetic`, keyed by the session id, persistent
 * across turns and `--resume`, removed by `--final` or the two-day
 * dead-owner sweep. Every hermetic session agent shares this lifecycle;
 * only the parent directory, the id shape, and the populate callback
 * differ, and those are the parameters below.
 *
 * Lifetime, in full: a FRESH session whose id is already known (the
 * claude family mints its id before anything spawns) creates
 * `session-<id>` directly — the settled name, no intermediate. A fresh
 * session that learns its id from the harness (codex, kimi, agy) starts
 * on the run-shaped `run-<pid>-<random>` name — so a codemux that dies
 * mid-session leaves it to the same stale sweep a dead run gets — and
 * `settle(id)` renames it onto `session-<id>` at the first resume hint;
 * `dir` and `remove` follow the rename. A RESUME opens `session-<id>`:
 * missing is an error (the CLI answers policy, exit 78 — the transcript
 * the directory exists to carry would be gone), a swapped link is
 * refused (assertTrustedDirectory), and nothing inside is ever
 * rewritten. `remove()` is one attempt: it throws the reason when the
 * removal is refused or fails and answers true once the directory is
 * gone — idempotent after success, otherwise retryable. The `--final`
 * end path calls it twice (driver.ts); an abandoned fresh home once.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertTrustedDirectory, prepareRunDirParent } from "../hermetic-home.js";
import { runDirectoryPrefix } from "../run-directory-owner.js";
import type { SessionHold } from "./registry.js";
import { assertDirectChildPath, assertTrustedParentUnchanged, recordTrustedParent, removeUnderTrustedParentOrThrow } from "../safe-remove.js";
import { SAFE_SESSION_ID_PATTERN } from "./id-pattern.js";
import { sessionKeyedHomePath } from "./private-home-key.js";
import type { TrustedParentRecord } from "../safe-remove.js";
import type { SessionPrivateHome } from "./private-home-types.js";

/** Everything `openSessionPrivateHome` needs. */
export interface SessionPrivateHomeOpen {
  printOnly?: boolean;
  /** The parent directory the home lives under — the agent's brand home
   * plus `.codemux-hermetic` (for example the claude family's
   * `<~/.claude>/.codemux-hermetic`). Created when missing, swept of
   * stale run and session directories (hermetic-sweep.ts), and
   * identity-checked, all through prepareRunDirParent. */
  parent: string;
  /** The session id, when it is known before the spawn: the home is
   * created settled (`session-<id>`) and `settle` is a no-op from the
   * start. Omitted when the harness mints the id later; `settle(id)`
   * renames the run-shaped home onto the keyed name then. */
  sessionId?: string;
  /** True when this open is a `--resume`: the keyed directory must
   * already exist; false creates it. */
  resume: boolean;
  /** The id shape this agent's session ids take (SESSION_AGENTS'
   * resumePattern). Validated before any path is built, so a directory
   * name is always a shape the sweep can key a registry consult on. */
  idPattern: RegExp;
  /** Real state paths scode must block while the private home itself is
   * re-allowed (for the claude family, the real config root and the
   * `~/.claude.json` beside it). Reported on the returned record for
   * the launcher's sandbox options. */
  blockedPaths: readonly string[];
  /** Runs once inside a fresh home, after it exists: the adapter's own
   * initial content (the claude family writes its generated
   * `.claude.json`). A throw removes the fresh home and rethrows, so a
   * failed populate never leaves an orphan. Never called on a resume. */
  populate?: (dir: string) => void;
  /** Overrides the registry the sweep consults, for tests. */
  holdStateOf?: (id: string) => SessionHold;
}

/** The entry name of a settled home. */
const SESSION_DIR_PREFIX = "session-";

function sessionDirName(sessionId: string): string {
  return `${SESSION_DIR_PREFIX}${sessionId}`;
}

function assertIdShape(open: SessionPrivateHomeOpen, sessionId: string): void {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId) || !open.idPattern.test(sessionId)) {
    throw new Error(
      `a session private home is keyed by the session id; '${sessionId}' does not match ` +
        "the id shape this agent's sessions resume by"
    );
  }
}

/** The shared removal: one attempt over the home's current path. A
 * refused or failed attempt throws the reason (retryable); success is
 * remembered so later calls answer true without touching the disk. The
 * parent's recorded identity is revalidated first (src/safe-remove.ts). */
function remover(pathOf: () => string, parentRecord: TrustedParentRecord): () => boolean {
  let removed = false;
  return (): boolean => {
    if (removed) return true;
    const dir = pathOf();
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the private home ${dir}`);
    removed = true;
    return true;
  };
}

/** Populate a fresh home; a populate throw removes the unreferenced
 * home (parent revalidated) and rethrows, keeping the write error the
 * reported one. */
function populateOrRemove(
  open: SessionPrivateHomeOpen,
  dir: string,
  parentRecord: TrustedParentRecord
): void {
  if (open.populate === undefined) return;
  try {
    checkedChild(dir, parentRecord);
    assertTrustedDirectory(dir);
    open.populate(dir);
  } catch (error) {
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the private home ${dir}`);
    throw error;
  }
}

/** Recheck containment and parent identity before each child operation. */
function checkedChild(path: string, record: TrustedParentRecord): string {
  assertDirectChildPath(path, record.path);
  assertTrustedParentUnchanged(record, "the private home parent");
  return path;
}

/** The refusal a fresh open reads when its keyed name is taken:
 * whatever sits there is not this session's to reuse. */
function refuseExisting(kind: string, sessionId: string, target: string): Error {
  return new Error(
    `the private home for ${kind} ${sessionId} already exists at ${target}; ` +
      "refusing to reuse a directory this command did not create"
  );
}

/** Real resumes and previews require the same surviving transcript home. */
export function assertResumableHome(dir: string, sessionId: string): void {
  if (!existsSync(dir)) {
    throw new Error(
      `session ${sessionId} has no private home at ${dir}: it was removed (--final or ` +
        "the stale sweep) and the session's transcript with it, so it cannot resume"
    );
  }
  // Match prepareRunDirParent's trust check without creating or sweeping.
  assertTrustedDirectory(dirname(dir));
  assertTrustedDirectory(dir);
}

/**
 * Creates (first command) or opens (`--resume`) one hermetic session's
 * private home. See the module comment for the full lifetime; the sweep
 * runs with this session's entry spared, `holdStateOf` overriding the
 * default registry for tests. The parent's identity is recorded at open
 * time and every removal revalidates it (src/safe-remove.ts).
 */
export function openSessionPrivateHome(open: SessionPrivateHomeOpen): SessionPrivateHome {
  const knownId = open.sessionId;
  if (knownId !== undefined) assertIdShape(open, knownId);
  if (open.printOnly) {
    if (open.resume && knownId === undefined) throw new Error("a resumed hermetic session requires its recorded session id");
    const dir = join(open.parent, knownId === undefined ? "preview" : sessionDirName(knownId));
    if (open.resume) assertResumableHome(dir, knownId!);
    return { dir, resumed: open.resume, settled: knownId !== undefined, blockedPaths: open.blockedPaths,
      settle: () => {}, remove: () => true };
  }
  // The sweep must spare the entry this caller came for (or is about to
  // create) even past its age gate: the resume itself is the
  // counter-claim to a `free` registry answer (hermetic-sweep.ts). A
  // run-shaped fresh home needs no spare — the pid gate of its own
  // branch answers for a live process.
  const spareEntry = knownId !== undefined ? sessionDirName(knownId) : undefined;
  const parent = prepareRunDirParent(
    dirname(open.parent),
    basename(open.parent),
    open.holdStateOf,
    spareEntry
  );
  const parentRecord: TrustedParentRecord = recordTrustedParent(parent);

  if (open.resume) {
    // A resume never mints: the directory the first command recorded is
    // the one whose transcript --resume exists to continue. Missing or
    // swapped is refused, never silently remade.
    if (knownId === undefined) {
      throw new Error(
        "a resumed hermetic session must be opened with its recorded session id"
      );
    }
    const dir = sessionKeyedHomePath(parent, knownId);
    assertResumableHome(checkedChild(dir, parentRecord), knownId);
    return {
      dir,
      resumed: true,
      settled: true,
      settle: () => {},
      remove: remover(() => dir, parentRecord),
      blockedPaths: open.blockedPaths,
    };
  }

  if (knownId !== undefined) {
    // The id is known before the spawn: create the settled name at once.
    const dir = sessionKeyedHomePath(parent, knownId);
    if (existsSync(checkedChild(dir, parentRecord))) {
      throw refuseExisting("session", knownId, dir);
    }
    mkdirSync(checkedChild(dir, parentRecord), { mode: 0o700 });
    // Stated whatever the umask is (prepareRunDirParent's rule): a
    // narrower creation mode would refuse the harness's own writes.
    assertTrustedDirectory(checkedChild(dir, parentRecord));
    chmodSync(checkedChild(dir, parentRecord), 0o700);
    populateOrRemove(open, dir, parentRecord);
    return {
      dir,
      resumed: false,
      settled: true,
      settle: () => {},
      remove: remover(() => dir, parentRecord),
      blockedPaths: open.blockedPaths,
    };
  }

  // The id arrives with the harness's first output: start run-shaped
  // (the dead-run sweep's shape), settle on the hint. `dir` and
  // `remove` follow the rename, so a settled home reports and removes
  // the path it actually sits on.
  const runShaped = mkdtempSync(checkedChild(join(parent, runDirectoryPrefix()), parentRecord));
  // mkdtemp answers 0700; the mode is stated so a wider umask cannot
  // leave the home narrower than that.
  assertTrustedDirectory(checkedChild(runShaped, parentRecord));
  chmodSync(checkedChild(runShaped, parentRecord), 0o700);
  populateOrRemove(open, runShaped, parentRecord);
  let currentPath = runShaped;
  let settled = false;
  return {
    get dir(): string {
      return currentPath;
    },
    resumed: false,
    get settled(): boolean {
      return settled;
    },
    settle(sessionId: string): void {
      // Idempotent: the rename happens on the first hint only.
      if (settled) return;
      assertIdShape(open, sessionId);
      const target = sessionKeyedHomePath(parent, sessionId);
      if (existsSync(checkedChild(target, parentRecord))) {
        throw refuseExisting("session", sessionId, target);
      }
      assertTrustedDirectory(checkedChild(currentPath, parentRecord));
      renameSync(checkedChild(currentPath, parentRecord), checkedChild(target, parentRecord));
      currentPath = target;
      settled = true;
    },
    remove: remover(() => currentPath, parentRecord),
    blockedPaths: open.blockedPaths,
  };
}
