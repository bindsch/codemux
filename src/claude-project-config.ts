/**
 * A private Claude Code config directory for one
 * `--experiment-project-settings` run.
 *
 * A live check (2026-10-30 10:59, zai, `--hermetic
 * --experiment-project-settings --auto low`) showed two defects in running
 * with `--setting-sources project,local` alone: Claude Code ignored the
 * fixture's allow rules ("Ignoring 1 permissions.allow entry from
 * .claude/settings.json: this workspace has not been trusted ... set
 * projects["<cwd>"].hasTrustDialogAccepted: true"), and the model quoted
 * the operator's user-level CLAUDE.md, which loads from the config
 * directory whatever --setting-sources says. Both are properties of the
 * config directory the binary resolves, so the run gets a fresh one.
 *
 * Every path below was verified against the installed bundle
 * (/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code, 2026-10-30).
 * Its config-dir getter is `CLAUDE_CONFIG_DIR ?? join(homedir(),
 * ".claude")` (minified `ve`); with the variable set, the binary reads:
 *   - global state from `<dir>/.claude.json` (minified `e9n`:
 *     `join(process.env.CLAUDE_CONFIG_DIR || <default>, ".claude.json")`;
 *     no filename suffix in prod), which holds `hasCompletedOnboarding`
 *     and the `projects[<canonical cwd>].hasTrustDialogAccepted` trust
 *     record the 10:59 run was missing;
 *   - credentials from `<dir>/.credentials.json`;
 *   - user memory from `<dir>/CLAUDE.md`, user settings from
 *     `<dir>/settings.json`, skills from `<dir>/skills`, plugins from
 *     `<dir>/plugins`, per-project state under `<dir>/projects`.
 * An empty directory therefore carries none of the operator's user-level
 * customizations, and a generated `.claude.json` both marks onboarding
 * complete and trusts the run's working directory, so the repository's
 * own settings apply.
 *
 * The directory is created per run under the real config root's
 * `.codemux-hermetic/` (hermetic-home.ts: scode keeps `~/.claude` writable
 * as harness state, and the parent sweep reclaims dead runs'
 * directories). It holds nothing but the generated `.claude.json` and, on
 * a run that authenticates through the operator's Claude login, an
 * access-token-only copy of the credential mirror (credentials.ts).
 * finalize removes the directory, the token copy with it. The operator's
 * own ~/.claude.json and ~/.claude/settings.json are never read for
 * content beyond the credential mirror and never written.
 *
 * A persistent session gets the same isolation with a different lifetime
 * (openProjectSettingsSessionConfigDir): the directory is keyed by the
 * native session id (`session-<uuid>`), created at the first command and
 * REUSED by every `--resume` of that session, because Claude Code keeps
 * its own transcript and per-project state under the config directory and
 * a resume must find them where the first command left them. Nothing
 * signal-tracks it: the directory outlives the process that created it,
 * `--final` removes it at session end, and the parent sweep reclaims one
 * whose registry entry is gone and whose tree has been quiet for two
 * days.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writePrivateFile } from "./private-write.js";
import type { SessionHold } from "./session/registry.js";
import {
  PARENT_DIR_NAME,
  RUN_PREFIX,
  assertTrustedDirectory,
  prepareRunDirParent,
} from "./hermetic-home.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import {
  recordTrustedParent,
  removeUnderTrustedParent,
  removeUnderTrustedParentOrThrow,
} from "./safe-remove.js";
export { copyClaudeCredentialMirror } from "./claude-credential-mirror.js";

export interface ClaudeProjectConfigDir {
  /** The private CLAUDE_CONFIG_DIR. */
  dir: string;
  /** The operator harness state scode must block around it: the real
   * config root and the `~/.claude.json` beside it (see
   * projectSettingsBlockedStatePaths), from the same environment that
   * placed this directory — so the block always names the tree this
   * directory was created under. */
  blockedPaths: readonly string[];
  /** Removes the directory, the credential copy with it. Idempotent. */
  finalize: () => void;
  /** When true, getRunEnv answers the environment WITHOUT copying the
   * credential mirror into the directory. The session flow sets it on
   * every environment build that runs before the resume claim (the
   * keep-env probe, --print-sandbox): a resume that never claims — it
   * lost the claim, or only printed — writes nothing into the session's
   * private directory (review round 3, edges finding on the claim
   * order). */
  deferCredentialCopy?: boolean;
}

