import { describe, expect, test } from "bun:test";
import {
  agyPlainResult,
  claudeFamilyPlainResult,
  codexPlainResult,
  OpenCodePlainFold,
  opencodePlainResult,
} from "../src/plain-unwrap.js";
import { emptyUsage } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunResult } from "../src/types.js";

// The plain-run unwrap's contract: a harness launched in its structured
// mode prints its final message on stdout byte for byte as plain mode
// would have, while usage and the served model ride the RunResult for
// the call ledger. Stdout that is not the structured wire passes through
// verbatim (the escape hatch), and a recognized wire obeys the envelope
// path's verdict rules.

function finished(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0, success: true };
}

const CLAUDE_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: null,
  result: "OK",
  usage: { input_tokens: 24114, output_tokens: 98, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 },
  total_cost_usd: 0.12735,
  modelUsage: { "claude-opus-5": {} },
});

describe("claudeFamilyPlainResult", () => {
  test("unwraps the envelope to the reply, byte for byte", () => {
    const out = claudeFamilyPlainResult(finished(`${CLAUDE_ENVELOPE}\n`), "claude");
    expect(out.stdout).toBe("OK\n");
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.usage).toEqual({
      input_tokens: 24114,
      output_tokens: 98,
      cached_input_tokens: 320,
      total_tokens: 24532,
      cost_usd: 0.12735,
    });
    expect(out.servedModel).toBe("claude-opus-5");
  });

  test("a multi-line result keeps its embedded newlines and gains only the trailing one", () => {
    const out = claudeFamilyPlainResult(
      finished(JSON.stringify({ type: "result", result: "line one\nline two" })),
      "zai"
    );
    expect(out.stdout).toBe("line one\nline two\n");
  });

  test("stdout that is not the envelope passes through verbatim with no usage", () => {
    // An older binary or a wrapper that strips --output-format json: the
    // run is unchanged and the ledger gets nothing rather than a guess.
    const out = claudeFamilyPlainResult(finished("OK\n"), "claude");
    expect(out).toEqual(finished("OK\n"));
    expect(out.usage).toBeUndefined();
    expect(out.servedModel).toBeUndefined();
  });

  test("a truncated envelope never passes through: failed run, empty stdout (ul3)", () => {
    // The envelope is one write at the end, so a timeout or the capture
    // cap can cut it mid-object. Before ul3 the JSON fragment passed
    // through verbatim as a successful reply.
    const cut = `{"type":"result","subtype":"success","is_error":false,"result":"the rea`;
    const out = claudeFamilyPlainResult({ stdout: cut, stderr: "", exitCode: 124, success: false }, "claude");
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(124);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
    expect(out.usage).toBeUndefined();
  });

  test("a complete JSON object that is not the envelope fails the same way (ul3)", () => {
    const out = claudeFamilyPlainResult(finished('{"foo":1}\n'), "zai");
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
  });

  test("a JSON array, or any JSON that is not the envelope, never passes through as the reply (ul7)", () => {
    // The ul7 defect: the escape hatch checked only for a leading `{`, so
    // stdout starting with `[` was returned verbatim as a successful reply
    // with no usage — JSON on a launch that asked for JSON output is the
    // wire's grammar, a structured stream that broke, never a plain reply.
    for (const stdout of ['[{"items":[]}]\n', "42\n", '"quoted"\n', "true\n"]) {
      const claude = claudeFamilyPlainResult(finished(stdout), "claude");
      expect(claude.success, stdout).toBe(false);
      expect(claude.stdout, stdout).toBe("");
      expect(claude.stderr, stdout).toContain("truncated or unrecognized");
      expect(claude.usage, stdout).toBeUndefined();
    }
    const zai = claudeFamilyPlainResult(finished("[1,2,3]\n"), "zai");
    expect(zai.success).toBe(false);
    expect(zai.stdout).toBe("");
    expect(zai.stderr).toContain("truncated or unrecognized");
  });

  test("stdout that opens with '[' but is not JSON keeps the escape hatch (ul7)", () => {
    // The ul7 line is JSON, not a leading bracket: an argv echo like
    // `[--safe-mode][--tools][]` is not a JSON array — not anything a
    // --output-format json launch would print — so it passes through like
    // any other plain text (cli-run.test.ts pins the same shape through
    // the real CLI), while a real array does not (the test above).
    const echo = finished("[--safe-mode][--tools][]\n");
    const out = claudeFamilyPlainResult(echo, "claude");
    expect(out).toEqual(echo);
    expect(out.usage).toBeUndefined();
  });

  test("an error result fails the run but still records its usage", () => {
    const out = claudeFamilyPlainResult(
      finished(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" })),
      "claude"
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("error_during_execution");
    expect(out.usage).toEqual(emptyUsage());
  });

  test("an error result prints the harness's error text, never the JSON wire (ul2)", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "the tool run failed after three retries",
      usage: { input_tokens: 10, output_tokens: 2 },
      total_cost_usd: 0.01,
    });
    const out = claudeFamilyPlainResult(finished(envelope), "claude");
    expect(out.success).toBe(false);
    // The stdout contract holds on failure: the error text plain mode
    // would have printed, and nothing else — the envelope never leaks.
    expect(out.stdout).toBe("the tool run failed after three retries\n");
    expect(out.stdout).not.toContain('"type"');
    expect(out.stderr).toContain("error_during_execution");
    expect(out.usage!.input_tokens).toBe(10);
  });

  test("a result with no text is a failed run, not an empty success", () => {
    const out = claudeFamilyPlainResult(
      finished(JSON.stringify({ type: "result", result: "   " })),
      "zai"
    );
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("no result text");
  });

  test("multiple served models report no single effective model", () => {
    const out = claudeFamilyPlainResult(
      finished(
        JSON.stringify({
          type: "result",
          result: "OK",
          modelUsage: { "claude-opus-5": {}, "claude-haiku-4": {} },
        })
      ),
      "claude"
    );
    expect(out.stdout).toBe("OK\n");
    expect(out.servedModel).toBeNull();
  });
});

