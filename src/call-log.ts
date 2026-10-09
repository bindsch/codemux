/**
 * The per-call usage ledger: one JSON line per completed harness call,
 * appended to `<state dir>/codemux/calls.jsonl`. The state directory follows
 * the session registry's platform rule (src/session/registry.ts), so both
 * files sit side by side under the same root. `CODEMUX_CALL_LOG=<absolute
 * path>` relocates the file (a relative value resolves against the working
 * directory); `CODEMUX_CALL_LOG=off` disables it. `CODEMUX_TEST_LEDGER=<path>`
 * redirects appends when codemux's own test preload sets it
 * (tests/setup.ts); it is consulted only when `CODEMUX_CALL_LOG` is unset, so
 * an operator's explicit relocation or `off` always keeps its word, and a
 * generic variable such as `NODE_ENV` never diverts records — a process
 * outside codemux's test runner that happens to set one keeps its real
 * ledger (appendLedgerPath).
 *
 * Records are appended with one `write` of one line on an `O_APPEND`
 * descriptor, so concurrent codemux processes never interleave half-lines.
 * The file is created 0600 and tightened when it arrives with wider
 * permissions, and the append opens it without following a final symlink
 * (O_NOFOLLOW) and only after fstat confirms a regular file on the open
 * descriptor itself — a planted link or device is refused, never written
 * through. The directory is created 0700, but tightening an existing
 * directory is scoped to the default state directory alone: a directory
 * the operator named through `CODEMUX_CALL_LOG` — the working directory,
 * `$HOME`, `/tmp` — keeps the permissions it has (chmod on a shared
 * directory fails with EPERM, and a directory swapped for a symlink must
 * not be chmod'd through its link; `lstat` guards both), and a failure to
 * tighten never stops the append. A ledger failure never fails the run:
 * the first failure warns on stderr, later ones stay silent. Nothing here
 * writes to stdout — `run`'s stdout contract is the model's final message
 * and nothing else.
 *
 * Secrets never reach the file: no prompt text, no API keys, and the
 * provider field is an override's base URL host, never its key or query.
 * Terminal controls never reach it either: harness-reported strings are
 * stored stripped of ANSI escape sequences and C0/C1 control characters
 * (sanitizeReportedString), so a view cannot replay them into the
 * operator's terminal.
 */

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentId, AutonomyLevel, ResultUsageBlock } from "./types.js";

export const CALL_LOG_ENV = "CODEMUX_CALL_LOG";
/** The test-run ledger redirect codemux's own test preload sets; a name
 * codemux owns end to end, never a generic variable another process may
 * set for its own reasons (review ul4). */
export const CALL_LOG_TEST_ENV = "CODEMUX_TEST_LEDGER";
const CALL_LOG_BASENAME = "calls.jsonl";
/** Reads never look beyond the log's last 16 MiB. */
export const MAX_CALL_LOG_BYTES = 16 * 1024 * 1024;

/** One JSONL record: one finished harness call. `ts` marks the start of the
 * call, turn, or session; `duration_ms` carries the wall time from there.
 * Fields that do not apply to a kind are null, not absent, so every line
 * has the same shape. `usage` is the envelope's block exactly as
 * `ResultUsageBlock` defines it — every field null when the harness did not
 * report it, never guessed. */
export interface CallRecord {
  ts: string;
  kind: "run" | "check" | "session_turn" | "session";
  agent: AgentId;
  /** The model the caller requested; null when none was named. */
  model: string | null;
  /** The model the harness says served the call; null when unreported. */
  model_effective: string | null;
  /** "default", or the host of a provider override's base URL. */
  provider: string;
  session_id: string | null;
  turn_id: string | null;
  autonomy: AutonomyLevel | null;
  hermetic: boolean;
  sandboxed: boolean;
  exit_code: number | null;
  /** How a turn or session ended ("end", "interrupted", "failed", or a
   * session's end reason); null for run/check records. */
  finish: string | null;
  duration_ms: number;
  cwd: string;
  usage: ResultUsageBlock;
}

/** "default", or the host of a provider override's base URL — the identity
 * of the endpoint, never its key, path, or query. */
export function providerHost(baseUrl: string | null): string {
  if (baseUrl === null) return "default";
  try {
    return new URL(baseUrl).host;
  } catch {
    return "default";
  }
}

// ANSI escape sequences first (ESC [ … final byte, and the two-byte ESC
// forms): their bodies are printable, so stripping controls first would
// leave the sequence's residue behind as garbage text.
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// Then every remaining control character: C0 (including newline and tab),
// DEL, and the C1 range U+0080-U+009F.
const CONTROL_PATTERN = /[\x00-\x1f\x7f\u0080-\u009f]/g;

