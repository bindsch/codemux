/**
 * The aider session wiring: the per-turn spawn command over
 * `--restore-chat-history`, the honest capability matrix, and the
 * per-session history file codemux owns. Pure functions and file
 * mechanics only — all live state lives in the launcher-owned driver
 * (src/session/aider-driver.ts).
 *
 * aider has no session protocol at all: `--message` runs one exchange,
 * stdout is a human transcript (banner, git notices, summaries), and the
 * only machine-usable record of the exchange is the Markdown chat
 * history file (`#### ` user sections, `> ` tool blockquotes, the reply
 * after them — src/aider-history.ts). A session is therefore
 * turn-per-process with codemux-owned state: the session id is a
 * codemux-minted UUID (aider has none of its own), the history file
 * lives in a per-session directory under `~/.aider/.codemux/sessions/`,
 * and every turn runs `aider --chat-history-file <that file>
 * --restore-chat-history --message=<prompt>` — so what "state" means
 * here is aider's own chat history: the full user/assistant transcript
 * the next turn's prompt is rebuilt from, plus aider's own /undo and
 * summarization behavior on top of it, all carried by that one file.
 *
 * Wire facts pinned against the installed 0.86.2 (the adapter,
 * src/adapters/aider.ts, and its pinned flags): the headless negatives
 * ("n\n" × 64) must reach stdin because EOF means acceptance, the
 * prompt rides argv (`--message=`) so the run path's 32 KiB argv bound
 * applies per turn, and `--restore-chat-history` replays the file into
 * the model's context before the new exchange.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { aiderBaseFlags } from "../adapters/aider.js";
import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";
import type { SessionHold } from "./registry.js";

/** The session-only version floor (§4.3): 0.86.2, the audited build the
 * flag set (the pinned config/env/history files, --restore-chat-history,
 * --message) and the history-file format are pinned against. */
export const AIDER_SESSION_FLOOR = "0.86.2";

/** The id shape codemux mints for an aider session (a plain lowercase
 * UUID — aider has no native session id, so codemux owns the identity
 * and keys the per-session history directory by it). */
export const AIDER_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Capability flags for aider sessions (§3.4): live input yes (one caller
 * input, one aider process), everything else honestly no — there is no
 * steering or interrupt channel into a one-shot process, no permission
 * round-trip (the headless negatives decline every prompt), no deltas,
 * no file-change frames, no usage report at all (usage is all-null on
 * every event), and resume yes through the history file.
 */
export function aiderSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: false,
    steer: false,
    interrupt: false,
    permissions: false,
    deltas: false,
    file_changes: false,
    usage_stream: false,
    resume: true,
  };
}

/**
 * The session autonomy mapping, pinned here independently of the run
 * adapter's (the agy/opencode session modules' convention): the per-turn
 * processes carry the same flags `run` does, and a unit test pins the
 * two together so they cannot drift.
 */
export function aiderSessionAutonomyFlags(level: AutonomyLevel): string[] {
  switch (level) {
    case "read-only":
      return ["--dry-run"];
    case "low":
      return [];
    case "medium":
    case "high":
      return ["--yes-always"];
  }
}

export interface AiderSessionCommand {
  autonomy: AutonomyLevel;
  /** The `--model` value (already `openai/`-prefixed under a provider
   * override — the CLI owns that mapping). */
  model?: string;
  /** The `--weak-model` value: pinned to the same wire model under a
   * provider override, because aider's ChatSummary runs its summaries
   * through the weak model and must hit the overridden endpoint too;
   * undefined without one (aider picks its own default). */
  weakModel?: string;
  effort?: ReasoningEffort;
  /** The per-session chat history file every turn appends to. */
  historyPath: string;
  /** The turn's prompt (the `--message=` value, author prefix applied). */
  prompt: string;
}

/**
 * The per-turn spawn command: the shared headless flags with the session
 * history file, `--restore-chat-history` to replay it, then the run
 * adapter's flag order (model, weak model, autonomy, effort) and the
 * prompt as `--message=` — argv, so the run path's argv byte bound is
 * the per-turn cap the driver enforces before the ack.
 */