describe("agyPlainResult", () => {
  test("unwraps the response field to the reply with usage", () => {
    // agy's input_tokens includes the cache reads; the normalized block
    // splits them apart (result-envelope.ts's documented arithmetic).
    const out = agyPlainResult(
      finished(
        JSON.stringify({
          status: "SUCCESS",
          response: "done",
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 },
        })
      )
    );
    expect(out.stdout).toBe("done\n");
    expect(out.success).toBe(true);
    expect(out.usage).toEqual({
      input_tokens: 8,
      output_tokens: 4,
      cached_input_tokens: 2,
      total_tokens: 14,
      cost_usd: null,
    });
  });

  test("stdout that is not the agy envelope passes through verbatim", () => {
    const out = agyPlainResult(finished("done\n"));
    expect(out).toEqual(finished("done\n"));
    expect(out.usage).toBeUndefined();
  });

  test("an error status fails the run", () => {
    const out = agyPlainResult(
      finished(JSON.stringify({ status: "ERROR", error: "quota", response: null }))
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("quota");
  });

  test("an error status prints the response text, never the JSON wire; no response prints nothing (ul2)", () => {
    const withText = agyPlainResult(
      finished(
        JSON.stringify({ status: "ERROR", error: "quota", response: "the partial answer" })
      )
    );
    expect(withText.success).toBe(false);
    expect(withText.stdout).toBe("the partial answer\n");
    expect(withText.stdout).not.toContain('"status"');
    const withoutText = agyPlainResult(
      finished(JSON.stringify({ status: "ERROR", error: "quota", response: null }))
    );
    expect(withoutText.success).toBe(false);
    expect(withoutText.stdout).toBe("");
  });

  test("a truncated envelope never passes through: failed run, empty stdout (ul4)", () => {
    // The envelope is one JSON object, so a kill or the capture cap leaves
    // a `{`-shaped stdout the parser cannot take. Before ul4 it passed
    // through verbatim as a successful reply.
    const cut = `{"status":"SUCCESS","response":"the rea`;
    const out = agyPlainResult({ stdout: cut, stderr: "", exitCode: 124, success: false });
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(124);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
    expect(out.usage).toBeUndefined();
  });

  test("a complete JSON object that is not the agy envelope fails the same way (ul4)", () => {
    const out = agyPlainResult(finished('{"foo":1}\n'));
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
  });

  test("a JSON array on agy stdout fails like every other JSON non-envelope (ul7)", () => {
    // The claude family's ul7 defect, checked in agy's twin: the hatch
    // opened for any stdout without a leading `{`, so an array passed
    // through as the reply with no usage.
    const out = agyPlainResult(finished('[{"status":"SUCCESS"}]\n'));
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("truncated or unrecognized");
    expect(out.usage).toBeUndefined();
  });
});

