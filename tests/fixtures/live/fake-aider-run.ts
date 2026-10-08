/**
 * A scenario-driven fake of headless aider (the per-turn process behind
 * the aider session driver), built from the shapes the adapter pins
 * (src/adapters/aider.ts, 0.86.2): the prompt rides argv as
 * `--message=<text>`, the canned "n\n" negatives arrive on stdin, stdout
 * is a human transcript (never a protocol), and the one machine-usable
 * record of the exchange is the Markdown chat history file the
 * `--chat-history-file` flag names — a `# aider chat started at …`
 * banner at every process start, `#### `-prefixed user sections, `> `
 * tool blockquotes, the reply after them (src/aider-history.ts). The
 * e2e tests drive the real driver against this script, so every
 * round-trip — the argv prompt, the history delta, the exit-code
 * verdict — is live. The history writes below are the fixture's own
 * copy of io.py's (0.86.2), deliberately NOT an import of
 * aiderHistoryHeader: the fixture models the harness, so codemux's
 * builder and this file are two independent renderings of the same
 * pinned source (review D1, blocker).
 *
 * The scenario is the prompt's `scenario:<name>` prefix; every exchange
 * appends the user block plus the scenario's reply to the history file
 * (aider's own io.append_chat_history behavior). Everything received
 * (argv, stdin bytes) is recorded as JSONL under $FAKE_STATE_DIR.
 *
 *   basic (default) — banner lines on stdout, the exchange appended,
 *                     exit 0
 *   toolreply       — the reply is preceded by a `> ` blockquote (tool
 *                     chatter): the blockquote never reaches the
 *                     driver's assistant_message
 *   multiline       — the prompt itself is multi-line: every line
 *                     carries `#### ` in the history, joined on
 *                     two-space lines, and none of the continuation
 *                     lines may leak into the reply
 *   errorturn       — banner lines, no exchange appended, exit 1: the
 *                     turn fails on the exit code, the session survives
 *   noexchange      — exit 0 with no exchange: the turn fails ("records
 *                     no exchange"), the session survives
 *   crash           — nothing at all, exit 1
 *   wait            — the banner and the turn's user block, then
 *                     nothing (the turn stays open until a signal ends
 *                     the process): real aider writes the `#### ` block
 *                     when the message is read (io.user_input) and the
 *                     reply only at the turn's end, so a killed `wait`
 *                     leaves the history half-written (review D10,
 *                     correctness-2 1's shape)
 *   truncate        — SHRINKS the history file before exiting 0: the
 *                     driver's read-back finds the session's own state
 *                     truncated and must end the session
 *
 * FAKE_SIGTERM_PERSIST covers the shutdown drain, the agy fake's modes:
 * =1 survives the shutdown SIGTERM, appends the turn's reply, and exits
 * 0 — the user block is already in the file (the `wait` scenario wrote
 * it at the turn's start), so io.ai_output's reply is the only thing
 * left to append, delivered inside the grace window, which the drain
 * tests pin as delivered; =exit42 answers nothing and exits 42 — the
 * drain-failure verdict; =exit143 is the same silence with the signal's
 * coded spelling, which must NOT be read as a failure (the history
 * keeps the unanswered user block — the half-written state). Without
 * the env the default SIGTERM disposition applies.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-aider-run";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

const messageIndex = args.findIndex((arg) => arg.startsWith("--message="));
const messageArg = messageIndex !== -1 ? args[messageIndex] : undefined;
const prompt = messageArg !== undefined ? messageArg.slice("--message=".length) : "";
const historyIndex = args.indexOf("--chat-history-file");
const historyPath = historyIndex !== -1 ? args[historyIndex + 1] : undefined;

const banner = (): void => {
  process.stdout.write("Aider v0.86.2\n");
  process.stdout.write("Model: openai/gpt-5.1\n");
};

// io.py's line split and tail strip, for byte-exact history writes:
// Python str.splitlines breaks on more than \n, and append_chat_history
// rstrips the block before its "  \n".
const PY_SPLITLINES =
  /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;
const PY_RSTRIP =
  /[ \t\n\v\f\r\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

/** InputOutput's construction-time banner (io.py:336): the first thing
 * every aider process puts in the history file. */
