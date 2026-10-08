/**
 * The chat history files behind aider's answer extraction, on two
 * surfaces. On the run path the file is the `--hermetic` check's answer
 * source, and that check is refused for now (aider's own config layers
 * have no switch; docs/HERMETIC.md), so no reachable run reads or
 * creates one — the machinery stays for the day that changes, and a
 * hermetic run would still record its reply here instead of leaving
 * state on the adapter. Plain runs keep /dev/null (h6 review): nothing
 * run-side reads their history, and writing it would persist the whole
 * conversation on disk — 0600, and removed at exit, but on disk — for
 * nothing. On the session path the extraction is live: the aider
 * session driver reads the history every turn
 * (src/session/aider-driver.ts), anchoring each turn's reply past the
 * header block this module builds, and every session owns a persistent
 * per-session history file (`~/.aider/.codemux/sessions/<id>/`,
 * src/session/aider-session.ts) — created non-hermetic, deliberately
 * kept as the resume state, never removed at exit.
 *
 * Aider's stdout in `--message` mode is a transcript, not a reply: the
 * announcement banner ("Aider v0.86.2", model line), git notices ("Git
 * repository created in …", `main.py` at 0.86.2) and per-exchange summaries
 * print around the model's answer, so the hermetic check's exact-OK test
 * cannot run on raw stdout. The chat history file carries the exchange in
 * Markdown instead: the user turn is written as an `#### ` section
 * (`io.user_input`), tool chatter as `> ` blockquotes (`io.tool_output`),
 * and the model's answer verbatim after it (`io.ai_output`,
 * `io.append_chat_history` at 0.86.2) — so the answer is the bare text
 * after the first `#### ` header (this run's user turn), before the
 * blockquote that ends it.
 *
 * Codemux pins the RUN path's history to per-run files under
 * `~/.aider/.codemux/` instead of /dev/null. `~/.aider` is not an
 * operator instruction channel — aider reads user slash commands from
 * `~/.aider/commands/` only when a message starts with `/`, and no
 * codemux prompt can: both paths refuse a prompt whose first
 * non-whitespace character is `/` or `!` before aider sees it (the run
 * path in AiderAdapter.validateRunRequest, the session driver before
 * the ack — review D10, security), and nothing else scans the
 * directory wholesale — and unlike the temp root it stays visible to a
 * sandboxed harness. Run files are 0600 under a 0700 parent and are
 * removed at
 * exit; files of codemux processes that died are swept after two days,
 * longer than any run may last. Session files live one level down
 * (`sessions/<uuid>/history.md`) on a different lifecycle: kept as the
 * resume state, swept only after 28 idle days (aider-session.ts).
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export interface AiderHistoryFile {
  /** The path to pass as `--chat-history-file`. */
  path: string;
  /** Removes the file. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const FILE_PREFIX = "history-";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler leaves the file behind; it is
// swept only once older than any run could still be reading it.
const STALE_FILE_MS = 2 * 86_400_000;

/** Removes files left behind by codemux processes that no longer exist. */
function sweepStaleFiles(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^history-(\d+)-/.exec(entry);
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
    if (age < STALE_FILE_MS) continue;
    // One bad entry must not block the run, or every later run: the entry
    // stays, the sweep moves on, and the operator learns why (an entry the
    // sweep cannot remove is never cleaned up by retrying it either).
    try {
      rmSync(path, { force: true });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.error(`aider: could not remove the stale history file ${path}${detail}`);
    }
  }
}

/**
 * Creates a fresh chat history file. `home` is the real user home the run
 * sees (aider has no state directory of its own).
 */
export function createAiderHistoryFile(home: string): AiderHistoryFile {
  const parent = join(home, ".aider", PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the home could have replaced the parent with
  // a symlink, pointing the sweep's rm elsewhere.
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid())
  ) {
    throw new Error(`${parent} must be a directory owned by the current user`);
  }
  sweepStaleFiles(parent);
  const path = join(parent, `${FILE_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}.md`);
  writeFileSync(path, "", { mode: 0o600 });

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    rmSync(path, { force: true });
    process.off("exit", finalize);
  };
  process.once("exit", finalize);

  return { path, finalize };
}

// The largest chat history read codemux makes: the biggest legal prompt
// (MAX_PROMPT_BYTES, 16 MiB in validation.ts) echoed as the user turn,
// plus the reply, reasoning and tool chatter around it. On the run path
// this bounds the whole per-run file; on the session path it bounds
// ONE turn's delta — the accumulated session history has no size limit
// from codemux's side, because the driver reads only the slice past its
// consumed byte offset (review D8, correctness 2), while a harness that
// can write the directory could grow a single exchange without bound,
// so the read fails closed beyond it.
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

