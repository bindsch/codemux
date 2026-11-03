/**
 * The plain-run unwrap: adapters that can report usage launch their harness
 * in its structured mode even without `--result-json` (claude/zai's
 * `--output-format json`, agy's `--output-format=json`, opencode's
 * `--format json`, codex's `--json`), and these functions turn the
 * structured stdout back into the plain reply so `codemux run` stdout keeps
 * its contract — the model's final message and nothing else — while the
 * run's usage and served model are recorded on the RunResult for the call
 * ledger. opencode's `--format json`, codex's `--json`, and kimi's
 * stream-json streams carry the same volume (every tool's output rides the
 * event lines), so their plain runs stream instead of buffering: the
 * launcher feeds each chunk to a fold (OpenCodePlainFold, CodexPlainFold,
 * KimiPlainFold) that keeps only the reply text, the folded usage, and the
 * break notes — tool output is dropped as it arrives — and the capture
 * bound measures that residue, never the raw stream (review ul4).
 *
 * The unwrap reproduces plain-text mode byte for byte: the result text
 * verbatim, plus one trailing newline when the text is non-empty and lacks
 * one — codex excepted below, whose pinned printer appends its newline
 * unconditionally. opencode's reply is spelled the way its run command's
 * plain mode
 * prints it (verified against upstream v1.18.18, scratch/upstream-run.ts):
 * each completed text part trimmed, empty parts skipped, one newline after
 * every part — the banner, tool lines, and errors all go to stderr there,
 * so stdout is the parts and nothing else. codex's is the final assistant
 * message its human mode prints (`final_message_from_turn_items` picks the
 * last AgentMessage, and a failed turn's is discarded — the stream
 * reduction in result-envelope.ts applies the same rules): the message of
 * a completed turn stays on stdout even when codex itself exits nonzero,
 * and a turn that never completed prints nothing (round al5). The message
 * prints verbatim plus exactly one trailing newline, always — the pinned
 * human processor's `println!` (rust-v0.160.1), which appends it whatever
 * the message ends with, an empty-text or whitespace-only one included
 * (round al11; al10 had emptied those). A completed turn with no message
 * anywhere succeeds with empty stdout (round al10): human mode exits 0 for
 * that turn (`final_message` was `None` and no line was written). The one
 * bounded exception consults the `--output-last-message` file the launch
 * named (round al29, replacing al28's no-file-at-all rule): when the
 * stream completed a turn with no agent_message — a Plan-only turn, the
 * one item the JSONL wire does not carry — and only then, the recorded
 * final message is the reply (CodexPlanFallbackRead below: text answers
 * with the fallback note, an empty file confirms the messageless turn
 * with no note, a missing file fails the run naming the unwritten file
 * (round al34, edges major 2 — it was the reply's only carrier), and an
 * unreadable file fails the run with its read error). No other path
 * touches the file, so it can never contradict a stream that carried the
 * reply — the al28 defect this restates the guard against.
 * Stdout that is not the structured output the launch asked for — an older
 * binary, a wrapper that strips the flag, a fake in a test — passes
 * through verbatim with the run unchanged: no usage is recorded, except
 * on codex's hatch, whose blended `tokens used` stderr figure becomes the
 * run's usage (codexPlainResult) — the escape hatch that keeps every
 * binary codemux did not structure its output for working. The opencode
 * and claude-family/agy hatches open only when nothing on stdout is the
 * wire: one broken line among wire lines (opencode, where a timeout can
 * cut the last write mid-line) or a stdout that parses as JSON or opens
 * like the envelope but is not it (the claude family and agy, where the
 * envelope is one write a kill can halve — any JSON value, an array
 * included, not only a leading `{`; review ul7) is a structured stream
 * that broke, not a plain reply — the text and usage folded so far stay,
 * and the break becomes a codemux diagnostic on stderr (review ul3).
 * Codex's hatch is decided once per stream, by the FIRST non-empty line
 * (round al30, rule 3): the launch always passes `--json`, and a binary
 * that honored it prints `thread.started` as the first non-empty line of
 * the stream, so that line — parsed as exactly that event — commits the
 * whole stream to the wire, and any other first non-empty line commits it
 * to human mode: verbatim passthrough for the stream's whole length, with
 * nothing later flipping it however event-like a line looks — a fenced
 * example quoting a stream's events, JSON quoted inside the reply (the
 * round's correctness major: a reply whose code block quoted
 * thread.started/turn.started/turn.failed was reduced as a failed stream
 * and turned exit 0 into 1). When the structured output IS recognized,
 * the same verdict rules as the envelope path apply: an error result or a
 * result with no text fails the run
 * (README: "An empty result is a failed run on every path, plain or
 * structured") — the one exception is codex's completed messageless turn,
 * which succeeds exactly as human mode exited 0 for it (round al10, the
 * header's codex paragraph above): empty text means empty stdout, and a
 * whitespace-only message is messageless the same way but keeps its own
 * bytes on stdout verbatim plus the one trailing newline (round al11) —
 * so that arm's stdout is NOT empty (`" \n"` for a message of one
 * space). `messagelessCompletedTurnSucceeds` drops the whole empty and
 * whitespace arm of the shared verdict (codexStreamVerdict,
 * result-envelope.ts), which is how both spellings reach success here. A
 * failed run keeps
 * the harness's own text on stdout — the
 * error envelope's `result` or `response`, the text opencode streamed
 * before its error line — exactly what plain mode would have printed; the
 * structured wire itself never reaches stdout, failed or not.
 */

export { claudeFamilyPlainResult } from "./plain-unwrap/claude.js";
export { agyPlainResult } from "./plain-unwrap/agy.js";
export { parseCodexTokenTotal, codexPlainResult } from "./plain-unwrap/codex.js";
export {
  OpenCodePlainFold,
  opencodeVerdict,
  opencodePlainResult,
  openCodeResultData,
  type OpenCodeResultData,
} from "./plain-unwrap/opencode.js";
export { CodexPlainFold, codexPlainStreamResult } from "./plain-unwrap/codex-fold.js";
export { KimiPlainFold } from "./plain-unwrap/kimi-fold.js";
export {
  foldedSinkUsage,
  type UsageFoldingSink,
  type CodexPlanFallbackRead,
} from "./plain-unwrap/common.js";