/** Strips ANSI escape sequences and C0/C1 control characters from a
 * harness-reported string — a model name, a provider host, a finish
 * reason — before it is stored, and again before `calls` prints it
 * (calls-command.ts). A string an endpoint reported can carry terminal
 * controls; a ledger that stored them would replay them into the
 * operator's terminal on every view (review ul6). Null passes through
 * unchanged. */
export function sanitizeReportedString(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/**
 * Where the ledger lives: `$CODEMUX_CALL_LOG` when set ("off" disables it
 * entirely; a relative value resolves against the working directory), else
 * `calls.jsonl` in the same state directory the session registry uses —
 * `~/Library/Application Support/codemux/` on macOS and
 * `~/.local/state/codemux/` elsewhere, derived from `$HOME` alone so the
 * file tracks the home the rest of codemux's state does. `$XDG_STATE_HOME`
 * is deliberately not read (the registry's own rule): the record must not
 * move when that variable does. Returns null when the ledger is disabled.
 */
export function callLogPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const override = environment[CALL_LOG_ENV]?.trim();
  if (override === "off") return null;
  if (override !== undefined && override !== "") return resolve(override);
  return join(defaultStateDir(environment, platform), CALL_LOG_BASENAME);
}

/** The default state directory the ledger shares with the session
 * registry (src/session/registry.ts): `$HOME`-derived on every platform,
 * never `$XDG_STATE_HOME`. This names the one existing directory the
 * append may tighten; every other directory is the operator's. */
function defaultStateDir(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  const home = environment.HOME?.trim() || homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "codemux");
  }
  return join(home, ".local", "state", "codemux");
}

// A run must never fail because the ledger could not be written; the
// operator hears about the first failure only.
let warnedAboutLog = false;

/** Resets the warn-once state so tests can exercise repeated failures. */
export function resetCallLogWarningForTests(): void {
  warnedAboutLog = false;
}

/**
 * The path an append actually writes. `CODEMUX_CALL_LOG` keeps its word
 * exactly as given ("off" disables, a value relocates); with it unset,
 * `CODEMUX_TEST_LEDGER` — the redirect codemux's own test preload sets —
 * wins over the default (review ul4: the test mode is scoped to the
 * preload's explicit env var, never a generic variable another process
 * may set, so an operator's `NODE_ENV=test` process keeps its real
 * ledger). `callLogPath` — what `codemux calls` reads and the README
 * documents — keeps naming the real location either way.
 */
export function appendLedgerPath(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const override = environment[CALL_LOG_ENV]?.trim();
  if (override === "off") return null;
  if (override !== undefined && override !== "") return callLogPath(environment);
  const testLedger = environment[CALL_LOG_TEST_ENV]?.trim();
  if (testLedger !== undefined && testLedger !== "") return resolve(testLedger);
  return callLogPath(environment);
}

/**
 * Appends one record as a single JSON line. Never throws: path resolution
 * included, everything that can fail sits inside the guard — a failure is
 * reported on stderr once per process and the run proceeds (review ul4).
 */
export function appendCallRecord(
  record: CallRecord,
  environment: NodeJS.ProcessEnv = process.env
): void {
  let path: string | null = null;
  try {
    path = appendLedgerPath(environment);
    if (path === null) return;
    // Harness-reported strings are cleaned at this seam, the only writer:
    // model names, the provider host, and finish reasons arrive from an
    // endpoint codemux did not choose (a provider override serves any
    // model string it likes), and what is stored is what every later
    // reader gets (review ul6).
    record = {
      ...record,
      model: sanitizeReportedString(record.model),
      model_effective: sanitizeReportedString(record.model_effective),
      provider: sanitizeReportedString(record.provider) || "default",
      finish: sanitizeReportedString(record.finish),
    };
    const dir = dirname(path);
    // Whether mkdirSync is about to create the directory decides if
    // codemux may tighten it: an existing path — a symlink included —
    // belongs to the operator unless it is the default state directory.
    let dirExisted = true;
    try {
      lstatSync(dir);
    } catch {
      dirExisted = false;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    tightenDirectory(dir, !dirExisted || dir === defaultStateDir(environment, process.platform));
    const line = `${JSON.stringify(record)}\n`;
    // One write of one line on an O_APPEND descriptor: concurrent appends
    // cannot interleave, because the kernel places each whole write at the
    // file's end atomically. A planted symlink or a device where the
    // ledger should be is a misconfiguration, not a channel: the open
    // itself refuses to follow a final symlink (O_NOFOLLOW) or block on a
    // special file (O_NONBLOCK — a FIFO with no reader fails ENXIO), and
    // fstat on the OPEN DESCRIPTOR — not the path, which a race could swap
    // after any path-based check — confirms a regular file before anything
    // is written (review ul5: the check-then-open window is gone).
    const noFollowFlag = process.platform !== "win32" ? constants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
          constants.O_NONBLOCK | noFollowFlag,
        0o600
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENXIO") {
        warnOnce(
          `codemux: refusing to write the call log at ${path}: it is not a regular file`
        );
        return;
      }
      throw error;
    }
    try {
      if (!fstatSync(fd).isFile()) {
        warnOnce(
          `codemux: refusing to write the call log at ${path}: it is not a regular file`
        );
        return;
      }
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    // Creation applies the restrictive mode; an existing file that arrived
    // with group or other access is tightened instead. tightenFile lstats
    // the path and chmods a regular file only, so a link swapped in after
    // the write is never chmod'd through — and a tightening failure never
    // undoes the appended record.
    tightenFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnOnce(
      path === null
        ? `codemux: could not append to the call log: ${message}`
        : `codemux: could not append to the call log at ${path}: ${message}`
    );
  }
}

