/**
 * The per-run chat history file behind aider's hermetic check.
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
 * between the last `#### ` header and the following blockquote.
 *
 * Codemux pins the history to per-run files under `~/.aider/.codemux/`
 * instead of /dev/null. `~/.aider` is not an operator instruction channel —
 * aider reads user slash commands from `~/.aider/commands/` only when a
 * message starts with `/`, which no codemux run's prompt does, and nothing
 * else scans the directory wholesale — and unlike the temp root it stays
 * visible to a sandboxed harness. Files are 0600 under a 0700 parent and are
 * removed at exit; files of codemux processes that died are swept after two
 * days, longer than any run may last.
 */

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
    rmSync(path, { force: true });
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

/**
 * The model's answer inside a chat history: the bare text after the last
 * `#### ` user header, with the blockquoted tool chatter around it removed
 * and a leading reasoning block stripped. Blank lines inside the answer are
 * kept — an answer that was not exactly `OK` must fail the check, not lose
 * its tail. An empty history has no answer, and extraction returns "" so the
 * check fails closed.
 */
export function extractAiderReply(history: string): string {
  const header = history.lastIndexOf("#### ");
  if (header === -1) return "";
  const lines = history.slice(header).split("\n").slice(1);
  const reply: string[] = [];
  let pendingBlank: string[] = [];
  let started = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("#### ")) break; // a later user turn
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

// Aider folds the endpoint's reasoning into the reply, wrapped in
// `<thinking-content-…>` tags ("reasoning tokens" display, aider 0.86); the
// model's visible answer follows them. Reasoning that outlives the block, or
// a reply that is nothing but reasoning, stays in the answer and fails the
// check rather than being quietly dropped.
const LEADING_THINKING =
  /^<thinking-content-[0-9a-fA-F]+>\r?\n?[\s\S]*?\r?\n?<\/thinking-content-[0-9a-fA-F]+>\r?\n?/;

export function stripLeadingThinking(reply: string): string {
  return reply.replace(LEADING_THINKING, "");
}
