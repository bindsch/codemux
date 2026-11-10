/** The codex plain fold's event model: the fold state, per-line wire
 * classification, retained-value byte accounting, and the shared verdict.
 * src/plain-unwrap.ts owns the public surface and the module overview. */
import {
  appendDiagnostic,
  emptyUsage,
  CodexEventReducer,
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  codexStreamVerdict,
  codexWarningNote,
  codexWarningNoteBytes,
} from "../result-envelope.js";
import type { ResultUsageBlock, RunResult } from "../types.js";
import { withTruncationNotice } from "../answer-complete.js";
import { codexStreamAnswer, codexTranscript } from "../result-envelope/codex-stream.js";
import {
  byteLength,
  codexPlainReply,
  failed,
  type CodexPlanFallbackRead,
} from "./common.js";
import { codexPlainResult } from "./codex.js";

/** What the codex wire fold keeps as the lines arrive: the stream's regime
 * — decided once, by the first non-empty line (round al30, rule 3) — the
 * stream reduction (final message, usage snapshot, served model, failure
 * — the same state the whole-capture parse keeps), and the bounded break
 * notes for lines that could not be read. The reducer's `drift` is the
 * streaming spelling of the whole-capture parse's null. */
export interface CodexFoldState {
  /** null until the first non-empty line, then "wire" or "human" for the
   * stream's whole remaining length: "wire" when that line parsed as the
   * thread.started announcement a `--json`-honoring binary prints first,
   * "human" for any other first line — a binary that ignored the flag —
   * whose bytes pass through verbatim. Nothing later flips it, however
   * event-like a line looks (a fenced example quoting a stream's events
   * is reply text, not the wire identifying itself). */
  mode: "wire" | "human" | null;
  reducer: CodexEventReducer;
  /** At most the first two notes; `brokenCount` carries the total. */
  broken: string[];
  /** UTF-8 bytes of the kept `broken` notes, maintained with them. */
  brokenBytes: number;
  brokenCount: number;
}

/** Records one line the fold could not keep: the verdict prints only the
 * first two reasons and a count, so only those are kept — the notes stay
 * bounded residue the capture bound can measure. */
export function noteCodexBreak(state: CodexFoldState, note: string): void {
  state.brokenCount++;
  if (state.broken.length < 2) {
    state.broken.push(note);
    state.brokenBytes += byteLength(note);
  }
}

/** Whether a line is the thread.started announcement — the one test that
 * decides the stream's regime (round al30, rule 3): the line parses as a
 * JSON object whose `type` is exactly "thread.started". The event's own
 * grammar (the thread id, the first position) is validated by the reducer
 * once the regime is wire, exactly as the whole-capture parse validates
 * it, so the mode test stays a shape question: an announcement spelling
 * the reducer will refuse (a missing thread id) still commits the stream
 * to the wire, and the refusal is the drift that fails it. */
export function parsesAsThreadStarted(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>)["type"] === "thread.started"
  );
}

/** Folds one line of a stream already committed to the wire. Every line is
 * classified exactly as parseCodexEventStream classifies it, so the
 * streaming fold and the whole-capture parse share one verdict: a
 * whitespace-only line is skipped (the parse's blank-line skip), and EVERY
 * line that parses as a JSON object is fed to the reducer — including one
 * whose `type` is not an event the reduction reads, which the parse feeds
 * too. The reducer freezes on its first violation exactly where the parse
 * stops, so the two always hold the same reduction; the fold keeps
 * classifying the lines after it, so the drop notes stay honest. A line
 * that is not JSON — a kill can cut the last write mid-line — or JSON
 * that is not an event object is a break in the structured stream, which
 * the whole-capture parse answers with null: the first break freezes the
 * reducer (later breaks cannot replace it) and the verdict fails the run,
 * never passes the partial stream as the reply. A non-JSON line that
 * opens like an event object is named as the cut mid-event it almost
 * certainly is (a truncated `{"type":"turn.failed"}`; round al25's
 * diagnostic, kept for the wire regime it was written for). */
export function foldCodexWireLine(line: string, state: CodexFoldState): void {
  if (line.trim() === "") return; // the whole-capture parse's blank-line skip
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    state.reducer.drift ??=
      line.trimStart().startsWith("{")
        ? "a line that opens like an event object but is not complete JSON " +
          "(the stream was cut mid-event)"
        : "a line among the event stream's lines that was not JSON";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    state.reducer.drift ??= "a line of JSON that was not an event object";
    return;
  }
  // A no-op once the reducer froze on an earlier violation, so a drifted
  // stream's later objects are safely fed and never advance it past the
  // position the whole-capture parse stopped at.
  state.reducer.takeEvent(parsed as Record<string, unknown>);
}