function warnOnce(message: string): void {
  if (warnedAboutLog) return;
  warnedAboutLog = true;
  console.error(message);
}

/** Tightens one directory codemux owns: one this append just created, or
 * the default state directory. `lstat` refuses a symlink (chmod through a
 * swapped link would strip permissions from the link's target) and any
 * failure is swallowed — the append that follows must proceed even where
 * chmod cannot succeed (a shared directory such as /tmp, review ul2). */
function tightenDirectory(path: string, owned: boolean): void {
  if (!owned) return;
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return;
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) chmodSync(path, mode & ~0o077);
  } catch {
    // Tightening is hygiene; the append below proceeds regardless.
  }
}

/** Same rule for the file: lstat first, and a failure to tighten never
 * reaches the caller — the record is already appended by the time this
 * runs. */
function tightenFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return;
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) chmodSync(path, mode & ~0o077);
  } catch {
    // The record is already on disk; loose file permissions are the
    // operator's to fix, not a reason to warn or fail.
  }
}

/** One JSONL line from the ledger, parsed or not. */
export interface CallLogEntry {
  /** The raw line as it appears in the file. */
  line: string;
  /** The parsed record, or null when the line is not one. */
  record: CallRecord | null;
}

export interface CallLogContents {
  /** Entries in file order (oldest first). */
  entries: CallLogEntry[];
  /** Lines that did not parse as call records. */
  malformed: number;
  /** True when only the last 16 MiB was read because the file is larger. */
  truncated: boolean;
}

const CALL_RECORD_KINDS: ReadonlySet<string> = new Set([
  "run",
  "check",
  "session_turn",
  "session",
]);

function isCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/** The full flat shape, not a lenient three-field check: a line that
 * parses as JSON and names `ts`/`agent`/`kind` but misses `usage` (or
 * carries a wrong-typed field) is not a record, and every consumer that
 * trusts the shape — the table's columns, the totals — would crash on
 * the missing half (review ul2). Wrong-shaped lines are malformed like
 * unparseable ones: skipped and counted, never fatal. */
function isCallRecord(parsed: unknown): parsed is CallRecord {
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (typeof record["ts"] !== "string") return false;
  if (
    typeof record["kind"] !== "string" ||
    !CALL_RECORD_KINDS.has(record["kind"])
  ) {
    return false;
  }
  if (typeof record["agent"] !== "string") return false;
  if (!isStringOrNull(record["model"])) return false;
  if (!isStringOrNull(record["model_effective"])) return false;
  if (typeof record["provider"] !== "string") return false;
  if (!isStringOrNull(record["session_id"])) return false;
  if (!isStringOrNull(record["turn_id"])) return false;
  if (!isStringOrNull(record["finish"])) return false;
  if (!isStringOrNull(record["autonomy"])) return false;
  if (typeof record["hermetic"] !== "boolean") return false;
  if (typeof record["sandboxed"] !== "boolean") return false;
  if (!isCount(record["exit_code"])) return false;
  if (
    typeof record["duration_ms"] !== "number" ||
    !Number.isFinite(record["duration_ms"]) ||
    record["duration_ms"] < 0
  ) {
    return false;
  }
  if (typeof record["cwd"] !== "string") return false;
  const usage = record["usage"];
  if (typeof usage !== "object" || usage === null) return false;
  const counts = usage as Record<string, unknown>;
  return (
    isCount(counts["input_tokens"]) &&
    isCount(counts["output_tokens"]) &&
    isCount(counts["cached_input_tokens"]) &&
    isCount(counts["total_tokens"]) &&
    isCount(counts["cost_usd"])
  );
}