/**
 * The config root these runs build under: the operator's default
 * `~/.claude`, where the credential mirror lives and which scode keeps
 * writable as harness state. A passed-through `CLAUDE_CONFIG_DIR` is
 * refused for these runs (claude-project-settings.ts) and the sanitizer
 * strips an ambient one from the child, so the default root is the one
 * tree every part of the run already agrees on.
 */
export function projectSettingsConfigRoot(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME || homedir();
  if (!home || !isAbsolute(home)) {
    throw new Error(
      "--experiment-project-settings needs an absolute HOME to place its private config directory"
    );
  }
  return join(home, ".claude");
}

/**
 * The operator harness-state paths a project-settings launch blocks in
 * scode: the real config root and the `~/.claude.json` beside it. The
 * config root holds the operator's user memory, settings, skills, hooks,
 * plugins, per-project transcripts, `history.jsonl` — and the private
 * directories of every other run and session — so the sandbox must make
 * it unreachable, read and write, even though the default profile
 * allows it as harness state. The run's own private directory is
 * re-allowed separately by the caller (an `--allow` after the blocks;
 * scode's final guards re-assert both), so the launch writes only its
 * own tree. `.claude.json` sits outside the root, so it needs its own
 * block.
 */
export function projectSettingsBlockedStatePaths(environment: NodeJS.ProcessEnv): readonly string[] {
  const root = projectSettingsConfigRoot(environment);
  return [root, join(dirname(root), ".claude.json")];
}

/**
 * The key Claude Code's global state uses for a working directory: the
 * realpath-resolved absolute path, NFC-normalized (the bundle's project
 * key is `NFC(realpath(cwd) ?? normalize(resolve(cwd)))`). The trust
 * record written into the generated `.claude.json` must use the same key
 * the binary will look up, or the workspace reads as untrusted again.
 */
export function claudeProjectKey(cwd: string): string {
  let absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // A working directory that does not exist fails the launch before
    // this runs; keep the resolved path for the caller that knows better.
  }
  // macOS realpath keeps decomposed Unicode while the bundle normalizes
  // its candidate paths to NFC.
  return absolute.normalize("NFC");
}

/**
 * The generated `<dir>/.claude.json`: onboarding complete and the working
 * directory trusted, nothing else. `hasCompletedOnboarding` is the one key
 * verified in the bundle to gate first-run prompts, and every other
 * global key the binary merges from its own defaults (its config factory
 * supplies theme, startup counters and the rest), so no other key is
 * needed to skip onboarding in `-p` mode. A `hasTrustDialogHooksAccepted`
 * key appears in this feature's design notes but not in the installed
 * bundle (0 hits), so it is deliberately absent.
 */
export function generatedGlobalState(projectKey: string): string {
  return JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [projectKey]: { hasTrustDialogAccepted: true } },
  });
}

/**
 * Creates the private config directory for one run. `cwd` is the run's
 * working directory, trusted by the generated state; `environment` is the
 * adapter's view, whose HOME places the directory.
 */