/** The reduction's retained state — every field a verdict or the caller
 * hands back: the reply text, the usage snapshot, the kept warnings, the
 * failure text, the thread id, the served model, the drift string the
 * failure arms print. Round al29's accounting measures the VALUES: the
 * fold snapshots these before each completed wire line and applies the
 * byte DELTA after it, so a superseded value — a newer assistant message
 * replacing an older one, a recovered error's text leaving — gives its
 * bytes back before the replacing value's are added, and retainedBytes
 * always reads what the reduction holds NOW (the al28 rule it replaces
 * counted every retained line whole and never returned superseded bytes,
 * so three 3 MiB messages tripped a bound only the last one still met).
 * The snapshot holds string and object REFERENCES, not copies: every one
 * of these fields is replaced, never mutated in place (the reducer
 * assigns fresh strings and fresh usage blocks; warnings only append), so
 * reference inequality is the cheap change test and byteLength runs only
 * on the fields that moved. `usageReported` and the counters are verdict
 * inputs, not residue, and stay out. */
export interface CodexRetainedSnapshot {
  threadId: string;
  finalMessage: string | null;
  /** The turn's message array and its length at the snapshot: the reducer
   * appends in place and replaces the array at a turn boundary (lane AN1). */
  messages: string[];
  messageCount: number;
  servedModel: string | null;
  failure: string | null;
  warnings: number;
  drift: string | null;
  usage: ResultUsageBlock;
}

export const codexRetainedOf = (reducer: CodexEventReducer): CodexRetainedSnapshot => ({
  threadId: reducer.threadId,
  finalMessage: reducer.finalMessage,
  messages: reducer.messages,
  messageCount: reducer.messages.length,
  servedModel: reducer.servedModel,
  failure: reducer.failureText(),
  warnings: reducer.warnings.length,
  drift: reducer.drift,
  usage: reducer.usage,
});

/** The bytes one retained string books in the total: its own UTF-8 size,
 * zero for null. */
const codexValueBytes = (text: string | null): number =>
  text === null ? 0 : byteLength(text);

/** The byte delta one completed line moved the retained values by —
 * negative when the line superseded a larger value than it set. Warnings
 * book their rendered note (codexWarningNoteBytes): the verdict prints
 * exactly that line per warning, so an empty message still costs its
 * prefix and a flood of them stays measured. */
export const codexRetainedDelta = (
  before: CodexRetainedSnapshot,
  reducer: CodexEventReducer
): number => {
  let delta = 0;
  if (before.threadId !== reducer.threadId) {
    delta += byteLength(reducer.threadId) - byteLength(before.threadId);
  }
  // The final message is the last entry of `messages`, booked there once
  // (lane AN1: every message of the turn is retained for the answer); a
  // fallback-set final message never passes through the fold.
  if (before.messages === reducer.messages) {
    for (let i = before.messageCount; i < reducer.messages.length; i++) {
      delta += byteLength(reducer.messages[i]!);
    }
  } else {
    for (let i = 0; i < before.messageCount; i++) delta -= byteLength(before.messages[i]!);
    for (const message of reducer.messages) delta += byteLength(message);
  }
  if (before.servedModel !== reducer.servedModel) {
    delta += codexValueBytes(reducer.servedModel) - codexValueBytes(before.servedModel);
  }
  const failure = reducer.failureText();
  if (before.failure !== failure) {
    delta += codexValueBytes(failure) - codexValueBytes(before.failure);
  }
  if (before.drift !== reducer.drift) {
    delta += codexValueBytes(reducer.drift) - codexValueBytes(before.drift);
  }
  if (before.usage !== reducer.usage) {
    delta +=
      byteLength(JSON.stringify(reducer.usage)) -
      byteLength(JSON.stringify(before.usage));
  }
  // Warnings only append (takeWarning pushes; nothing removes), so the
  // entries added since the snapshot are the whole change.
  for (let i = before.warnings; i < reducer.warnings.length; i++) {
    delta += codexWarningNoteBytes(reducer.warnings[i]!);
  }
  return delta;
};

/** The retained values' whole byte total, measured now — the hatch→wire
 * flip's one-time initialization: the counter starts at what the
 * reduction already holds, never at zero, for values set by lines the
 * hatch fed survive the flip and stay retained. */
export const codexRetainedTotal = (reducer: CodexEventReducer): number => {
  let total = byteLength(reducer.threadId);
  for (const message of reducer.messages) total += byteLength(message);
  total += codexValueBytes(reducer.servedModel);
  total += codexValueBytes(reducer.failureText());
  total += codexValueBytes(reducer.drift);
  for (const warning of reducer.warnings) total += codexWarningNoteBytes(warning);
  total += byteLength(JSON.stringify(reducer.usage));
  return total;
};

