import { describe, expect, test } from "bun:test";
import { OpenCodePlainFold, opencodePlainResult } from "../src/plain-unwrap.js";
import { finished, part, stepFinish } from "./helpers/plain-unwrap.js";

describe("opencodePlainResult", () => {
  // Every run-output wire line carries the sessionID the parser's gate
  // requires (session/opencode-session.ts).

  test("each text part prints trimmed on its own line, as plain mode does (ul3)", () => {
    // The pin: upstream's run command (v1.18.18, scratch/upstream-run.ts)
    // prints every completed text part as part.text.trim() + EOL and skips
    // parts that trim to empty, so plain stdout is one line per part, never
    // the parts concatenated.
    const out = opencodePlainResult(
      finished([part(" hel "), part(""), part("lo"), stepFinish({ input: 8, output: 3, total: 11 })].join("\n") + "\n")
    );
    expect(out.stdout).toBe("hel\nlo\n");
    expect(out.success).toBe(true);
    expect(out.usage!.total_tokens).toBe(11);
  });

  test("a multi-line part keeps its interior newlines — the live wire (ul3)", () => {
    // Captured from the installed 1.18.18 binary against the override
    // gateway (scratch/opencode-wire-probe/cap-json): step_start, one text
    // part "alpha\nbravo\ncharlie", one step_finish. Plain mode printed
    // exactly the part plus one newline.
    const live = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1791489571218,
        sessionID: "ses_ee2e69542ffedfZ3guWTBONcOp",
        part: { id: "prt_11d197986001gvswyj" },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1791489571298,
        sessionID: "ses_ee2e69542ffedfZ3guWTBONcOp",
        part: { id: "prt_11d197986001gvswyj", text: "alpha\nbravo\ncharlie" },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1791489571351,
        sessionID: "ses_ee2e69542ffedfZ3guWTBONcOp",
        part: {
          tokens: { total: 24437, input: 24429, output: 8, reasoning: 0, cache: { write: 0, read: 0 } },
          cost: 0,
        },
      }),
    ].join("\n") + "\n";
    const out = opencodePlainResult(finished(live));
    expect(out.stdout).toBe("alpha\nbravo\ncharlie\n");
    expect(out.usage).toEqual({
      input_tokens: 24429,
      output_tokens: 8,
      cached_input_tokens: 0,
      total_tokens: 24437,
      cost_usd: 0,
    });
  });

  test("a cut-off trailing line keeps the reply, the usage, and never dumps the wire (ul3)", () => {
    // The timeout shape: the kill lands mid-write of a step_finish line.
    // Before ul3, one unparseable line made the whole stdout pass through
    // verbatim — the raw JSON stream as a successful reply, all-null usage.
    const cut = [
      part("the reply so far"),
      stepFinish({ input: 8, output: 3, total: 11 }),
      part("more of the reply"),
      `{"type":"step_finish","timestamp":1791489571351,"sessionID":"ses_01234567`,
    ].join("\n"); // no trailing newline: the write was cut
    const out = opencodePlainResult({ stdout: cut, stderr: "", exitCode: 124, success: false });
    // The text before and after the step_finish belongs to two steps (lane AN1).
    expect(out.stdout).toBe("the reply so far\n\nmore of the reply\n");
    expect(out.stdout).not.toContain('"type"');
    expect(out.usage!.total_tokens).toBe(11);
    expect(out.stderr).toContain("were not the wire");
    expect(out.exitCode).toBe(124);
  });

  test("an unparseable line among wire lines is a diagnostic, never a dumped stream (ul3)", () => {
    const noisy = [part("the reply"), "not json at all", stepFinish({ input: 5, output: 5, total: 10 })].join("\n") + "\n";
    const out = opencodePlainResult(finished(noisy));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.stderr).toContain("not the wire");
    expect(out.usage!.total_tokens).toBe(10);
  });

  test("a CRLF wire's blank lines are framing whitespace, never break notes (review round 147)", () => {
    // Every line ends with \r\n and the harness sends one blank line
    // between frames: the wire lines parse with their carriage return,
    // and the lone \r is not counted as a line that was not the wire.
    const crlf = [part("the reply"), "", stepFinish({ input: 5, output: 5, total: 10 })]
      .join("\r\n") + "\r\n";
    const out = opencodePlainResult(finished(crlf));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(10);
    expect(out.stderr).toBe("");
  });

  test("a non-JSON line with no wire evidence is the escape hatch: stdout verbatim, nothing recorded", () => {
    const out = opencodePlainResult(finished("hello\n"));
    expect(out).toEqual(finished("hello\n"));
    expect(out.usage).toBeUndefined();
  });

  test("a zero-exit run that printed nothing is a failed run, not an empty success (round 259)", () => {
    // Both arms of the fold: the whole-capture verdict and the streaming
    // sink (whose finish() answers the raw bytes the runner puts on
    // stdout). Before round 259 empty stdout took the escape hatch and a
    // harness that exited zero without its stream kept a success with no
    // reply.
    for (const stdout of ["", "  \n"]) {
      const out = opencodePlainResult(finished(stdout));
      expect(out.success, JSON.stringify(stdout)).toBe(false);
      expect(out.exitCode, JSON.stringify(stdout)).toBe(1);
      expect(out.stdout, JSON.stringify(stdout)).toBe("");
      expect(out.stderr, JSON.stringify(stdout)).toContain("produced no output");
    }
    const stream = new OpenCodePlainFold();
    expect(stream.verdict(finished("")).success).toBe(false);
    const failedRun = { stdout: "", stderr: "boom", exitCode: 2, success: false };
    expect(opencodePlainResult(failedRun)).toEqual(failedRun);
  });

  test("a lone malformed event is a failed structured stream, never a plain reply (round 259)", () => {
    // A JSON-object line IS the wire's grammar even when the event's
    // payload breaks it — here a text line with no part, its sessionID
    // validated. Before round 259 such a line left the hatch open, so the
    // raw JSON passed through verbatim as a successful reply. It is wire
    // evidence now: the run fails with the break named and no wire on
    // stdout. A JSON object without a sessionID fails the same way; plain
    // text (the test above) still takes the hatch.
    const malformed = JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef" });
    const out = opencodePlainResult(finished(`${malformed}\n`));
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stdout).not.toContain("sessionID");
    expect(out.stderr).toContain("no assistant text");
    expect(out.stderr).toContain("a text line carries no text part");
    const noSession = opencodePlainResult(finished('{"type":"text"}\n'));
    expect(noSession.success).toBe(false);
    expect(noSession.stderr).toContain("carries no sessionID");
  });

  test("an error line fails the run even at exit 0", () => {
    const errored = [
      part("partial"),
      JSON.stringify({ type: "error", sessionID: "ses_0123456789abcdef", error: { message: "provider down" } }),
    ].join("\n") + "\n";
    const out = opencodePlainResult(finished(errored));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("provider down");
  });

  test("an error line keeps the streamed text on stdout and records the usage it reported (ul2)", () => {
    const errored = [
      part("partial"),
      stepFinish({ input: 9, output: 4, cache: { read: 1, write: 0 }, total: 14 }, 0),
      JSON.stringify({ type: "error", sessionID: "ses_0123456789abcdef", error: { message: "provider down" } }),
    ].join("\n") + "\n";
    const out = opencodePlainResult(finished(errored));
    expect(out.success).toBe(false);
    // The stdout contract holds on failure: the text plain mode would
    // have streamed before the error, never the JSON wire.
    expect(out.stdout).toBe("partial\n");
    expect(out.stdout).not.toContain('"type"');
    expect(out.stderr).toContain("provider down");
    // The tokens were spent even though the run failed: the step's usage
    // is recorded, not dropped.
    expect(out.usage).toEqual({
      input_tokens: 9,
      output_tokens: 4,
      cached_input_tokens: 1,
      total_tokens: 14,
      cost_usd: 0,
    });
  });

  test("a wire with no assistant text is a failed run that still records its usage (ul3)", () => {
    const bare = `${stepFinish({ input: 1, output: 1 })}\n`;
    const out = opencodePlainResult(finished(bare));
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("no assistant text");
    // The step's tokens were spent; a run with no reply is not a run with
    // no usage (the error and success paths already kept theirs).
    expect(out.usage).toEqual({
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });
});