export function createProjectSettingsConfigDir(
  cwd: string,
  environment: NodeJS.ProcessEnv
): ClaudeProjectConfigDir {
  const root = projectSettingsConfigRoot(environment);
  const parent = prepareRunDirParent(root, PARENT_DIR_NAME);
  // Recorded for the finalizer's revalidation (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  // mkdtemp creates mode 0700; the files inside are written 0600.
  const dir = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // The parent is revalidated before the recursive removal, like every
    // removal the codex provider runs: a sandboxed child with write
    // access to the config root could have swapped the parent for a
    // symlink after this directory was made, and a recursive removal
    // resolves that component like any path operation would (review
    // round 15, edges 2; the shared rule is src/safe-remove.ts).
    if (!removeUnderTrustedParent(dir, parentRecord, `the private config directory ${dir}`)) {
      // Marked only after the removal succeeded, mirroring the session
      // variant's rule (below): a refused or failed removal stays
      // retryable, and the exit hook stays registered so the process's
      // exit gets a real second attempt instead of a no-op (review
      // round 14, edges 4). The directory (and its token copy)
      // otherwise persists only until the stale-directory sweep.
      return;
    }
    finalized = true;
    process.off("exit", finalize);
    untrackPrivateDir(finalize);
  };
  process.once("exit", finalize);
  trackPrivateDir(finalize);
  try {
    writePrivateFile(dir, ".claude.json", `${generatedGlobalState(claudeProjectKey(cwd))}\n`);
  } catch (error) {
    // Never leave a live (signal-tracked) directory behind a failed
    // launch; the caller has no context to clean up yet.
    finalize();
    throw error;
  }
  return { dir, blockedPaths: projectSettingsBlockedStatePaths(environment), finalize };
}

/** The entry name of a session's private config directory. The id is a
 * native Claude session id — a UUID, the shape the CLI's resume gate and
 * the sweep's parser both rely on. */
export const SESSION_DIR_PREFIX = "session-";

/** A claude-family session id, spelled the way the sweep parses it back
 * out of a directory name: lowercase hex UUID, the only spelling
 * randomUUID (which mints a fresh session's id) and the sweep's parser
 * both produce. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertSessionIdShape(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `the private config directory is keyed by the claude session id; '${sessionId}' is not a ` +
        "lowercase UUID (a fresh session's id is minted lowercase; retype or repaste the id)"
    );
  }
}

export function projectSettingsSessionDirName(sessionId: string): string {
  return `${SESSION_DIR_PREFIX}${sessionId}`;
}

/** The deterministic path of a session's private config directory under
 * the given config root, recomputed by every `--resume` of that session.
 * The id must be a lowercase UUID: the sweep keys its registry consult on
 * the name alone, so a directory whose name is not a registry key could
 * never be proven unowned and must never be created. */
export function projectSettingsSessionDirPath(configRoot: string, sessionId: string): string {
  assertSessionIdShape(sessionId);
  return join(configRoot, PARENT_DIR_NAME, projectSettingsSessionDirName(sessionId));
}

export interface ProjectSettingsSessionDir {
  /** The private CLAUDE_CONFIG_DIR, stable across every command of the session. */
  dir: string;
  /** The operator harness state scode must block around it (see
   * projectSettingsBlockedStatePaths), from the same environment that
   * resolved this directory. */
  blockedPaths: readonly string[];
  /** Removes the directory, the token copy with it — the session's
   * `--final` flag. Idempotent, and the only removal path: no exit hook,
   * no signal tracking, because the directory must survive the process
   * that created it for the next `--resume`. */
  remove: () => void;
}

/**
 * Creates (first command) or opens (`--resume`) the private config
 * directory of one `--experiment-project-settings` session. `cwd` is the
 * session's working directory, trusted by the generated state — the same
 * working directory every resume of the session runs in (the resume
 * guard pins it), so the first command's trust record still applies.
 *
 * A FRESH session gets a new `session-<uuid>` directory with the same
 * generated `.claude.json` a run gets. A RESUME opens the directory the
 * first command recorded — the harness's own transcript and project
 * state live under it now, so the state file is never rewritten, and a
 * directory that is missing (removed by `--final` or the stale sweep) or
 * not a trusted, user-owned directory (a swapped link) is refused, never
 * silently remade: a resume that minted a fresh directory would lose the
 * transcript it exists to continue.
 *
 * The parent sweep runs with this directory spared (the caller came for
 * it; the resume itself is the counter-claim to a `free` registry
 * answer), `holdStateOf` overriding the default registry for tests.
 */