/** The verdict every codex plain path shares (the streaming fold and a
 * whole-capture replay of captured stdout). The stream's regime was
 * decided once, by the FIRST non-empty line (round al30, rule 3): human
 * mode — any first line but the thread.started announcement, a stream of
 * blank lines that never committed itself included — is the hatch's:
 * verbatim stdout, the stderr `tokens used` figure (codexPlainResult),
 * 0.11.0's verdict exactly, and no line later in the stream can change
 * that, however event-like it looks (a fenced example quoting a stream's
 * events is reply text; the al24/al25 quoted-announcement machinery this
 * replaces lived exactly that mistake — a code block quoting
 * thread.started closed the hatch, and a quote carrying turn.failed
 * failed the reply around it). Wire mode — the announcement parsed as
 * the first non-empty line — runs the same rules as the envelope path:
 * the folded final message is the reply under the decided failure
 * contract (round al5, its spelling settled in al11): stdout carries the
 * reply exactly when the stream completed the turn — a `turn.completed`
 * closed every turn and a final message exists — even when codex then
 * exited nonzero, because human mode printed that message before exiting,
 * and the message prints verbatim plus exactly one trailing newline
 * however it ends (`println!`; see codexPlainReply); a turn that never
 * completed (drift, a truncated stream, a `turn.failed`, a kill or
 * timeout after an intermediate agent message) prints nothing, which is
 * also what human mode printed; and a turn that completed with no message
 * anywhere succeeds with empty stdout and keeps the usage (round al10).
 * The messageless arm is where the ONE bounded fallback lives (round
 * al29, replacing al28's no-file-at-all rule): a plain run names a
 * `--output-last-message` file again — a Plan-only turn's recorded final
 * message is the reply's only carrier, the one item the JSONL wire does
 * not carry — but the verdict consults it only when the stream completed
 * a turn with no agent_message and nothing else failed, through the
 * `planFallback` thunk the launch hands over after its own
 * read-and-remove (CodexPlanFallbackRead above): text answers with
 * CODEX_FINAL_MESSAGE_FALLBACK_NOTE, an empty file confirms the
 * messageless turn (human mode's `final_message` was `None`; no note), a
 * missing file fails the run naming the unwritten file (round al34,
 * edges major 2 — the file was the turn's only carrier, and codex did
 * not write it), and an unreadable one fails with its read error. No
 * thunk, or any other stream shape, never reads the file — the
 * two-verdicts-for-one-stream defect al28 answered by deleting the file
 * is answered here by scoping it. The wire itself never reaches stdout,
 * failed or not. */