const appendStartedBanner = (): void => {
  if (historyPath === undefined) return;
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  appendFileSync(historyPath, `\n# aider chat started at ${stamp}\n\n`);
};

/** io.user_input's user block (io.py:775): `#### ` before EVERY prompt
 * line, joined on "  \n#### ", opened by a bare newline, closed by the
 * two-space line append_chat_history's linebreak shape writes. The split
 * is Python's splitlines, which drops the one trailing empty element a
 * final line break leaves — "a\nb\n" renders like "a\nb" (review D4). */
const userBlock = (text: string): string => {
  const split = text === "" ? ["<blank>"] : text.split(PY_SPLITLINES);
  const lines = text !== "" && split[split.length - 1] === "" ? split.slice(0, -1) : split;
  return `\n#### ${lines.join("  \n#### ")}`.replace(PY_RSTRIP, "") + "  \n";
};

/** Appends one exchange to the chat history — aider's own format: the
 * user block, then ai_output's reply ("\n" + content.strip() + "\n\n";
 * an optional `> ` blockquote line ahead of the reply models tool
 * chatter). */
const appendExchange = (prompt: string, reply: string, blockquote?: string): void => {
  if (historyPath === undefined) return;
  const chatter = blockquote !== undefined ? `> ${blockquote}\n` : "";
  appendFileSync(historyPath, `${userBlock(prompt)}\n${chatter}${reply}\n\n`);
};

/** Runs one scenario; the exit code when the process answered, null when
 * the turn stays open (wait/crash — only a signal ends it). Every
 * scenario but `crash` models a process that got as far as constructing
 * its InputOutput, so the startup banner is in the history file first
 * (io.py:336). */
const runTurn = (scenario: string, prompt: string): number | null => {
  if (scenario !== "crash") appendStartedBanner();
  switch (scenario) {
    case "toolreply":
      banner();
      appendExchange(prompt, `Done: ${prompt}`, "Adding file main.py");
      return 0;
    case "multiline":
    case "basic":
      banner();
      appendExchange(prompt, `Done: ${prompt}`);
      return 0;
    case "errorturn":
      banner();
      process.stdout.write("The model refused the turn\n");
      return 1;
    case "noexchange":
      banner();
      return 0;
    case "truncate":
      if (historyPath !== undefined) {
        // Shrink below whatever earlier turns wrote: the driver's
        // read-back must treat its own state as unreliable.
        writeFileSync(historyPath, "#### truncated by the harness\n");
      }
      return 0;
    case "crash":
      return null;
    case "wait":
      // io.user_input fires the moment the --message text is read —
      // before the model call — so the user block is already on disk
      // while the turn runs; only the reply waits for the turn's end.
      banner();
      if (historyPath !== undefined) {
        appendFileSync(historyPath, userBlock(prompt));
      }
      return null;
    default:
      banner();
      appendExchange(prompt, `Done: ${prompt}`);
      return 0;
  }
};

// The canned negatives arrive on stdin and EOF closes the exchange's
// input; the turn cannot start before the stream closes.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  record("stdin.jsonl", { bytes: input.length });
  const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
  // The resume replay: --restore-chat-history reads the file before the
  // exchange, recorded so the resume tests can prove the file survived.
  if (args.includes("--restore-chat-history") && historyPath !== undefined) {
    try {
      record("prehistory.jsonl", { length: readFileSync(historyPath, "utf8").length });
    } catch {
      record("prehistory.jsonl", { length: null });
    }
  }
  const code = runTurn(scenario, prompt);
  if (code !== null) {
    process.exit(code);
  }
  // The turn stays open; stay alive for the signal.
  setInterval(() => {}, 60_000);
});

const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (persistMode === "1" || persistMode === "exit42" || persistMode === "exit143") {
  process.on("SIGTERM", () => {
    if (persistMode === "1") {
      // The drained reply: the user block is already in the file (the
      // wait scenario wrote it at the turn's start), so only
      // io.ai_output's reply is appended, inside the grace window — the
      // turn's answer is the output the caller is owed.
      if (historyPath !== undefined) {
        appendFileSync(historyPath, "\ndrained after the shutdown signal\n\n");
      }
    }
    setTimeout(
      () => process.exit(persistMode === "exit42" ? 42 : persistMode === "exit143" ? 143 : 0),
      300
    );
  });
}