describe("codexPlainResult", () => {
  // A plain run keeps human mode (review ul3): stdout is the reply verbatim
  // and the usage is the `tokens used` figure codex prints on stderr at the
  // run's end. The stream-reduction tests live with codexResult in
  // result-envelope.test.ts; these pin the plain path.
  const stderrWithFigure = (figure: string): string =>
    `working...\ntokens used\n${figure}\n`;

  test("passes human-mode stdout through verbatim and records the stderr figure", () => {
    const out = codexPlainResult({
      stdout: "the reply\n",
      stderr: stderrWithFigure("2,048"),
      exitCode: 0,
      success: true,
    });
    expect(out.stdout).toBe("the reply\n");
    expect(out.success).toBe(true);
    // The figure is blended — (input − cached) + output — so it lands in
    // total_tokens alone; the parts cannot be recovered and stay null.
    expect(out.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: 2048,
      cost_usd: null,
    });
    expect(out.servedModel).toBeNull();
  });

  test("a stderr without the figure records nothing", () => {
    const raw = { stdout: "the reply\n", stderr: "no summary here\n", exitCode: 0, success: true };
    expect(codexPlainResult(raw)).toEqual(raw);
    expect(codexPlainResult(raw).usage).toBeUndefined();
  });

  test("the label matches after ANSI styling and locale separators parse", () => {
    const styled = {
      stdout: "the reply\n",
      stderr: `\x1b[90mtokens used\x1b[0m\n\x1b[90m2'048\x1b[0m\n`,
      exitCode: 0,
      success: true,
    };
    expect(codexPlainResult(styled).usage!.total_tokens).toBe(2048);
    const narrow = {
      stdout: "the reply\n",
      stderr: `tokens used\n2 048\n`,
      exitCode: 0,
      success: true,
    };
    expect(codexPlainResult(narrow).usage!.total_tokens).toBe(2048);
  });

  test("the figure must be a separated number, else nothing is recorded", () => {
    const words = {
      stdout: "the reply\n",
      stderr: stderrWithFigure("2,048 tokens"),
      exitCode: 0,
      success: true,
    };
    expect(codexPlainResult(words).usage).toBeUndefined();
  });

  test("the last label wins when stderr repeats it", () => {
    const chatty = {
      stdout: "the reply\n",
      stderr: `tokens used\n999\nharness chatter\ntokens used\n515\n`,
      exitCode: 0,
      success: true,
    };
    // The scan runs from the end: the run's own trailing figure, not an
    // earlier line the transcript embedded.
    expect(codexPlainResult(chatty).usage!.total_tokens).toBe(515);
  });
});