/**
 * Reads the ledger, bounded to its last 16 MiB (the tail is the newest
 * data, and a multi-gigabyte ledger must not be loaded whole). A window
 * that starts mid-line drops the partial line the cut made; one that
 * starts exactly on a record boundary keeps the complete record there —
 * no complete record is ever dropped for the bound (review ul6). Lines are
 * paired with their parsed record so a caller can show raw lines
 * (`calls --json`) and parsed fields from the same pass; a line that does
 * not parse, or parses to something without the record's shape, is
 * skipped and counted, never fatal. Throws on read errors
 * (absent file, not a regular file); callers report those. Invalid UTF-8
 * is not one of them: the bytes decode with replacement characters, so
 * the affected lines simply land in `malformed`.
 */
export function readCallLog(path: string): CallLogContents {
  const size = statSync(path).size;
  let text: string;
  let truncated = false;
  if (size <= MAX_CALL_LOG_BYTES) {
    text = readFileSync(path, "utf8");
  } else {
    const cut = size - MAX_CALL_LOG_BYTES;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_CALL_LOG_BYTES);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, cut + read);
        if (n === 0) break;
        read += n;
      }
      text = buffer.toString("utf8");
      // The read may have started mid-line, in which case the window's
      // first line is the one the bounded read cut and is dropped. But the
      // byte BEFORE the cut decides that, not an unconditional drop: a cut
      // landing exactly on a record boundary (that byte a newline) leaves
      // a complete record at the front of the window, and dropping through
      // the first newline anyway discarded it (review ul6).
      const prelude = Buffer.alloc(1);
      const n = readSync(fd, prelude, 0, 1, cut - 1);
      if (n !== 1 || prelude[0] !== 0x0a) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
      }
    } finally {
      closeSync(fd);
    }
    truncated = true;
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const entries: CallLogEntry[] = [];
  let malformed = 0;
  for (const line of lines) {
    let record: CallRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isCallRecord(parsed)) record = parsed;
    } catch {
      // A hand-edited or truncated line; counted below.
    }
    if (record === null) malformed++;
    entries.push({ line, record });
  }
  return { entries, malformed, truncated };
}

/** The fields every session-side record shares: what the driver knows about
 * its own launch. `provider` is `providerHost(options.providerBaseUrl)`.
 * `hermetic` is what the driver was constructed with: the session CLI
 * refuses `--hermetic` outright in this release (src/session/cli.ts — no
 * verified canary covers a persistent, resumable session), so every
 * CLI-launched record carries false; the opencode and aider drivers forward
 * their option all the same, and the claude-family, codex, and agy drivers
 * hard-code false because their session launches have no hermetic mode. */
export interface SessionCallContext {
  agent: AgentId;
  model: string | null;
  provider: string;
  autonomy: AutonomyLevel | null;
  hermetic: boolean;
  sandboxed: boolean;
  cwd: string;
}

/** One line per completed session turn, emitted where the driver emits its
 * `turn_completed` event so the ledger and the event stream cannot disagree
 * about what completed. */
export function appendSessionTurnCallRecord(
  context: SessionCallContext,
  sessionId: string,
  turnId: string,
  startedAtMs: number,
  finish: string,
  usage: ResultUsageBlock,
  environment: NodeJS.ProcessEnv = process.env
): void {
  appendCallRecord({
    ts: new Date(startedAtMs).toISOString(),
    kind: "session_turn",
    agent: context.agent,
    model: context.model,
    model_effective: null,
    provider: context.provider,
    session_id: sessionId,
    turn_id: turnId,
    autonomy: context.autonomy,
    hermetic: context.hermetic,
    sandboxed: context.sandboxed,
    exit_code: null,
    finish,
    duration_ms: Math.max(0, Date.now() - startedAtMs),
    cwd: context.cwd,
    usage,
  }, environment);
}

/** The one closing line per session, carrying the cumulative usage the
 * driver already folds for `session_ended`. */
export function appendSessionCallRecord(
  context: SessionCallContext,
  sessionId: string,
  startedAtMs: number,
  finish: string,
  exitCode: number | null,
  usage: ResultUsageBlock,
  environment: NodeJS.ProcessEnv = process.env
): void {
  appendCallRecord({
    ts: new Date(startedAtMs).toISOString(),
    kind: "session",
    agent: context.agent,
    model: context.model,
    model_effective: null,
    provider: context.provider,
    session_id: sessionId,
    turn_id: null,
    autonomy: context.autonomy,
    hermetic: context.hermetic,
    sandboxed: context.sandboxed,
    exit_code: exitCode,
    finish,
    duration_ms: Math.max(0, Date.now() - startedAtMs),
    cwd: context.cwd,
    usage,
  }, environment);
}