export function buildAiderSessionCommand(command: AiderSessionCommand): string[] {
  const argv = ["aider", ...aiderBaseFlags(command.historyPath)];
  argv.push("--restore-chat-history");
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  if (command.weakModel !== undefined) {
    argv.push("--weak-model", command.weakModel);
  }
  argv.push(...aiderSessionAutonomyFlags(command.autonomy));
  if (command.effort !== undefined) {
    argv.push("--reasoning-effort", command.effort);
  }
  argv.push(`--message=${command.prompt}`);
  return argv;
}

/** The per-session history file: `~/.aider/.codemux/sessions/<id>/
 * history.md` under the recorded harness home. The run path's per-run
 * files (`history-<pid>-…`) live one level up; this module's sweep only
 * ever matches the `<uuid>` directory names, so the two never touch. */
export function aiderSessionHistoryPath(
  harnessHome: string,
  sessionId: string
): string {
  return join(harnessHome, ".codemux", "sessions", sessionId, "history.md");
}

// A codemux that died without its end path leaves the directory behind;
// sessions can run for days, and the sweep only removes directories idle
// far longer than any session may last.
const STALE_SESSION_DIR_MS = 28 * 86_400_000;

/** The directory must be a real directory owned by the current user: the
 * sandboxed harness can write `~/.aider`, so a symlinked or foreign
 * session directory must never carry the history (the pattern
 * createAiderHistoryFile applies to its parent). */