export function openProjectSettingsSessionConfigDir(
  sessionId: string,
  resume: boolean,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  holdStateOf?: (id: string) => SessionHold
): ProjectSettingsSessionDir {
  const root = projectSettingsConfigRoot(environment);
  // Path first: it validates the id shape, so the sweep below can key its
  // registry consult on the name alone.
  const dir = projectSettingsSessionDirPath(root, sessionId);
  const parent = prepareRunDirParent(
    root,
    PARENT_DIR_NAME,
    holdStateOf,
    projectSettingsSessionDirName(sessionId)
  );
  // Recorded at open time for the removal's revalidation (src/safe-remove.ts,
  // review round 104): the lstat check this variant used caught a swapped
  // symlink but not another directory put at the same path, and the sandboxed
  // child of any earlier command of this session can write the parent.
  const parentRecord = recordTrustedParent(parent);
  if (resume) {
    if (!existsSync(dir)) {
      throw new Error(
        `session ${sessionId} has no private config directory at ${dir}: it was removed ` +
          "(--final or the stale sweep) and the session's transcript with it, so it cannot resume"
      );
    }
    // The sweep's own check, on the leaf: a link or a foreign-owned
    // directory must not become CLAUDE_CONFIG_DIR for a resumed child.
    assertTrustedDirectory(dir);
  } else {
    // A fresh UUID that lands on an existing entry is not this session's
    // to reuse: whatever is there belongs to something else (or someone
    // pre-created the name), and writing over it would hand the session a
    // directory whose contents it never chose.
    if (existsSync(dir)) {
      throw new Error(
        `the private config directory for session ${sessionId} already exists at ${dir}; ` +
          "refusing to reuse a directory this command did not create"
      );
    }
    mkdirSync(dir, { mode: 0o700 });
    try {
      writePrivateFile(dir, ".claude.json", `${generatedGlobalState(claudeProjectKey(cwd))}\n`);
    } catch (error) {
      // Unreferenced: remove it, parent revalidated first like every removal
      // here (round 30, contracts 1); the write error stays the one reported.
      removeUnderTrustedParent(dir, parentRecord, `the project-settings directory ${dir}`);
      throw error;
    }
  }
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    // The parent is revalidated first by the record's identity, like the
    // run-path finalize above (and every codex-provider removal): a parent
    // swapped for a symlink or replaced by another directory must refuse
    // the removal instead of resolving the path elsewhere (review round 15,
    // edges 2; the shared rule is src/safe-remove.ts).
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the project-settings directory ${dir}`);
    // Marked only after the removal succeeded: a failed removal stays
    // retryable, so the caller's next attempt gets a real second try
    // instead of a no-op (review round 11, contracts-2 4).
    removed = true;
  };
  return { dir, blockedPaths: projectSettingsBlockedStatePaths(environment), remove };
}

/**
 * The run environment of an `--experiment-project-settings` launch: the
 * private config directory as `CLAUDE_CONFIG_DIR`. Adapter-provided names
 * survive the sanitizer and ride scode's scrub exemption, so neither the
 * ambient environment nor a stripped launch can displace the private
 * directory. Fails closed when the launch was never prepared, the same
 * guarantee codex's hermetic home makes at its getRunEnv.
 */
export function projectSettingsRunEnv(
  configDir: ClaudeProjectConfigDir | undefined
): { CLAUDE_CONFIG_DIR: string } {
  if (configDir === undefined) {
    throw new Error("--experiment-project-settings run was not prepared before launch");
  }
  return { CLAUDE_CONFIG_DIR: configDir.dir };
}