/**
 * Opens a history file under the trust rules every read here shares.
 * The sandboxed harness can write the directory the file lives in
 * (~/.aider/.codemux is harness state), so a plain open would follow a
 * harness-planted symlink to a file outside the sandbox and read it
 * without bound — inside codemux, which runs outside the sandbox. The
 * open passes O_NOFOLLOW (a final symlink is refused) and O_NONBLOCK
 * (the pattern `readUtf8FileBounded` already uses): a harness that
 * replaced the file with a FIFO would otherwise park
 * `openSync(O_RDONLY)` until a writer appears, and these reads run
 * after the subprocess timeout is cleared, so nothing else would stop
 * it. The descriptor must be a regular file. Regular files ignore
 * O_NONBLOCK, and platforms without O_NOFOLLOW (win32) get whatever
 * the open allows there. Any refusal answers null.
 */
function openTrustedHistory(path: string): { fd: number; stat: Stats } | null {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | nonBlock | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, stat };
  } catch {
    closeSync(fd);
    return null;
  }
}

/**
 * Reads the RUN history whole, for extraction, at most
 * MAX_HISTORY_BYTES of it under the shared trust rules
 * (openTrustedHistory); any refusal returns null and the caller fails
 * closed on stdout alone. The session path must not use this read: a
 * session's history accumulates every exchange and outgrows any
 * whole-file bound, so the session driver reads each turn's bounded
 * delta instead (readAiderHistoryDelta, review D8).
 */