export function codexFoldVerdict(
  result: RunResult,
  state: CodexFoldState,
  planFallback?: () => CodexPlanFallbackRead
): RunResult {
  const withBreakNote = (stderr: string): string =>
    state.brokenCount === 0
      ? stderr
      : appendDiagnostic(
          stderr,
          `codemux: ${state.brokenCount} codex output line(s) were dropped ` +
            `unread (${state.broken.join("; ")}), so the reply and usage ` +
            "come from the lines that were read"
        );
  // The whole-capture parse returns null for drift and the envelope path
  // keeps the raw stream for inspection; the fold never held it. A drifted
  // run prints no reply: the turn never completed, and human mode printed
  // nothing for a turn that never completed. The warnings the reduction
  // retained before the break ride the failure's stderr exactly as the
  // clean path renders them (round al25, correctness minor): a parse
  // failure must not silently discard them.
  const streamFailure = (diagnostic: string): RunResult => {
    const notes: string[] = [diagnostic];
    for (const warning of state.reducer.warnings) {
      notes.push(codexWarningNote(warning));
    }
    const failureResult = failed(result, notes.join("\n"), "");
    return {
      ...failureResult,
      servedModel: state.reducer.servedModel,
      stderr: withBreakNote(failureResult.stderr),
    };
  };
  const driftFailure = (drift: string): RunResult =>
    streamFailure(
      `codemux: codex printed an event stream this codemux cannot parse ` +
        `(${drift}), so this run fails rather than pass a partial one ` +
        "as the reply"
    );
  if (state.mode !== "wire") {
    // Human mode — or a stream of blank lines that never decided: the
    // whole stdout is plain text from a binary that ignored `--json` (an
    // older binary, a wrapper, a fake; round al30 made the first
    // non-empty line the one and only test). The reply passes through
    // verbatim at the child's own exit code — codexPlainResult keeps
    // whatever exit the harness reported, 0 and non-zero alike.
    return codexPlainResult(result);
  }
  // Wire mode: the first non-empty line was the thread.started
  // announcement the reducer accepted (or an oversized `{`-shaped first
  // line, whose unread drop set the reduction's drift below), so the
  // no-announcement null the whole-capture parse answers for an
  // unannounced stream cannot arise on this branch — an unannounced
  // stream is human mode here, passthrough.
  const drift = state.reducer.drift;
  if (drift !== null) {
    return driftFailure(drift);
  }
  const stream = state.reducer.toStream();
  const verdict = codexStreamVerdict(stream, result, {
    messagelessCompletedTurnSucceeds: true,
  });
  const notes: string[] = [];
  if (verdict.diagnostic !== null) notes.push(verdict.diagnostic);
  if (stream.servedModel !== null) {
    notes.push(
      `codemux: codex rerouted the model, so this run was served by ${stream.servedModel}`
    );
  }
  // Round al22 (correctness minor): codex reports configuration and runtime
  // warnings as completed error items the turn survives, and human mode
  // printed each message on stderr — so a plain run that reduced them away
  // exited 0 with the warnings nowhere. Every non-reroute error item the
  // reduction kept now rides stderr beside the reply, success and failure
  // alike, one note per warning in arrival order.
  for (const warning of state.reducer.warnings) {
    notes.push(codexWarningNote(warning));
  }
  // The decided plain-run rule (round al5, its spelling settled in al11):
  // the reply prints exactly when the stream completed it — every turn
  // closed by a `turn.completed` and a final message the stream carries —
  // even on a failed run (codex exited nonzero
  // after completing; human mode printed the message before exiting). The
  // spelling is the pinned processor's own (`println!`): the message
  // verbatim plus exactly one trailing newline, always — an empty-text or
  // whitespace-only message prints its bytes and that newline (al11;
  // al10 had emptied them), and a message ending in a newline prints two.
  // A turn that never completed has no reply to print: the reducer still
  // holds the last intermediate agent message of a killed or timed-out
  // turn, and a failed turn's message is discarded upstream, so neither
  // may pose as the reply. A turn that completed with NO message anywhere
  // prints nothing too, but succeeds (round al10, the verdict option
  // above): stdout's emptiness is the run succeeding the way human mode
  // did — `final_message` was `None`, and no line was written — not a
  // failed result.
  // Lane AN1: the reply is every agent_message of the turn, joined.
  const answer = codexStreamAnswer(stream);
  let reply =
    stream.turnCompleted && answer !== null
      ? codexPlainReply(answer)
      : "";
  // The ONE bounded fallback (round al29): a completed messageless turn —
  // the Plan-only shape, the one item the JSONL wire cannot carry — and
  // only that, with no protocol failure even when the child exits nonzero, consults the
  // --output-last-message file the launch named. The thunk reads nothing
  // itself (the launch read and removed the file before the verdict ran,
  // so it cannot outlive the run), and no other arm invokes it: a stream
  // that carried the reply or never completed answers from the
  // stream alone, exactly as it did before the file existed.
  if (
    planFallback !== undefined &&
    stream.failure === null &&
    stream.turnCompleted &&
    stream.finalMessage === null
  ) {
    const fallback = planFallback();
    if (fallback.outcome === "text" && fallback.text !== "") {
      reply = codexPlainReply(fallback.text);
      notes.push(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
    } else if (fallback.outcome === "text") {
      // An empty file is upstream's messageless-turn record: human mode
      // printed nothing for it, so the reply stays empty — the al10
      // verdict with the file's own confirmation, and no note for a turn
      // that had no message to report.
    } else if (fallback.outcome === "missing") {
      // Round al34 (edges major 2): the launch NAMED this file, and for
      // the messageless turn it was the reply's only carrier — codex
      // writes something for every completed turn, so a named file that
      // is not there is a write codex only logged. The run fails naming
      // the unwritten file, exactly as the envelope path fails the same
      // shape — never an empty success beside a message that was lost.
      return {
        ...streamFailure(
          `codemux: codex completed the turn but did not write the ` +
            `--output-last-message file the launch named (${fallback.path}), ` +
            `so the turn's final message is lost`
        ),
        usage: emptyUsage(),
      };
    } else {
      // A file the read refused loses the only carrier the messageless
      // turn had: the run fails with the read error, never an empty
      // success posing beside a message codemux could not read.
      return {
        ...streamFailure(
          `codemux: could not read codex's --output-last-message file: ` +
            fallback.error
        ),
        usage: emptyUsage(),
      };
    }
  }
  return withTruncationNotice({
    ...result,
    stdout: reply,
    stderr: withBreakNote(
      notes.length > 0 ? appendDiagnostic(result.stderr, notes.join("\n")) : result.stderr
    ),
    exitCode: verdict.failed && result.exitCode === 0 ? 1 : result.exitCode,
    success: !verdict.failed,
    // A failed run reports null usage (the envelope path's rule): a figure
    // from a run whose end the harness itself called failed is at best
    // incomplete.
    usage: verdict.failed ? emptyUsage() : stream.usage,
    servedModel: stream.servedModel,
  }, "codex", codexTranscript(stream));
}