function assertOwnedDirectory(path: string): void {
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

/** Every component of the history path's chain the sandboxed child can
 * replace, asserted with lstat: `~/.aider` is writable by the child, so
 * `.codemux` (and everything under it) could be
 * a planted symlink, and both `mkdirSync(recursive)` and a check of the
 * LAST component alone resolve that intermediate like any path operation
 * would — pointing the history directory's creation and the sweep's
 * recursive removal wherever the link names (review D4, security). The
 * harness home itself (`~/.aider`, an entry of `~`) is above the child's
 * write reach, so the chain starts inside it. With `absentOk`, a MISSING
 * component passes (nothing can sit at a name that does not exist yet);
 * a link is still refused — lstat sees the link itself, never its
 * target. */
function assertOwnedHistoryChain(historyPath: string, absentOk = false): void {
  const sessionDir = dirname(historyPath);
  const sessionsDir = dirname(sessionDir);
  for (const dir of [dirname(sessionsDir), sessionsDir, sessionDir]) {
    try {
      assertOwnedDirectory(dir);
    } catch (error) {
      if (!absentOk || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** The intermediates only, for the removal path: `rmSync` never follows a
 * link at the session directory's own name, but it resolves `.codemux`
 * and `sessions` like any path operation — those are the components a
 * planted link could aim (assertOwnedHistoryChain's rule without the
 * final component, so an absent session directory stays a no-op). */
function assertOwnedRemovalIntermediates(historyPath: string): void {
  const sessionsDir = dirname(dirname(historyPath));
  for (const dir of [dirname(sessionsDir), sessionsDir]) {
    assertOwnedDirectory(dir);
  }
}

/** The pre-turn trust check (review D7, security): the ownership chain and
 * the history file itself, re-verified before EVERY turn spawn. The two
 * existing checks — createAiderSessionHistory at session creation and
 * readAiderHistory's O_NOFOLLOW after each turn — left the between-turns
 * window open: a sandboxed child that can write `~/.aider` can replace the
 * history file with a symlink to a file outside its sandbox, and the next
 * turn's aider (running outside it, or reading into the model context)
 * would follow the link before codemux's own read ever ran. lstat refuses
 * a link (isFile is false for one), the file must be owned by the invoking
 * user, and the mode must still be 0600 — aider only ever APPENDS in place
 * (io.py append_chat_history opens with "a"), so a live session's file
 * never carries another mode and the check cannot false-positive. A
 * missing file or chain (ENOENT) throws too: the turn fails rather than
 * spawn against state codemux cannot see. Callers fail the TURN, not the
 * session (the operator's review-d7 rule). */
export function assertAiderHistoryForTurn(historyPath: string): void {
  assertOwnedHistoryChain(historyPath);
  const stat = lstatSync(historyPath);
  if (
    !stat.isFile() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stat.uid !== process.getuid()) ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      `${historyPath} must be a regular file owned by the current user with mode 0600`
    );
  }
}

/**
 * Create a fresh session's history file (an empty one — the first turn
 * writes the first exchange). Throws when the path already exists: the
 * session id is a codemux-minted UUID, so an existing file means the
 * mint collided and reusing it would splice two sessions' transcripts.
 * Stale session directories (codemux processes long dead, idle past any
 * session's lifetime) are swept first; only UUID-named directories are
 * ever considered, so nothing unexpected is removed. The owned chain
 * (`.codemux` down) is asserted before anything is written or swept: a
 * planted intermediate symlink must never aim either (review D4,
 * security). `holdStateOf` is
 * the registry-backed liveness skip: a session another codemux process
 * holds open is never swept however old its directory looks (review D2,
 * security 2), and a registry that cannot be read spares every
 * candidate — only a positive `free` answer may remove (review D5,
 * correctness 1).
 */
export function createAiderSessionHistory(
  historyPath: string,
  holdStateOf?: (id: string) => SessionHold
): void {
  const sessionDir = dirname(historyPath);
  // The pre-pass refuses a planted link BEFORE mkdirSync resolves it and
  // creates through it; the strict re-assert after covers a component
  // swapped while the mkdir ran.
  assertOwnedHistoryChain(historyPath, true);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  assertOwnedHistoryChain(historyPath);
  sweepStaleSessionDirs(dirname(sessionDir), holdStateOf);
  writeFileSync(historyPath, "", { mode: 0o600, flag: "wx" });
}

/** Remove a fresh session's history directory after its start record
 * failed (the CLI's failure path — nothing else points at the directory,
 * so leaving it would orphan it until the sweep). Revalidates the
 * intermediates' ownership exactly like the create path: the sandboxed
 * harness can write `~/.aider`, so a swapped `.codemux` must never aim
 * this recursive removal. An absent session directory is a no-op. */
export function removeAiderSessionHistory(historyPath: string): void {
  assertOwnedRemovalIntermediates(historyPath);
  rmSync(dirname(historyPath), { force: true, recursive: true });
}

/** One session directory's idle age: the history file's mtime when there
 * is one, the directory's own mtime otherwise. aider only ever APPENDS to
 * `history.md` in place, so the directory's mtime never moves after
 * creation (it changes only when an entry is created or removed) — aging
 * by it deleted live, recently-used sessions 28 days after their
 * creation (review D2, security 2 / correctness-2 1). The file is where
 * every turn and every resume lands, so its mtime is the session's real
 * last-use time; a directory with no readable history file is a crash
 * leftover the directory's own age covers. Null when neither stat
 * succeeds — leave the entry alone. */
function sessionDirAgeMs(sessionDir: string): number | null {
  try {
    return Date.now() - statSync(join(sessionDir, "history.md")).mtimeMs;
  } catch {
    try {
      return Date.now() - statSync(sessionDir).mtimeMs;
    } catch {
      return null;
    }
  }
}

/** Removes UUID-named session directories idle past any session's
 * lifetime, removing an id only when `holdStateOf` positively answers
 * `free` — `held` spares it however stale (a live session's state), and
 * so does `unknown` (an unreadable registry must not become a delete;
 * review D5, correctness 1). One bad entry must
 * not block the session or every later one: the entry stays, the sweep
 * moves on, and the operator learns why. */
function sweepStaleSessionDirs(
  sessionsDir: string,
  holdStateOf?: (id: string) => SessionHold
): void {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!AIDER_SESSION_ID_PATTERN.test(entry)) continue;
    if (holdStateOf !== undefined && holdStateOf(entry) !== "free") continue;
    const path = join(sessionsDir, entry);
    const age = sessionDirAgeMs(path);
    if (age === null || age < STALE_SESSION_DIR_MS) continue;
    try {
      rmSync(path, { force: true, recursive: true });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.error(`codemux: could not remove the stale aider session directory ${path}${detail}`);
    }
  }
}