export function readAiderHistory(path: string): string | null {
  const opened = openTrustedHistory(path);
  if (opened === null) return null;
  try {
    if (opened.stat.size > MAX_HISTORY_BYTES) return null;
    return readFileSync(opened.fd, "utf8");
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/** One completed session turn's read of its history file: the bytes
 * past the offset earlier turns consumed (the delta this turn's
 * exchange appended, the driver's verdict input), and the offset the
 * next turn must consume from. */
export interface AiderHistoryDelta {
  text: string;
  sizeBytes: number;
}

/**
 * Reads the SESSION history's bytes past `offsetBytes` under the shared
 * trust rules (openTrustedHistory). A session's history accumulates
 * every exchange and can outgrow MAX_HISTORY_BYTES many times over, so
 * the run read's whole-file bound cannot apply here: applied to the
 * file, it ended every long session's finished turns as "unreadable"
 * and refused every later resume, though nothing was corrupt (review
 * D8, correctness 2 — the bound was sized for one `--message` run).
 * The bound moves to the read itself: a file that shrank below the
 * offset (the session's own state truncated), or a delta larger than
 * one run's whole history (a single exchange cannot legitimately be
 * one), answers null and the caller fails closed.
 */
export function readAiderHistoryDelta(
  path: string,
  offsetBytes: number
): AiderHistoryDelta | null {
  const opened = openTrustedHistory(path);
  if (opened === null) return null;
  try {
    const size = opened.stat.size;
    if (size < offsetBytes) return null;
    const length = size - offsetBytes;
    if (length > MAX_HISTORY_BYTES) return null;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = readSync(opened.fd, buffer, read, length - read, offsetBytes + read);
      if (got <= 0) return null; // the file shrank under the read
      read += got;
    }
    // The last byte actually read, so bytes that landed between the
    // fstat and the read are the NEXT turn's delta, never skipped.
    return { text: buffer.toString("utf8"), sizeBytes: offsetBytes + read };
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * The session history's size in bytes under the shared trust rules
 * (openTrustedHistory), reading none of its content: the driver's
 * resume baseline. A resumed session's history can be any size — the
 * content bound belongs to each turn's delta read, not to the file —
 * and what must not grow without bound is what codemux reads, which
 * here is nothing.
 */
export function aiderHistorySizeBytes(path: string): number | null {
  const opened = openTrustedHistory(path);
  if (opened === null) return null;
  closeSync(opened.fd);
  return opened.stat.size;
}

/**
 * The exact user-turn block aider 0.86.2 appends for one prompt
 * (`io.user_input` → `append_chat_history(hist, linebreak=True)`,
 * io.py:775-789 at the pinned release): every prompt line carries its own
 * `#### ` prefix, the lines join on `"  \n#### "`, the block opens with a
 * bare newline, and `append_chat_history`'s rstrip-then-append leaves two
 * spaces and a newline after the LAST line too.
 * The line split is
 * Python's `str.splitlines` — it breaks on more than `\n` (`\r`, `\r\n`,
 * `\v`, `\f`, `\x1c`, `\x1d`, `\x1e`, `\x85`, and the Unicode line
 * separators U+2028/U+2029), so a JS `split("\n")` would misjoin any
 * prompt carrying one (review D1, blocker), and it drops the one trailing
 * empty element a final line break leaves (review D4), so `"a\nb\n"`
 * renders exactly like `"a\nb"`. An empty prompt records
 * `<blank>`, as aider does. The session driver anchors each turn's reply
 * after exactly these bytes, so a multi-line prompt's continuation lines
 * stay inside the header instead of leaking into the reply.
 */
// Python str.splitlines' line boundaries (str.splitlines docs); \r\n
// first so the pair consumes as one break, and the U+2028/U+2029 escapes
// spelled out because the literal characters are line terminators in JS
// source and cannot appear inside a regex literal.
const PYTHON_SPLITLINES =
  /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;
// Python str.rstrip()'s whitespace set (ASCII whitespace plus the \x1c
// group and the Unicode space separators), for the byte-exact tail.
const PY_RSTRIP =
  /[ \t\n\v\f\r\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

export function aiderHistoryHeader(prompt: string): string {
  const split = prompt === "" ? ["<blank>"] : prompt.split(PYTHON_SPLITLINES);
  // Python str.splitlines drops the one trailing empty element JS split
  // keeps after a final line break ("a\nb\n".splitlines() is ["a", "b"],
  // while split keeps ["a", "b", ""]) — kept, the extra "#### " would
  // miss the block aider wrote and the reply would fall back to the
  // loose anchor, leaking the prompt's continuation lines (review D4,
  // correctness).
  const lines =
    prompt !== "" && split[split.length - 1] === "" ? split.slice(0, -1) : split;
  // hist = f"\n#### " + "  \n#### ".join(lines), then rstrip() + "  \n".
  const block = `\n#### ${lines.join("  \n#### ")}`.replace(PY_RSTRIP, "");
  return `${block}  \n`;
}

/**
 * The reply-extraction loop over the text AFTER the user header block:
 * blockquoted tool chatter removed, a leading reasoning block stripped,
 * blank lines inside the answer kept. The session driver calls this
 * directly on its history delta, anchored past the exact header block
 * `aiderHistoryHeader` builds — a multi-line prompt's continuation lines
 * sit inside the header's own section, so anchoring on `#### ` alone
 * would leak them into the reply.
 */
export function aiderReplyAfterHeader(text: string): string {
  const reply: string[] = [];
  let pendingBlank: string[] = [];
  let started = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith(">")) {
      // Blockquoted tool chatter: skip before the answer, end at it after.
      if (started) break;
      pendingBlank = [];
      continue;
    }
    if (line === "") {
      if (started) pendingBlank.push("");
      continue;
    }
    started = true;
    reply.push(...pendingBlank, raw);
    pendingBlank = [];
  }
  return stripLeadingThinking(reply.join("\n").trim()).trim();
}

/**
 * The model's answer inside a chat history: the bare text after the user
 * header, with the blockquoted tool chatter around it removed and a leading
 * reasoning block stripped. Codemux's `--message` runs are single-turn, so
 * the FIRST `#### ` header is this run's user turn and any later one is text
 * the model itself wrote: it stays in the answer (a header inside the reply
 * must fail the check, not re-anchor the extraction onto its own tail).
 * Blank lines inside the answer are kept — an answer that was not exactly
 * `OK` must fail the check, not lose its tail. An empty history has no
 * answer, and extraction returns "" so the check fails closed.
 */
export function extractAiderReply(history: string): string {
  const header = history.indexOf("#### ");
  if (header === -1) return "";
  const afterHeader = history.indexOf("\n", header);
  if (afterHeader === -1) return "";
  return aiderReplyAfterHeader(history.slice(afterHeader + 1));
}

// Aider folds the endpoint's reasoning into the reply, wrapped in
// `<thinking-content-…>` tags ("reasoning tokens" display, aider 0.86); the
// model's visible answer follows them. Only a LEADING block is stripped —
// reasoning later in the reply stays and fails the check; a reply that is
// nothing but the leading block strips to the empty string.
const LEADING_THINKING =
  /^<thinking-content-[0-9a-fA-F]+>\r?\n?[\s\S]*?\r?\n?<\/thinking-content-[0-9a-fA-F]+>\r?\n?/;

export function stripLeadingThinking(reply: string): string {
  return reply.replace(LEADING_THINKING, "");
}
