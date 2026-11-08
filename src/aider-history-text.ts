/**
 * The reply-extraction text rules over aider chat history text: the
 * exact user-turn header block aider 0.86.2 writes, the reply found
 * after it, and the restore-parser mirror that decides whether a delta
 * records an unanswered prompt. Split from src/aider-history.ts (review
 * round 199) — that module keeps the file lifecycle and the bounded
 * reads; everything here is a pure function over text the callers hand
 * it, pinned against aider's io.py and utils.py at the 0.86.2 release.
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
    // Aider's own mark is `> `-with-space, the only shape its restore
    // parser reads as tool output (aiderRestoresAssistantText mirrors
    // it): a bare `>` and a `>`-without-space line are text the model
    // wrote, so they stay in the answer and extraction agrees with the
    // resumability verdict (review round 331; round 372, item 12).
    if (line.startsWith("> ")) {
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

// Python's str.splitlines boundaries and str.strip whitespace, which
// aider's restore parser uses.
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const PY_NON_SPACE =
  /[^\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/**
 * Whether aider would restore an assistant message from the text AFTER
 * a user header block: a line-for-line mirror of its restore parser
 * (utils.split_chat_history_markdown at the pinned 0.86.2). That parser
 * skips `# ` lines, reads `> ` lines as tool output and `#### ` lines
 * as user text, and keeps every other line as assistant text; a block
 * that is blank after stripping yields no message.
 */
export function aiderRestoresAssistantText(text: string): boolean {
  for (const line of text.split(PY_LINE_BREAK)) {
    if (line.startsWith("# ") || line.startsWith("> ") || line.startsWith("#### ")) continue;
    if (PY_NON_SPACE.test(line)) return true;
  }
  return false;
}

/**
 * Whether a turn's history delta is the non-resumable shape the
 * session-end path refuses to resume (src/session/aider-finalize.ts):
 * a `#### ` user block the next process would restore with no
 * assistant message after it. Aider writes the prompt when the turn
 * starts and the reply only at its end, so a process that exits between
 * the two leaves an unanswered prompt the next `--restore-chat-history`
 * process would replay as if the caller had sent it (review round 96,
 * whole tree). The question is what aider RESTORES, not what the caller
 * sees, so the answer comes from aider's own parser rules
 * (aiderRestoresAssistantText; review rounds 163, 166, and 167). A
 * reply that is only a reasoning block is restored, so the prompt is
 * answered. A reply made only of `> ` lines, `# ` lines, or `#### `
 * lines is not: aider writes its tool output and the user's text in
 * those shapes and restores none of them as the assistant's, so the
 * turn fails loudly instead of leaving a history that replays its
 * prompt.
 */
export function aiderDeltaRecordsUnansweredPrompt(
  delta: string,
  prompt: string | null
): boolean {
  const first = delta.indexOf("#### ");
  if (first === -1) return false;
  const header = prompt !== null ? aiderHistoryHeader(prompt) : null;
  const at = header !== null ? delta.indexOf(header) : -1;
  // Without the exact header (the harness wrote the prompt back
  // altered) the scan starts at the first user line, which the parser
  // rules skip along with its continuation lines.
  const after = header !== null && at !== -1 ? delta.slice(at + header.length) : delta.slice(first);
  return !aiderRestoresAssistantText(after);
}

// Aider folds the endpoint's reasoning into the reply, wrapped in
// `<thinking-content-…>` tags ("reasoning tokens" display, aider 0.86); the
// model's visible answer follows them. Only a LEADING block is stripped —
// reasoning later in the reply stays and fails the check; a reply that is
// nothing but the leading block strips to the empty string. The opening and
// closing identifiers must match (the backreference): mismatched tags are
// text the model wrote, and stripping between them would again discard
// assistant text an exact-answer check must see (review round 331).
const LEADING_THINKING =
  /^<thinking-content-([0-9a-fA-F]+)>\r?\n?[\s\S]*?\r?\n?<\/thinking-content-\1>\r?\n?/;

export function stripLeadingThinking(reply: string): string {
  return reply.replace(LEADING_THINKING, "");
}