describe("opencodePlainResult", () => {
  // Every run-output wire line carries the sessionID the parser's gate
  // requires (session/opencode-session.ts).
  const part = (text: string): string =>
    JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text } });
  const stepFinish = (tokens: Record<string, unknown>, cost: number | null = null): string =>
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens, cost },
    });

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
    expect(out.stdout).toBe("the reply so far\nmore of the reply\n");
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

  test("a non-JSON line with no wire evidence is the escape hatch: stdout verbatim, nothing recorded", () => {
    const out = opencodePlainResult(finished("hello\n"));
    expect(out).toEqual(finished("hello\n"));
    expect(out.usage).toBeUndefined();
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

describe("OpenCodePlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--format json` stream (review ul4). The part/stepFinish builders from
  // the whole-capture describe apply here too.
  const part = (text: string): string =>
    JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text } });
  const stepFinish = (tokens: Record<string, unknown>, cost: number | null = null): string =>
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens, cost },
    });
  const toolUse = (output: string): string =>
    JSON.stringify({
      type: "tool_use",
      sessionID: "ses_0123456789abcdef",
      part: { id: "cal_1", tool: "read", state: { status: "completed", input: {}, output } },
    });

  /** Feeds `stream` through the fold in chunks of `size` bytes, the way
   * the runner's decoded chunks arrive — awkward boundaries included. */
  const foldStream = (stream: string, size = 7): OpenCodePlainFold => {
    const fold = new OpenCodePlainFold();
    for (let i = 0; i < stream.length; i += size) fold.push(stream.slice(i, i + size));
    return fold;
  };

  test("tool parts are dropped as they arrive: no volume of tool output reaches the bound (ul4)", () => {
    // The finding's shape: the JSON stream carries every tool's output,
    // so a whole-capture run dies at exit 125. The fold keeps only the
    // text and the folded usage.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    const blob = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) fold.push(`${toolUse(blob)}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    expect(fold.keptBytes()).toBeLessThan(1024); // 20 MiB streamed, ~0 kept
    const out = fold.verdict(finished(""));
    expect(out.stdout).toBe("the reply\n");
    expect(out.success).toBe(true);
    expect(out.usage!.total_tokens).toBe(11);
  });

  test("keptBytes counts UTF-8 bytes, the capture bound's unit — not code units (ul6)", () => {
    // The ul5 rework left the sum counting .length (UTF-16 code units), so
    // a multibyte reply could slip 2-3x past the bound by that measure;
    // both paths must enforce one bound in one unit. あ is 3 UTF-8 bytes.
    const hatch = new OpenCodePlainFold();
    hatch.push("あああ"); // plain stdout, no wire evidence: kept verbatim
    expect(hatch.keptBytes()).toBe(9);
    // The wire regime's reply text counts the same way: "あああ\n" is 10.
    const wire = new OpenCodePlainFold();
    wire.push(part("あああ") + "\n");
    expect(wire.keptBytes()).toBe(Buffer.byteLength("あああ\n"));
  });

  test("keptBytes is a running total: the per-chunk cost stays linear, not quadratic (ul7)", () => {
    // The ul7 defect: the fallback (hatch) path re-measured raw+buffer on
    // every keptBytes call, and the runner calls it after EVERY chunk
    // (process-runner.ts), so a plain reply delivered in small chunks paid
    // a full scan of the growing residue per chunk. The discriminator is
    // the framing pin's (session-process.test.ts): the SAME 12 MiB of
    // non-wire stdout fed in 1 MiB chunks versus 8 KiB chunks. Running
    // totals cost about the same either way; the re-measure scans the
    // residue once per chunk in the small feed. CPU time of this process
    // is measured, so the host's speed cancels out; no absolute bound.
    // Measured 2026-10-09: running totals 19 ms small / 10 ms large; with
    // the re-measure reinstated the small feed cost 361 ms against the
    // large feed's 4 ms — 80x apart, far past the 2x bound.
    const line = `${"x".repeat(8 * 1024 - 1)}\n`; // 8 KiB a line, ASCII
    const stream = line.repeat((12 * 1024 * 1024) / (8 * 1024));
    const feed = (size: number): { cpuMs: number; kept: number } => {
      const started = process.cpuUsage();
      const fold = new OpenCodePlainFold();
      for (let i = 0; i < stream.length; i += size) {
        fold.push(stream.slice(i, i + size));
        fold.keptBytes(); // the runner asks after every chunk
      }
      const spent = process.cpuUsage(started);
      return { cpuMs: (spent.user + spent.system) / 1000, kept: fold.keptBytes() };
    };
    const best = (size: number): number => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 2; i++) min = Math.min(min, feed(size).cpuMs);
      return min;
    };
    const small = best(8 * 1024);
    const large = best(1024 * 1024);
    expect(small).toBeLessThan(2 * large + 30);
    // The counters never drifted from the strings they measure: both feeds
    // end with the whole stream kept verbatim (raw, line by line) plus at
    // most two notes.
    const smallKept = feed(8 * 1024).kept;
    const largeKept = feed(1024 * 1024).kept;
    expect(smallKept).toBe(largeKept);
    expect(smallKept).toBeGreaterThanOrEqual(stream.length);
    expect(smallKept).toBeLessThan(stream.length + 1024);
  });

  test("one long line fed in 64 KiB chunks is scanned once, never rescan per chunk (ul8)", () => {
    // The ul8 defect: push searched the whole partial-line buffer for the
    // newline on every chunk, so a 15 MiB tool line arriving in 64 KiB
    // pipe chunks rescanned the 0–15 MiB already buffered each time (and
    // flattened the grown string per chunk) — gigabytes of scanning for a
    // 15 MiB stream. The search now covers the newly arrived chunk alone.
    // Counted, not timed: String.prototype.indexOf is intercepted for the
    // synchronous feed and the characters its calls examine are totaled,
    // then bounded against the linear reference — the stream's own length.
    // The rescan shape measures len²/(2·chunk) ≈ 1.7 GiB here, far past
    // the bound; the chunk-local scan stays at the stream's size.
    const header = `{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`;
    const closing = `"}}`;
    const bulk = "x".repeat(15 * 1024 * 1024 - header.length - closing.length);
    const stream =
      `${part("the reply")}\n${header}${bulk}${closing}\n` +
      `${stepFinish({ input: 8, output: 3, total: 11 })}\n`;
    let scanned = 0;
    const original = String.prototype.indexOf;
    String.prototype.indexOf = function (
      this: string,
      searchValue: string,
      fromIndex?: number
    ): number {
      scanned += Math.max(
        0,
        this.length - (typeof fromIndex === "number" ? fromIndex : 0)
      );
      return original.call(this, searchValue, fromIndex);
    } as typeof String.prototype.indexOf;
    let fold: OpenCodePlainFold;
    try {
      fold = new OpenCodePlainFold();
      const CHUNK = 64 * 1024;
      for (let i = 0; i < stream.length; i += CHUNK) {
        fold.push(stream.slice(i, i + CHUNK));
        fold.keptBytes(); // the runner asks after every chunk
      }
    } finally {
      String.prototype.indexOf = original;
    }
    // Linear: every character examined stays within a small constant
    // factor of the stream (the fold's own boundary searches are one pass;
    // JSON.parse is native and never routes through the interceptor).
    expect(scanned).toBeGreaterThan(0);
    expect(scanned).toBeLessThan(4 * stream.length);
    // Correct besides: the giant tool line parsed as wire noise, the reply
    // and the folded usage intact — the same verdict as ever.
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(11);
  });

  test("the oversized-line drop counts bytes, the bound's unit — not code units (ul7)", () => {
    // The ul6 contracts fix made keptBytes count bytes while the DROP
    // TRIGGER still counted .length: a multibyte line of 18 MiB in ~6M
    // code units stayed under a 16 MiB bound as the trigger read it, so
    // the drop never tripped, the line stayed buffered, and the byte
    // count pushed the run past the bound at exit 125 instead of dropping
    // the wire-shaped line the class contract promises to drop. あ is 3
    // bytes and 1 code unit.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    const bulk = "あ".repeat(6 * 1024 * 1024); // ~18 MiB, ~6M code units
    for (let i = 0; i < bulk.length; i += 1024 * 1024) {
      fold.push(bulk.slice(i, i + 1024 * 1024));
    }
    // The drop tripped on bytes: nothing of the line is kept.
    expect(fold.keptBytes()).toBeLessThan(1024);
    fold.push(`"}}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(11);
    expect(out.stderr).toContain("dropped unread");
  });

  test("foldedUsage reports the step_finish counts folded so far, or null (ul6)", () => {
    // The in-flight usage a signal interrupt's receipt records
    // (launch.ts): what finished steps reported, never a guess.
    const fold = new OpenCodePlainFold();
    expect(fold.foldedUsage()).toBeNull();
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }, 0) + "\n");
    expect(fold.foldedUsage()).toEqual({
      input_tokens: 8,
      output_tokens: 3,
      cached_input_tokens: null,
      total_tokens: 11,
      cost_usd: 0,
    });
  });

  test("one wire-shaped line over the whole capture bound is dropped unread with a note (ul4)", () => {
    // A single tool_use line larger than MAX_CAPTURE_BYTES cannot be
    // buffered without reintroducing the bound; it is the wire's grammar
    // (`{`-shaped), so it is dropped as wire noise and the run proceeds.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(11);
    expect(out.stderr).toContain("dropped unread");
  });

  test("an oversized non-wire line marks the run over the limit, never a silent truncation (ul4)", () => {
    // Bytes that could only have been the hatch's plain stdout: the fold
    // reports keptBytes past the bound so the runner fails at the capture
    // limit, exactly as a whole-capture run always did.
    const fold = new OpenCodePlainFold();
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
  });

  test("the discard tail of an oversized line is dropped chunk by chunk, never buffered (ul5)", () => {
    // The ul5 defect: after the first MAX_CAPTURE_BYTES of an oversized
    // line tripped the drop, later chunks of the same line piled back
    // into the buffer — keptBytes counted them, so a tool_use line of
    // ~32 MiB or more killed the run at exit 125 exactly as the
    // whole-stream capture once did. The tail is dropped whole now, and
    // keptBytes counts only what the fold really keeps.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1)); // trips the drop
    for (let i = 0; i < 24; i++) {
      // 24 more MiB of the same line, in the chunks the runner delivers.
      fold.push("x".repeat(1024 * 1024));
      expect(fold.keptBytes()).toBeLessThan(1024); // ~0 kept, 40 MiB in
    }
    fold.push(`"}}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(11);
    expect(out.stderr).toContain("dropped unread");
  });

  test("an oversized line as the very last output, unterminated, is still just dropped (ul5)", () => {
    // The stream ends inside the oversized line (no newline, process
    // exit): close() must fold nothing of it — the note was recorded
    // where the drop began.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(3 * MAX_CAPTURE_BYTES));
    expect(fold.keptBytes()).toBeLessThan(1024);
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage!.total_tokens).toBe(11);
    expect(out.stderr).toContain("dropped unread");
  });

  test("break notes are bounded residue: a flood of noise keeps keptBytes near the reply (ul5)", () => {
    // The ul5 contracts defect: every non-wire line grew `broken`, which
    // keptBytes never counted — 16 MiB of 2-byte lines was ~8M notes of
    // unmeasured heap. The fold now keeps the two notes the verdict
    // prints and a count, and keptBytes counts them: what is kept is
    // measured, and what is measured is bounded.
    const one = new OpenCodePlainFold();
    one.push("no\n");
    // Measured: keptBytes includes the note the fold is keeping (the
    // hatch regime also carries the raw line, tail byte included).
    expect(one.keptBytes()).toBeGreaterThan(30);
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    for (let i = 0; i < 100_000; i++) fold.push("no\n");
    // Bounded: 100k breaks later, the residue is still the reply and two
    // notes — never one heap entry per line.
    expect(fold.keptBytes()).toBeLessThan(1024);
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("the reply\n");
    expect(out.stderr).toContain("100000 opencode output line(s) were not the wire");
    expect(out.stderr).toContain("an unparseable line of 2 bytes");
  });

  test("the escape hatch keeps plain stdout verbatim, tail byte included (ul4)", () => {
    // No wire evidence: the bytes are the reply a binary that ignored
    // --format json printed. The unterminated tail gains no newline the
    // stream never sent.
    expect(foldStream("hello\n").finish()).toBe("hello\n");
    expect(foldStream("OK").finish()).toBe("OK");
    const out = foldStream("hello\n").verdict(finished("hello\n"));
    expect(out).toEqual(finished("hello\n"));
    expect(out.usage).toBeUndefined();
  });

  test("the sink and the whole-capture fold agree on every verdict shape (ul4)", () => {
    // One shared fold and verdict is the design; this pins it. The same
    // stdout, streamed in 7-byte chunks versus handed over whole, must
    // produce equal RunResults — success, error, cut-off tail, and noise
    // among wire lines alike.
    const cut = [
      part("the reply so far"),
      stepFinish({ input: 8, output: 3, total: 11 }),
      part("more of the reply"),
      `{"type":"step_finish","timestamp":1791489571351,"sessionID":"ses_01234567`,
    ].join("\n"); // no trailing newline: the write was cut
    const shapes: Array<[string, RunResult]> = [
      ["success", finished([part("hel"), part("lo"), stepFinish({ input: 8, output: 3, total: 11 })].join("\n") + "\n")],
      ["error", finished([part("partial"), JSON.stringify({ type: "error", sessionID: "ses_0123456789abcdef", error: { message: "provider down" } })].join("\n") + "\n")],
      ["cut-off", { stdout: cut, stderr: "", exitCode: 124, success: false }],
      ["noise", finished([part("the reply"), "not json at all", stepFinish({ input: 5, output: 5, total: 10 })].join("\n") + "\n")],
      ["hatch", finished("hello\n")],
    ];
    for (const [label, result] of shapes) {
      expect(foldStream(result.stdout).verdict(result), label).toEqual(
        opencodePlainResult(result)
      );
    }
  });
});
