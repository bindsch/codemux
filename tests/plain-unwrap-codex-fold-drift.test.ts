import { describe, expect, test } from "bun:test";
import { codexPlainResult, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { parseCodexEventStream } from "../src/result-envelope.js";
import type { RunResult } from "../src/types.js";
import {
  agentMessage,
  codexFoldStream,
  finished,
  FULL_BLOCK,
  THREAD,
  turnCompleted,
  turnStarted,
  USAGE_FULL,
  warningItem,
  WARNING_TEXT,
} from "./helpers/plain-unwrap.js";

const foldStream = codexFoldStream;

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.

  test("a parse failure keeps the warnings collected before it on stderr (al25)", () => {
    // The correctness minor's sibling: the drift failure's early return
    // skipped the warning rendering the clean path performs, so a run
    // that warned and then broke exited 1 with its warnings silently
    // discarded. streamFailure renders them exactly as the success does,
    // one note per warning after the failure's own diagnostic.
    const stream = [THREAD, turnStarted(), warningItem(), "not json at all"].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("was not JSON");
    expect(out.stderr).toContain(`codemux: codex warning: ${WARNING_TEXT}`);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("the escape hatch: stdout that is not the wire passes through verbatim with the stderr figure", () => {
    // A binary that ignored `--json` printed human mode: its stdout is
    // the reply as it printed it, and the one blended figure human mode
    // reports on stderr is all the usage there is.
    const result: RunResult = {
      stdout: "the reply\n",
      stderr: "tokens used\n2,048\n",
      exitCode: 0,
      success: true,
    };
    const out = foldStream("the reply\n").verdict(result);
    expect(out).toEqual(codexPlainResult(result));
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(2048);
    expect(out.usage!.input_tokens).toBeNull();
  });

  test("a non-JSON line amid wire lines is drift: the run fails with no stdout, the turn never completed (al5)", () => {
    // A kill can cut the last write mid-line; the whole-capture parse
    // answers null, so the fold freezes on the break and the verdict
    // fails rather than pass a partial stream off as the reply. The
    // decided contract (round al5): drift means the turn never completed,
    // and human mode printed nothing for a turn that never completed —
    // so the message folded so far is an intermediate one and stdout is
    // empty.
    const stream = [
      THREAD,
      turnStarted(),
      agentMessage("partial"),
      "not json at all",
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("cannot parse");
    expect(out.stderr).toContain("was not JSON");
    // No usage block is fabricated for a broken stream; the ledger's
    // receipt fills all-null for a result that carries none.
    expect(out.usage).toBeUndefined();
  });

  test("a line of JSON that is not an event object is drift the same way", () => {
    const stream = [THREAD, turnStarted(), "[1,2,3]", turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("was not an event object");
  });

  test("a cut mid-event — a `{`-shaped line that is not complete JSON — names the cut, and the run fails (al30)", () => {
    // Rule 3's wire-regime side: the first line announced the thread, so
    // the stream committed to the wire, and NOTHING later flips it — the
    // `{`-shaped fragment the kill left behind is the wire breaking, not
    // human text (the human side of the same bytes is the al25/al30 test
    // above: there the FIRST line decided human mode). The diagnostic
    // distinguishes the two shapes a non-JSON wire line can take: one
    // that opens like an event object is named as the cut mid-event it
    // almost certainly is; any other is a stray line.
    const stream = [THREAD, turnStarted(), '{"type":"turn.failed"'].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("the stream was cut mid-event");
    expect(out.usage).toBeUndefined();
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    // The other shape keeps its own diagnostic.
    const stray = [THREAD, turnStarted(), "not json at all"].join("\n") + "\n";
    const strayOut = foldStream(stray).verdict(finished(""));
    expect(strayOut.stderr).toContain("was not JSON");
    expect(strayOut.stderr).not.toContain("cut mid-event");
  });

  test("whitespace-only lines between events are skipped, so the plain and whole-capture paths share one verdict (al2)", () => {
    // parseCodexEventStream skips blank lines before parsing; the fold used
    // to hand JSON.parse("") the same line and call the stream drift, so a
    // stream with blank separators failed plain runs that the --result-json
    // path accepted. The fold skips them too now, and the same bytes get
    // the same verdict either way.
    const stream = [
      "",
      THREAD,
      "   ",
      turnStarted(),
      "",
      agentMessage("the reply"),
      "\t",
      turnCompleted(USAGE_FULL),
      "",
    ].join("\n") + "\n";
    const whole = parseCodexEventStream(stream);
    expect(whole).not.toBeNull();
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    // The agreement is structural: the streamed fold and a whole-capture
    // replay of the same bytes answer identically (the ul4 shape).
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

});
