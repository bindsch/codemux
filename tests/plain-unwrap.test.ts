import { describe, expect, test } from "bun:test";
import {
  agyPlainResult,
  claudeFamilyPlainResult,
  CodexPlainFold,
  codexPlainResult,
  codexPlainStreamResult,
  type CodexPlanFallbackRead,
  OpenCodePlainFold,
  opencodePlainResult,
} from "../src/plain-unwrap.js";
import {
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  codexWarningNote,
  codexWarningNoteBytes,
  emptyUsage,
  parseCodexEventStream,
} from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunResult } from "../src/types.js";

// The plain-run unwrap's contract: a harness launched in its structured
// mode prints its final message on stdout byte for byte as plain mode
// would have, while usage and the served model ride the RunResult for
// the call ledger. Stdout that is not the structured wire passes through
// verbatim (the escape hatch), and a recognized wire obeys the envelope
// path's verdict rules — the one lift is codex's completed messageless
// turn, which succeeds with empty stdout as human mode exited 0 for it
// (round al10, the CodexPlainFold tests below).

function finished(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0, success: true };
}

/** The runner's capture-limit result for a latched fold, modeled exactly
 * as runCapturedCommand answers an OutputLimitError (round al37): exit
 * 125, success false, the partial output (the fold's finish()) on
 * stdout, and the Error line on stderr — the fold's own verdict never
 * runs on that path, so its break notes are not in this stderr. */
function captureLimitResult(partial: string, stderr = ""): RunResult {
  const separator = stderr.length > 0 && !stderr.endsWith("\n") ? "\n" : "";
  return {
    stdout: partial,
    stderr: `${stderr}${separator}Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
    exitCode: 125,
    success: false,
  };
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

  /** Feeds `stream` through the fold in chunks of `size` UTF-16 code units
   * — the slice bounds are code units, not bytes (round al17; a multibyte
   * character makes a chunk more bytes than units, and any grouping is
   * legal) — the way the runner's decoded chunks arrive, awkward
   * boundaries included. */
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
    // the drop never tripped and the line stayed buffered. あ is 3 bytes
    // and 1 code unit, so the byte count crosses the bound while the
    // code-unit count is still far under it — only the byte measure
    // trips. Round al37's rule latches the run at that trip: keptBytes
    // answers MAX + 1 and the runner fails the run at the capture limit
    // (exit 125), whatever the multibyte spelling.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    const bulk = "あ".repeat(6 * 1024 * 1024); // ~18 MiB, ~6M code units
    for (let i = 0; i < bulk.length; i += 1024 * 1024) {
      fold.push(bulk.slice(i, i + 1024 * 1024));
    }
    // The drop tripped on bytes (~18 MiB buffered) while the code-unit
    // count (~6M) sat under the 16.7M bound: the latch owns the line.
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    const closing = fold as unknown as { overflowed: boolean };
    expect(closing.overflowed).toBe(true);
    // The modeled runner result: exit 125, the partial output on stdout.
    expect(captureLimitResult(fold.finish())).toEqual({
      stdout: "the reply\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
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

  test("one wire-shaped line over the whole capture bound fails the run at the capture limit (ul4, al37)", () => {
    // A single tool_use line larger than MAX_CAPTURE_BYTES cannot be
    // buffered without reintroducing the bound, and round al37's rule is
    // one answer for it whatever its shape: the latch fires at the drop
    // and the run fails at the capture limit — exit 125, the reply
    // folded before the line as the partial output. The wire regime the
    // part line committed changes nothing; the al19 classifier that once
    // let tool parts die quietly is deleted.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    // Mid-accumulation latch: the bound crossed while the line is
    // unterminated, before any newline arrives.
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    fold.push(`"}}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    // Nothing after the latch folds: the later lines are the pipe's
    // business, never the run's.
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(captureLimitResult(fold.finish())).toEqual({
      stdout: "the reply\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
  });

  test("an oversized line while the hatch is open fails the run at once; only a line READ WHOLE frees the hatch's bytes (al21, al37)", () => {
    // Round al37 deletes al35's provisional latch with the regime it
    // served: an oversized line is a capture-limit failure whatever the
    // stream's regime, the hatch's undecided one included — the latch
    // fires at the drop itself, mid-stream, so keptBytes answers
    // MAX + 1 to the very next poll the runner makes, and no line read
    // whole later can reclassify bytes the fold dropped unread. No
    // bounded prefix joins raw either (the opencode arm of al35/al36 is
    // gone): the partial output is the whole lines the hatch held before
    // the drop and nothing of the line itself. The al21 read-side rule
    // survives untouched, pinned below: the first wire line read whole is
    // what frees the hatch's bytes.
    const fold = new OpenCodePlainFold();
    // Hatch stdout: one plain line, no wire evidence yet.
    fold.push("plain stdout line one\n");
    const hatched = fold as unknown as { raw: string; rawBytes: number };
    expect(hatched.rawBytes).toBeGreaterThan(0);
    // The oversized wire-SHAPED line with the hatch open: the latch
    // fires at the drop, not at close — the drop's own moment.
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect((fold as unknown as { state: { sawWire: boolean } }).state.sawWire).toBe(false);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    // Wire lines read whole arrive after the latch: nothing folds, the
    // regime stays undecided, and nothing is freed.
    fold.push(`"}}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    fold.push(part("the reply") + "\n");
    expect((fold as unknown as { state: { sawWire: boolean } }).state.sawWire).toBe(false);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    // The partial output is the hatch's whole lines alone — no bounded
    // prefix of the dropped line survives al37 — and the modeled runner
    // result fails at the capture limit.
    expect(fold.finish()).toBe("plain stdout line one\n");
    expect(captureLimitResult("plain stdout line one\n")).toEqual({
      stdout: "plain stdout line one\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });

    // The al21 rule, read side: a wire line read whole is the wire
    // evidence that frees the hatch's bytes at that moment.
    const read = new OpenCodePlainFold();
    read.push("plain stdout line one\n");
    read.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    read.push(part("the reply") + "\n");
    const readHatched = read as unknown as { raw: string; rawBytes: number };
    const readOut = read.verdict(finished(""));
    expect(readOut.success).toBe(true);
    expect(readOut.stdout).toBe("the reply\n");
    expect(readOut.usage!.total_tokens).toBe(11);
    // Nothing was dropped: the freed bytes leave no note behind.
    expect(readOut.stderr).not.toContain("dropped unread");
    // The hatch's bytes are freed at the same moment takeLine frees them.
    expect(readHatched.raw).toBe("");
    expect(readHatched.rawBytes).toBe(0);
  }, 30_000);

  test("an oversized wire line latches identically whatever chunk its newline shares (al16, al37)", () => {
    // The codex fold's chunk-boundary finding, mirrored here: the drop
    // must fire at both moments the fold can meet the line —
    // mid-accumulation and complete in one chunk — or the pipe's read
    // grouping decides the verdict. Round al37's latch makes the frozen
    // state identical under every delivery: same keptBytes, same partial
    // output, same exit 125.
    const header = `{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`;
    const closing = `"}}`;
    const giant = header + "x".repeat(MAX_CAPTURE_BYTES + 1) + closing;
    const stream =
      `${part("the reply")}\n${giant}\n` +
      `${stepFinish({ input: 8, output: 3, total: 11 })}\n`;
    const foldOf = (first: number, size: number): OpenCodePlainFold => {
      const fold = new OpenCodePlainFold();
      fold.push(stream.slice(0, first));
      for (let at = first; at < stream.length; at += size) {
        fold.push(stream.slice(at, at + size));
      }
      return fold;
    };
    for (const [label, fold] of [
      ["whole", foldOf(stream.length, stream.length)],
      ["64 KiB", foldOf(0, 64 * 1024)],
      ["256-byte first chunk", foldOf(256, 64 * 1024)],
    ] as Array<readonly [string, OpenCodePlainFold]>) {
      expect(fold.keptBytes(), label).toBe(MAX_CAPTURE_BYTES + 1);
      expect(fold.finish(), label).toBe("the reply\n");
      expect(captureLimitResult("the reply\n"), label).toEqual({
        stdout: "the reply\n",
        stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
        exitCode: 125,
        success: false,
      });
    }
  });

  test("an oversized text part and an oversized tool part fail the run alike: the capture limit, whatever the event's type (al19, al37)", () => {
    // The review's probe, re-answered by round al37's one rule: a final
    // text event past the capture bound once succeeded on the strength
    // of a head classifier that let tool parts die quietly, and the
    // al19 fix answered the two heads differently (drift for the text
    // part, harmless drop for the tool part). The classifier is deleted:
    // the line's size fails the run at the capture limit — exit 125, the
    // partial output the fold held — whatever the line's type tag says.
    const textHeader = `{"type":"text","sessionID":"ses_0123456789abcdef","part":{"text":"`;
    const toolHeader = `{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`;
    const closing = `"}}`;
    const streamOf = (header: string): string =>
      `${part("an earlier line")}\n${header}${"x".repeat(MAX_CAPTURE_BYTES + 1)}${closing}\n` +
      `${stepFinish({ input: 8, output: 3, total: 11 })}\n`;
    const foldOf = (stream: string, first: number, size: number): OpenCodePlainFold => {
      const fold = new OpenCodePlainFold();
      fold.push(stream.slice(0, first));
      for (let at = first; at < stream.length; at += size) {
        fold.push(stream.slice(at, at + size));
      }
      return fold;
    };
    for (const [label, first, size] of [
      ["whole", Infinity, 0],
      ["64 KiB", 0, 64 * 1024],
      ["256-byte first chunk", 256, 64 * 1024],
    ] as Array<readonly [string, number, number]>) {
      for (const [headLabel, header] of [
        ["text part", textHeader],
        ["tool part", toolHeader],
      ] as Array<readonly [string, string]>) {
        const fold = foldOf(streamOf(header), first, size);
        expect(fold.keptBytes(), `${label}/${headLabel}`).toBe(MAX_CAPTURE_BYTES + 1);
        expect(fold.finish(), `${label}/${headLabel}`).toBe("an earlier line\n");
        expect(
          captureLimitResult("an earlier line\n"),
          `${label}/${headLabel}`
        ).toEqual({
          stdout: "an earlier line\n",
          stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
          exitCode: 125,
          success: false,
        });
      }
    }
  });

  test("an oversized error event fails the run at the capture limit; its small spelling keeps the error arm (al19, al37)", () => {
    // The review's second probe: a healthy reply, then an error event
    // past the capture bound. The small spelling fails the run through
    // the error arm (opencode's own message, the text kept on stdout);
    // the oversized spelling is a capture-limit failure now — exit 125,
    // the same one answer every oversized line gets, the head unread
    // (the al19 drift arm and its classifier are deleted).
    const header = `{"type":"error","sessionID":"ses_0123456789abcdef","error":{"message":"`;
    const closing = `"}}`;
    const oversized =
      `${part("the reply")}\n${header}${"x".repeat(MAX_CAPTURE_BYTES + 1)}${closing}\n` +
      `${stepFinish({ input: 8, output: 3, total: 11 })}\n`;
    const fold = new OpenCodePlainFold();
    fold.push(oversized);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n")).toEqual({
      stdout: "the reply\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
    // The small spelling keeps its own verdict: failed, the text plain
    // mode had printed kept on stdout (the error arm).
    const small = new OpenCodePlainFold();
    small.push(
      `${part("the reply")}\n${JSON.stringify({
        type: "error",
        sessionID: "ses_0123456789abcdef",
        error: { message: "the model provider failed" },
      })}\n`
    );
    const smallOut = small.verdict(finished(""));
    expect(smallOut.success).toBe(false);
    expect(smallOut.stdout).toBe("the reply\n");
    expect(smallOut.stderr).toContain("the model provider failed");
  });

  test("an oversized wire line the head cannot classify answers like the identified one: no classifier exists (al19, al37)", () => {
    // A sender (a wrapper, a reordered writer) can put the type tag last
    // or spell keys in another order; the al19 classifier that read the
    // head to tell a text part from a tool part is deleted, so the
    // unidentified head and the identified one take the same single
    // answer — the capture limit, exit 125.
    const header = `{"sessionID":"ses_0123456789abcdef","part":{"text":"`;
    const closing = `"},"type":"text"}`;
    const stream =
      `${part("the reply")}\n${header}${"x".repeat(MAX_CAPTURE_BYTES + 1)}${closing}\n` +
      `${stepFinish({ input: 8, output: 3, total: 11 })}\n`;
    const fold = new OpenCodePlainFold();
    fold.push(stream);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n").exitCode).toBe(125);
  });

  test("an oversized non-wire line marks the run over the limit at once, never a silent truncation (ul4, al37)", () => {
    // Bytes that could only have been the hatch's plain stdout: the fold
    // reports keptBytes past the bound so the runner fails at the capture
    // limit, exactly as a whole-capture run always did. Round al37 moves
    // the latch to the drop itself — no provisional arming, no waiting
    // for close: the very next poll the runner makes answers over.
    const fold = new OpenCodePlainFold();
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    fold.finish();
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
  });

  test("an oversized human-mode line fails at the capture limit with the whole lines kept before it (al37)", () => {
    // Round al37 deletes the opencode arm of al31/al35's prefix
    // retention: nothing of the dropped line joins raw, so the partial
    // output the capture-limit result carries is the hatch's whole lines
    // alone — the line's first bytes are as unread as its last. The
    // latch fires at the drop, mid-stream.
    const line = "y".repeat(MAX_CAPTURE_BYTES + 1); // ASCII: bytes are chars
    const fold = new OpenCodePlainFold();
    fold.push("plain stdout line one\n");
    fold.push(line + "\n");
    // The latch fired at the completed line's own drop — no newline
    // needed, no close needed.
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    const partial = fold.finish();
    expect(partial).toBe("plain stdout line one\n"); // no prefix of `line`
    expect(captureLimitResult(partial)).toEqual({
      stdout: "plain stdout line one\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
  }, 30_000);

  test("an oversized non-wire line after wire evidence fails at the capture limit; its small spelling survives (al17, al37)", () => {
    // A non-`{` line after the wire proved itself is a broken-wire line;
    // its small spelling (foldOpenCodeLine's unusable arm) answers a
    // stderr note and the run survives. The al17 rule once made the
    // oversized spelling answer the same; round al37 deliberately lets
    // size decide this one — the bound is stated on what a line is, and
    // every oversized line answers the capture limit, wire or not.
    const giant = "x".repeat(MAX_CAPTURE_BYTES + 1);
    const oversizeStream =
      `${part("the reply")}\n${giant}\n` +
      `${stepFinish({ input: 8, output: 3, total: 11 })}\n`;
    const small = new OpenCodePlainFold();
    small.push(
      `${part("the reply")}\nnot json at all\n` +
        `${stepFinish({ input: 8, output: 3, total: 11 })}\n`
    );
    const smallOut = small.verdict(finished(""));
    expect(smallOut.success).toBe(true);
    expect(smallOut.stdout).toBe("the reply\n");
    expect(smallOut.usage!.total_tokens).toBe(11);
    expect(smallOut.stderr).toContain("were not the wire");
    expect(small.keptBytes()).toBeLessThan(1024);
    // The oversized spelling: the latch at the completed line's drop.
    const fold = new OpenCodePlainFold();
    fold.push(oversizeStream);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    // And with the hatch open, the same oversized non-`{` line latches
    // mid-stream just the same (the ul4 pin above).
    const hatchFold = new OpenCodePlainFold();
    hatchFold.push(giant + "\n");
    expect(hatchFold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    hatchFold.finish();
    expect(hatchFold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
  });

  test("after the drop, the oversized line's tail never touches the fold (ul5, al37)", () => {
    // The ul5 defect: after the first MAX_CAPTURE_BYTES of an oversized
    // line tripped the drop, later chunks of the same line piled back
    // into the buffer — keptBytes counted them, so a tool_use line of
    // ~32 MiB or more killed the run at exit 125 exactly as the
    // whole-stream capture once did. The latch's top guard is the rule
    // now: every later chunk — the line's tail, its newline, whole
    // events after it — is dropped at push's first line, and keptBytes
    // stays at the latch's MAX + 1 for the stream's whole remainder.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1)); // trips the drop
    for (let i = 0; i < 24; i++) {
      // 24 more MiB of the same line, in the chunks the runner delivers.
      fold.push("x".repeat(1024 * 1024));
      expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1); // latched
    }
    fold.push(`"}}\n`);
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n").exitCode).toBe(125);
  });

  test("an oversized line as the very last output, unterminated, latches at the bound (ul5, al37)", () => {
    // The stream ends inside the oversized line (no newline, process
    // exit): the trailing check is the drop's second moment, and the
    // latch fires there — close() folds nothing of the tail.
    const fold = new OpenCodePlainFold();
    fold.push(part("the reply") + "\n");
    fold.push(stepFinish({ input: 8, output: 3, total: 11 }) + "\n");
    fold.push(`{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`);
    fold.push("x".repeat(3 * MAX_CAPTURE_BYTES));
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n").exitCode).toBe(125);
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

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.
  const THREAD = JSON.stringify({
    type: "thread.started",
    thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e",
  });
  const turnStarted = (): string => JSON.stringify({ type: "turn.started" });
  const agentMessage = (text: string): string =>
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text },
    });
  const toolItem = (data: string): string =>
    JSON.stringify({
      type: "item.updated",
      item: { id: "i0", type: "other", data },
    });
  const rerouteItem = (from: string, to: string, reason: string): string =>
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "error", message: `model rerouted: ${from} -> ${to} (${reason})` },
    });
  const WARNING_TEXT = "ignored config key 'model_reasoning_effort' (not supported by this provider)";
  const warningItem = (): string =>
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_2", type: "error", message: WARNING_TEXT },
    });
  const turnFailed = (message: string): string =>
    JSON.stringify({ type: "turn.failed", error: { message } });
  const turnCompleted = (usage: Record<string, number>): string =>
    JSON.stringify({ type: "turn.completed", usage });
  const USAGE_FULL = {
    input_tokens: 10,
    cached_input_tokens: 4,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_output_tokens: 0,
  };
  const FULL_BLOCK = {
    input_tokens: 6,
    output_tokens: 6,
    cached_input_tokens: 4,
    total_tokens: 16,
    cost_usd: null,
  };
  const completeStream = (text: string): string =>
    [THREAD, turnStarted(), agentMessage(text), turnCompleted(USAGE_FULL)].join("\n") + "\n";

  /** Feeds `stream` through the fold in chunks of `size` UTF-16 code units
   * — the slice bounds are code units, not bytes (round al17; a multibyte
   * character makes a chunk more bytes than units, and any grouping is
   * legal) — the way the runner's decoded chunks arrive, awkward
   * boundaries included. */
  const foldStream = (stream: string, size = 7): CodexPlainFold => {
    const fold = new CodexPlainFold();
    for (let i = 0; i < stream.length; i += size) fold.push(stream.slice(i, i + size));
    return fold;
  };

  test("the fold keeps the reply and the usage snapshot while the tool events are dropped as they arrive (ul3)", () => {
    // The finding's shape: a plain run's `--json` stream carries every
    // tool's output, so capturing it whole dies at exit 125. The fold
    // keeps only the final-message candidate, the last usage snapshot,
    // and the served model.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    const blob = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) fold.push(toolItem(blob) + "\n");
    fold.push(agentMessage("the reply") + "\n");
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBeLessThan(1024); // 20 MiB streamed, ~0 kept
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out.servedModel).toBeNull();
  });

  test("the reply is human mode's byte for byte: interior newlines kept, exactly one trailing newline added, always (al11)", () => {
    expect(foldStream(completeStream("line one\nline two")).verdict(finished("")).stdout)
      .toBe("line one\nline two\n");
    // The pinned processor prints the message with println! (rust-v0.160.1
    // event_processor_with_human_output.rs), which appends its own
    // newline whatever the message ends with: a message already
    // terminated gains a second (al11 — al10's spelling kept it at one),
    // and a whitespace-only message keeps its bytes too (below).
    expect(foldStream(completeStream("already terminated\n")).verdict(finished("")).stdout)
      .toBe("already terminated\n\n");
    // A whitespace-only agent_message prints its bytes and the newline,
    // never the emptied string al10 printed.
    expect(foldStream(completeStream("  \n")).verdict(finished("")).stdout)
      .toBe("  \n\n");
  });

  test("a rerouted model is the served model, and the note says who served the run", () => {
    const stream = [
      THREAD,
      turnStarted(),
      rerouteItem("gpt-5.1", "gpt-5.2", "model unavailable"),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.servedModel).toBe("gpt-5.2");
    expect(out.stderr).toContain("served by gpt-5.2");
  });

  test("a completed error item that is not a reroute is a warning on stderr; the success is untouched (al22)", () => {
    // The correctness minor: codex reports configuration and runtime
    // warnings as completed error items the turn survives, and human mode
    // printed each message on stderr. The reduction read reroute notices
    // alone, so a warning followed by a completed reply exited 0 with
    // empty stderr — a fact codemux had seen went unreported where human
    // mode reported it. Every non-reroute message now rides stderr beside
    // the reply, one note per warning, and the verdict keeps its shape.
    const stream = [
      THREAD,
      turnStarted(),
      warningItem(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out.stderr).toContain(`codemux: codex warning: ${WARNING_TEXT}`);
    // The streamed fold and the whole-capture replay share one reduction,
    // so both report the warning identically.
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));

    // A reroute beside the warning stays what it was — the served-model
    // note — never a second warning.
    const both = [
      THREAD,
      turnStarted(),
      warningItem(),
      rerouteItem("gpt-5.1", "gpt-5.2", "model unavailable"),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const bothOut = foldStream(both).verdict(finished(""));
    expect(bothOut.success).toBe(true);
    expect(bothOut.servedModel).toBe("gpt-5.2");
    expect(bothOut.stderr).toContain(`codemux: codex warning: ${WARNING_TEXT}`);
    expect(bothOut.stderr).toContain("served by gpt-5.2");

    // The kept bytes measure the warning's residue (ul7's rule): what is
    // kept is measured, and the warning is kept. The text is all-ASCII, so
    // its length is its UTF-8 byte count.
    const before = new CodexPlainFold();
    before.push(completeStream("the reply"));
    const after = new CodexPlainFold();
    after.push(stream);
    expect(after.keptBytes() - before.keptBytes()).toBeGreaterThanOrEqual(WARNING_TEXT.length);
  });

  test("every retained warning costs its rendered note: a flood of empty warnings trips the capture bound (al23, al29)", () => {
    // The edges major: takeWarning booked only the message bytes, so an
    // empty warning cost nothing while staying retained — 10,000 of them
    // left keptBytes() at 0 and the capture bound could never trip, though
    // the verdict prints one prefixed stderr line per warning and the
    // residue grows without bound. The value accounting's unit is the
    // note the verdict prints — prefix, message, newline — so an empty
    // message still costs its prefix (round al29; the al28 rule it
    // replaces booked the whole wire line, envelope included, which also
    // covered an empty message but never gave superseded bytes back).
    const emptyWarningItem = (): string =>
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_3", type: "error", message: "" },
      });
    // The per-warning cost is its rendered note — the value accounting's
    // unit (round al29).
    const perWarning = codexWarningNoteBytes("");

    // One empty warning in a completed stream: the note prints (empty
    // message, prefix and all), and the kept bytes grow by the line.
    const stream = [
      THREAD,
      turnStarted(),
      emptyWarningItem(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stderr).toContain("codemux: codex warning: ");
    const before = new CodexPlainFold();
    before.push(completeStream("the reply"));
    const after = new CodexPlainFold();
    after.push(stream);
    expect(after.keptBytes() - before.keptBytes()).toBe(perWarning);

    // The flood: enough empty warnings that their lines alone pass the
    // capture bound — the runner's check (keptBytes() > the bound) fails
    // the run at the limit instead of retaining an unmeasured list.
    const count = Math.ceil((MAX_CAPTURE_BYTES + 1) / perWarning);
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    const batch = (emptyWarningItem() + "\n").repeat(1_000);
    for (let i = 0; i < count; i += 1_000) fold.push(batch);
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
  });

  test("a retained failure message costs its bytes: a MiB-scale warning and error trip the capture bound together (al25)", () => {
    // The correctness minor: every failure arm of the verdict renders the
    // retained failure message on stderr, but keptBytes() counted only
    // warnings — the review's stream of a 9 MiB warning plus a 9 MiB
    // error event reported ~9.4 MB retained while the verdict emitted
    // ~18.9 MB of stderr. The failure message books its bytes exactly
    // like a warning's note now, so the finding's own shape crosses the
    // capture bound here. Each line is under the per-line bound, so the
    // oversized-drop paths never fire.
    const big = "w".repeat(9 * 1024 * 1024);
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(
      JSON.stringify({ type: "item.completed", item: { id: "w0", type: "error", message: big } }) +
        "\n"
    );
    // Before the error event the warning alone is under the bound; the
    // error's retained message is what must push the residue over it.
    expect(fold.keptBytes()).toBeLessThan(MAX_CAPTURE_BYTES);
    fold.push(JSON.stringify({ type: "error", message: big }) + "\n");
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
    // The verdict reports both retained messages on stderr — the warning
    // note beside the failure's own diagnostic.
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("codemux: codex warning: ");
    expect(out.stderr.length).toBeGreaterThan(2 * 9 * 1024 * 1024);
  });

  test("a superseded message gives its bytes back: three 6 MiB replies stay under the bound (al29)", () => {
    // The correctness major's shape: the al28 rule added every retained
    // line's whole bytes and never subtracted the value a later line
    // replaced, so three distinct 6 MiB agent messages — only the last
    // retained — booked ~18 MiB and tripped the 16 MiB bound the process
    // runner kills on, losing a stream whose actual residue was one 6 MiB
    // reply. The value delta subtracts the superseded message's bytes
    // when the replacement sets its own, so retainedBytes reads what the
    // reduction holds NOW.
    const big = (tag: string): string => agentMessage(tag.repeat(6 * 1024 * 1024));
    const stream =
      [THREAD, turnStarted(), big("a"), big("b"), big("c"), turnCompleted(USAGE_FULL)].join("\n") +
      "\n";
    for (const [label, size] of [
      ["whole", stream.length],
      ["64 KiB", 64 * 1024],
    ] as const) {
      const fold = new CodexPlainFold();
      let over = false;
      for (let at = 0; at < stream.length; at += size) {
        fold.push(stream.slice(at, at + size));
        if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true; // the runner's poll
      }
      expect(over, label).toBe(false);
      expect(fold.keptBytes(), label).toBeLessThan(MAX_CAPTURE_BYTES);
      const out = fold.verdict(finished(""));
      expect(out.success, label).toBe(true);
      expect(out.stdout, label).toBe("c".repeat(6 * 1024 * 1024) + "\n");
      expect(out.usage, label).toEqual(FULL_BLOCK);
    }
    // The whole-capture replay answers the same success.
    expect(codexPlainStreamResult(finished(stream)).success).toBe(true);
  });

  test("32 progressively larger replies that each fit keep the residue under the bound (al29)", () => {
    // The property the value accounting buys: a stream may replace its
    // retained message any number of times — here one turn whose reply
    // candidate grows message by message, every message superseding the
    // last — and the residue tracks the values held NOW, never the sum
    // of every line that ever set one. 32 messages, each 320 KiB larger
    // than the last (the largest 10 MiB, every line under the per-line
    // bound), total ~165 MiB on the wire: the al28 line accounting had
    // booked all of it and died at exit 125, while the largest single
    // value stays under the bound by 6 MiB. The chunking-invariance
    // property (al28's test above) holds with it: the verdict is a
    // function of the completed lines alone.
    const lines: string[] = [THREAD, turnStarted()];
    for (let i = 1; i <= 32; i++) {
      lines.push(agentMessage("r".repeat(i * 320 * 1024)));
    }
    lines.push(turnCompleted(USAGE_FULL));
    const stream = lines.join("\n") + "\n";
    let over = false;
    const fold = new CodexPlainFold();
    for (let at = 0; at < stream.length; at += 64 * 1024) {
      fold.push(stream.slice(at, at + 64 * 1024));
      if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true; // the runner's poll
    }
    expect(over).toBe(false);
    expect(fold.keptBytes()).toBeLessThan(MAX_CAPTURE_BYTES);
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("r".repeat(32 * 320 * 1024) + "\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    // And the whole-capture replay — one push — answers identically.
    expect(codexPlainStreamResult(finished(stream))).toEqual(out);
  }, 60_000);

  test("a turn.failed releases the reply it discards: a 9 MiB message before an 8 MiB failure stays under the bound (al31)", () => {
    // The correctness major: a failed turn's clearing of its assistant
    // message lived in toStream() alone, so the plain fold's per-event
    // accounting never saw the give-back — a stream whose last turn
    // failed booked the superseded 9 MiB message AND the 8 MiB failure
    // text and the runner killed the run at the capture limit, losing
    // the failure the caller was owed. The release at the event lets the
    // delta see it: the residue is the failure text the verdict actually
    // retains, and the run fails at exit 1 with codex's own text.
    const reply = "a".repeat(9 * 1024 * 1024);
    const failure = "f".repeat(8 * 1024 * 1024);
    const stream =
      [THREAD, turnStarted(), agentMessage(reply), turnFailed(failure)].join("\n") + "\n";
    const fold = new CodexPlainFold();
    let over = false;
    for (let at = 0; at < stream.length; at += 64 * 1024) {
      fold.push(stream.slice(at, at + 64 * 1024));
      if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true; // the runner's poll
    }
    expect(over).toBe(false);
    expect(fold.keptBytes()).toBeLessThan(MAX_CAPTURE_BYTES);
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1); // the failure's verdict, never the limit's 125
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(failure);
    expect(out.usage).toEqual(emptyUsage());
    // The whole-capture replay shares the reduction and the verdict.
    expect(codexPlainStreamResult(finished(stream)).exitCode).toBe(1);
  }, 60_000);

  test("an oversized human-mode line is accounted before it is discarded: the latch and the partial output both stand (al31, al37)", () => {
    // The correctness major's other half: an oversized line in human
    // mode tripped the latch but never joined raw, so the capture-limit
    // result carried only what preceded the line — while the
    // whole-stream capture the fold stands in for returns the first
    // bytes it could hold as its partial output. The bounded prefix of
    // the line joins raw before the discard now: keptBytes reports the
    // latch (MAX_CAPTURE_BYTES + 1, what the runner kills on) and
    // finish() returns the same partial output the whole-capture path
    // would have. al37 scopes the arm to a stream human mode has
    // already DECIDED — the regime is committed only by a line read
    // whole, so an oversized FIRST line commits nothing and retains
    // nothing.
    const line = "y".repeat(MAX_CAPTURE_BYTES + 1); // ASCII: bytes are chars
    const undecided = new CodexPlainFold();
    undecided.push(line + "\n");
    expect(undecided.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1); // the latch
    expect((undecided as unknown as { state: { mode: string | null } }).state.mode).toBeNull();
    expect(undecided.finish()).toBe(""); // no prefix on an undecided regime

    const fold = new CodexPlainFold();
    fold.push("plain\n"); // a small line read whole decides human mode
    fold.push(line + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1); // the latch
    const partial = fold.finish();
    // All-ASCII, so the string length is the byte count: the whole line,
    // then the prefix the room beside the drop note held — near the
    // bound, never over it, and no newline from the discarded tail.
    expect(partial.startsWith("plain\n")).toBe(true);
    expect(partial.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(partial.length).toBeGreaterThan(MAX_CAPTURE_BYTES - 512);
    expect(partial.slice("plain\n".length).startsWith("y")).toBe(true);
    expect(partial.includes("\n", "plain\n".length)).toBe(false);
  }, 30_000);

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

  test("human-mode JSON lines — a bare number, string, array, or object without the event shape — are reply text, not wire evidence (al2)", () => {
    // Only the wire's own proof closes the hatch (al6): the thread.started
    // announcement. A reply like
    // "The answer is\n42\n" is human-mode stdout from a binary that
    // ignored `--json`: it passes through verbatim, exactly as the hatch
    // passes non-JSON text.
    const scalar = "The answer is\n42\n";
    const out = foldStream(scalar).verdict(finished(scalar));
    expect(out).toEqual(codexPlainResult(finished(scalar)));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("The answer is\n42\n");

    const withJson = "Here is the JSON:\n" + JSON.stringify({ answer: 42 }) + "\nDone.\n";
    const jsonOut = foldStream(withJson).verdict(finished(withJson));
    expect(jsonOut.success).toBe(true);
    expect(jsonOut.stdout).toBe(withJson);
    // An array and a bare string line are reply text the same way.
    for (const stream of ["[1,2,3]\n", '"quoted"\n']) {
      expect(foldStream(stream).verdict(finished(stream)).stdout, stream).toBe(stream);
    }
  });

  test("a JSON-only reply — one typeless object line and nothing else — passes through with exit 0 (al11)", () => {
    // The al2 rule made a typeless object line reply text only when some
    // other line already was; a stdout of exactly `{"answer":42}` — a
    // wrapper or fake that answers JSON and nothing else — reached the
    // objects-only arm and failed as the wire's shape without its
    // announcement. Those bytes are not the wire's shape: every codex
    // event carries a string `type`, and round al30 (rule 3) made the
    // FIRST non-empty line the one test — a typeless object first line is
    // human mode, verbatim stdout, exit 0 — and the replay agrees.
    const stream = '{"answer":42}\n';
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));

    // The same object line ahead of a real stream is human mode's opening
    // now too (round al30, rule 3): the first line decided the regime, so
    // the stream that follows is reply text — the whole stdout verbatim,
    // exit 0. The envelope path still fails these bytes
    // (parseCodexEventStream answers null), and that divergence is the
    // design: a plain run's first line said human.
    const banner = '{"answer":42}\n' + completeStream("the reply");
    const bannerOut = foldStream(banner).verdict(finished(banner));
    expect(bannerOut.success).toBe(true);
    expect(bannerOut.exitCode).toBe(0);
    expect(bannerOut.stdout).toBe(banner);
    expect(bannerOut).toEqual(codexPlainStreamResult(finished(banner)));
  });

  test("a JSON-only reply typed with a name the wire never sends passes through with exit 0 (al11 re-review)", () => {
    // The al11 fix passed typeless objects through but left every STRING
    // type marking the wire's shape — so a wrapper that ignored `--json`
    // and answered `{"type":"invoice","amount":1}` (exit 0) failed as the
    // wire's shape without its announcement, an empty result for a
    // legitimate reply (round al11's re-review, edges 4). Round al30
    // (rule 3) settled the whole vocabulary question the one way the
    // first line can: any first non-empty line but the thread.started
    // announcement is human mode — unknown-named and event-named alike
    // (below), the run's whole stdout verbatim with exit 0.
    const stream = '{"type":"invoice","amount":1}\n';
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));

    // A known event name is the same rule under al30: `{"type":"error",…}`
    // as the FIRST line did not announce a thread, so the stream is human
    // mode's — passthrough, exit 0 — not the al7 error-only failure the
    // per-line hatch answered (the announcement-decided stream still
    // fails its errors; the al6 pin below).
    const known = foldStream('{"type":"error","message":"x"}\n').verdict(
      finished('{"type":"error","message":"x"}\n')
    );
    expect(known.success).toBe(true);
    expect(known.exitCode).toBe(0);
    expect(known.stdout).toBe('{"type":"error","message":"x"}\n');

    // Ahead of a real stream the unknown-typed line is the same human
    // opening (round al30, rule 3): the whole stdout verbatim, exit 0.
    const banner = stream + completeStream("the reply");
    const bannerOut = foldStream(banner).verdict(finished(banner));
    expect(bannerOut.success).toBe(true);
    expect(bannerOut.exitCode).toBe(0);
    expect(bannerOut.stdout).toBe(banner);
    expect(bannerOut).toEqual(codexPlainStreamResult(finished(banner)));
  });

  test("a plain reply carrying an object line with a string type the fold does not read keeps the hatch open (al3)", () => {
    // A hatch run's stdout is plain text, and plain text can contain a
    // line that parses as an object with a string `type`. That alone is
    // not wire evidence: the hatch closes only on the thread.started
    // announcement (al6), so the reply is
    // never lost to a line inside it — before al3 the line was taken for
    // the wire, the hatch closed, and every later line became drift that
    // failed the run.
    const stream = 'Here is code:\n{"type":"object"}\nmore\n';
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(stream);

    // The whole-capture replay answers the same bytes the same way, and
    // the announcement still closes the hatch: the rule is the wire's
    // proof, not the shape.
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    expect(foldStream(completeStream("the reply")).verdict(finished("")).stdout)
      .toBe("the reply\n");
  });

  test("a reply line shaped like a codex event — a name the reduction reads — never closes the hatch either (al5)", () => {
    // Finding 3: the al3 rule keyed on the event-name vocabulary, so a
    // hatch reply carrying {"type":"turn.started"} or {"type":"error",…}
    // — both names the reduction reads — closed the hatch, and the next
    // plain line became drift that failed the run with no stdout. The
    // hatch now closes only on the wire's own proof: the announcement
    // (a thread.started line; al6). Prose, a
    // bare number, and event-shaped object lines alike stay reply text.
    const stream =
      "notes:\n" +
      '{"type":"turn.started"}\n' +
      "and a count:\n" +
      "42\n" +
      '{"type":"error","message":"x"}\n' +
      "more\n";
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(stream);
    // The streaming fold and the whole-capture replay share the one rule.
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a reply line shaped like turn.completed or turn.failed never loses the hatch run (al6)", () => {
    // Review al6, finding 1: the al5 comment claimed any event-shaped
    // line was safe reply text, but a line whose feeding drifts the
    // reduction — turn.completed and turn.failed close a turn none
    // opened — closed the hatch as "a drift the fed events raised" and
    // failed the run, so a valid human-mode reply quoting those events
    // was lost. Drift is not wire proof: only the announcement closes
    // the hatch, in either ordering — prose around the object lines, or
    // the drifting object line first with the prose after it.
    const proseAround = [
      "the turn events were:",
      JSON.stringify({ type: "turn.completed", usage: {} }),
      "and the failure:",
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
      "end of log",
    ].join("\n") + "\n";
    const objectFirst = JSON.stringify({ type: "turn.completed" }) + "\nthen the prose answer\n";
    for (const stream of [proseAround, objectFirst]) {
      const out = foldStream(stream).verdict(finished(stream));
      expect(out, JSON.stringify(stream)).toEqual(codexPlainResult(finished(stream)));
      expect(out.success).toBe(true);
      expect(out.stdout).toBe(stream);
      // The streaming fold and the whole-capture replay share the one rule.
      expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    }
  });

  test("human-mode stdout keeps 0.11.0's plain verdict: stdout verbatim, success exactly when the exit was 0 (al6)", () => {
    // Review al6, finding 2: before this branch a plain codex run was
    // human mode, and its verdict was the child's own — stdout verbatim,
    // the exit code untouched, success exactly when the exit was 0
    // (codexPlainResult, the hatch's verdict). Every stdout that is not
    // the wire owes it the same answer, whatever lines it carries:
    // prose, blanks, JSON of every shape but object lines, object lines
    // with unrecognized or event-shaped types (al2, al3, al5, al6) — at
    // either exit code. The shapes that differ are the wire's own, each
    // pinned by its own test and listed with its reason in
    // docs/align-0.12-report.md (round al6).
    const shapes = [
      "the reply\n",
      "line one\nline two\n",
      "\n\n",
      "",
      "The answer is\n42\n",
      "[1,2,3]\n",
      '"quoted"\n',
      'Here is code:\n{"type":"object"}\nmore\n',
      'notes:\n{"type":"turn.started"}\nand a count:\n42\n{"type":"error","message":"x"}\nmore\n',
      'log:\n{"type":"turn.completed","usage":{}}\nend\n',
      '{"type":"turn.completed"}\nthen the prose answer\n',
    ];
    for (const stream of shapes) {
      for (const exitCode of [0, 3]) {
        const label = `exit ${exitCode}: ${JSON.stringify(stream)}`;
        const result: RunResult = {
          stdout: stream,
          stderr: "",
          exitCode,
          success: exitCode === 0,
        };
        const out = foldStream(stream).verdict(result);
        expect(out.success, label).toBe(exitCode === 0);
        expect(out.exitCode, label).toBe(exitCode);
        expect(out.stdout, label).toBe(stream);
        expect(out, label).toEqual(codexPlainStreamResult({ ...result }));
      }
    }
  });

  test("a leading object whose type is not a known event decides human mode: passthrough, envelope path unchanged (al5, al30)", () => {
    // Finding 2's parity ended with the per-line hatch (round al30, rule
    // 3): parseCodexEventStream still feeds every object line to the
    // reduction, so the --result-json run fails these bytes as
    // unparseable — the later thread.started lands past the first event,
    // drift. The plain run's regime is its FIRST non-empty line's, and
    // an unknown-typed object is not the announcement, so the same bytes
    // are human mode there: verbatim stdout, exit 0. The two paths
    // answer differently by design now — a wrapper that prefixes a
    // JSON object to a real stream got its bytes past a plain run, and
    // the alternative was the quoted-reply loss the round's correctness
    // major pinned.
    const stream = [
      JSON.stringify({ type: "some.new.event" }),
      THREAD,
      turnStarted(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("plain text before the announcement decides human mode: verbatim passthrough, envelope path unchanged (al5, al30)", () => {
    // The banner shape, same rule: the parse fails these bytes at the
    // text line before it ever reaches the announcement (pinned beside),
    // while the plain run's first line said human — the whole stdout
    // passes through with exit 0 (round al30, rule 3).
    const stream = [
      "a banner line",
      THREAD,
      turnStarted(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a reply quoting the thread.started announcement passes through with exit 0 (al24)", () => {
    // The edges major: the hatch closed on ANY line that parsed as the
    // announcement, and the grammar puts thread.started first, so a
    // human-mode reply quoting the event — a code block showing it, prose
    // around it — lost its whole stdout to the banner drift and the run
    // exited 1. The announcement now closes the hatch only when no reply
    // text preceded it; a quote leaves the hatch open, and prose AFTER it
    // settles the run as the hatch's — the opencode fold's answer, where
    // lines that are not the wire beside event lines never lose the run.
    const quote = [
      "The stream opens with this event:",
      "",
      "```",
      THREAD,
      "```",
      "",
      "That is all you need.",
    ].join("\n") + "\n";
    const out = foldStream(quote).verdict(finished(quote));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(quote);
    expect(out).toEqual(codexPlainResult(finished(quote)));
    // The streaming fold and the whole-capture replay share the one rule.
    expect(out).toEqual(codexPlainStreamResult(finished(quote)));

    // The single-line quote shapes: the JSON inside a quoted string, and a
    // line with leading text. Neither parses as an event object, so both
    // were already the hatch's; pinned here beside the shape that was not.
    for (const stream of [
      '"{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"x\\"}"\n',
      `Here it is: ${THREAD} on one line.\n`,
    ]) {
      const single = foldStream(stream).verdict(finished(stream));
      expect(single.success, stream).toBe(true);
      expect(single.exitCode, stream).toBe(0);
      expect(single.stdout, stream).toBe(stream);
      expect(single, stream).toEqual(codexPlainStreamResult(finished(stream)));
    }

    // A quote can carry event lines too — the reply quotes the stream's
    // opening — and prose after it still settles the run as the hatch's.
    const quotedEvents = [
      "The first lines are:",
      THREAD,
      turnStarted(),
      "and then items follow.",
    ].join("\n") + "\n";
    const eventsOut = foldStream(quotedEvents).verdict(finished(quotedEvents));
    expect(eventsOut.success).toBe(true);
    expect(eventsOut.exitCode).toBe(0);
    expect(eventsOut.stdout).toBe(quotedEvents);
    expect(eventsOut).toEqual(codexPlainStreamResult(finished(quotedEvents)));

    // A quote can trail into event lines with NO prose after it — the
    // wire's shape with text before its opening — and the answer is the
    // same now (round al30, rule 3): the first line decided human mode,
    // and nothing later flips it, so the truncated-looking tail is reply
    // text like the rest.
    const truncated = ["a banner line", THREAD, turnStarted()].join("\n") + "\n";
    const truncatedOut = foldStream(truncated).verdict(finished(truncated));
    expect(truncatedOut.success).toBe(true);
    expect(truncatedOut.exitCode).toBe(0);
    expect(truncatedOut.stdout).toBe(truncated);
    expect(truncatedOut).toEqual(codexPlainStreamResult(finished(truncated)));
  });

  test("a reply ending in a JSON object after a quoted announcement is the hatch's, exit 0 (al28)", () => {
    // The al28 review's acceptance case, held by the redesign: prose, a
    // quoted thread.started (the hatch stays open under it, al24), and a
    // tail of `{"answer":42}` — a typeless object, reply text in al11's
    // vocabulary — is a JSON-only reply around a quote, the hatch's
    // verbatim stdout. Before al28 the tail reached the verdict only as
    // the wire regime's shape test (an object line among objects), which
    // answered the banner drift instead; the plain run's fallback file
    // could then overwrite even that. The tail rule reads the object
    // through the same vocabulary the objects-only arm does: typeless is
    // reply text, so prose FOLLOWS the quote, and the run is the hatch's.
    const stream = ["here is the stream:", THREAD, '{"answer":42}'].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out.usage).toBeUndefined();
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a truncated event line under a quoted announcement is reply text like the rest — the first line decided (al25, al30)", () => {
    // Al25's correctness major — a stream cut mid-write (banner,
    // announcement, turn.started, truncated `{"type":"turn.failed"`)
    // passing through the hatch with exit 0 — was answered by teaching
    // the per-line hatch to read the cut as the wire breaking under a
    // quote. Round al30 (rule 3) deletes that machinery: the regime is
    // the first non-empty line's, full stop, so the corrupted stream
    // under a banner IS human mode's bytes and passes through verbatim
    // with exit 0 — the quoted-cut shape is indistinguishable from a
    // reply quoting one, and the fold no longer tries. The wire regime
    // keeps al25's diagnostic for the shape that commits to it: a cut
    // AFTER the announcement (the drift test below).
    const cut = '{"type":"turn.failed"';
    for (const [label, stream] of [
      ["no footer", ["a wrapper banner", THREAD, turnStarted(), cut].join("\n") + "\n"],
      [
        "footer prose",
        ["a wrapper banner", THREAD, turnStarted(), cut, "wrapper footer"].join("\n") + "\n",
      ],
    ] as Array<readonly [string, string]>) {
      const out = foldStream(stream).verdict(finished(stream));
      expect(out.success, label).toBe(true);
      expect(out.exitCode, label).toBe(0);
      expect(out.stdout, label).toBe(stream);
      expect(out.usage, label).toBeUndefined();
      // The streamed fold and the whole-capture replay share the one rule.
      expect(out, label).toEqual(codexPlainStreamResult(finished(stream)));
    }

    // The same quote with a COMPLETE tail is the same verdict, and the
    // truncated line as the FIRST line is too — human mode either way.
    const quoted = ["a banner", THREAD, turnStarted(), "and the reply follows."].join("\n") + "\n";
    const quotedOut = foldStream(quoted).verdict(finished(quoted));
    expect(quotedOut.success).toBe(true);
    expect(quotedOut.stdout).toBe(quoted);
    const prose = '{"type":"turn.failed"\nlooks like a broken quote in reply text\n';
    const proseOut = foldStream(prose).verdict(finished(prose));
    expect(proseOut.success).toBe(true);
    expect(proseOut.stdout).toBe(prose);
  });

  test("a reply quoting a FAILED stream passes through with exit 0 — the regime was decided by the first line (al25, al30)", () => {
    // Round al30's correctness major, held: al25 taught the per-line
    // hatch to fail a quote that carried turn.failed ("the quoted event
    // stream carried a failure"), and that machinery is what turned THIS
    // run — a human reply whose fenced example quotes a failed stream's
    // events — into a failure: exit 0 became 1 with the reply lost. Rule
    // 3 deletes it: the first non-empty line ("a wrapper banner" here,
    // prose in the round's repro) decided human mode, and NOTHING later
    // flips it, however event-like or failure-like the quoted lines look.
    const failed = [
      "a wrapper banner",
      THREAD,
      turnStarted(),
      turnFailed("Usage limit reached"),
      "wrapper footer",
    ].join("\n") + "\n";
    const out = foldStream(failed).verdict(finished(failed));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(failed);
    expect(out.usage).toBeUndefined();
    expect(out).toEqual(codexPlainStreamResult(finished(failed)));

    const errored = [
      "a wrapper banner",
      THREAD,
      JSON.stringify({ type: "error", message: "provider down" }),
      "wrapper footer",
    ].join("\n") + "\n";
    const erroredOut = foldStream(errored).verdict(finished(errored));
    expect(erroredOut.success).toBe(true);
    expect(erroredOut.exitCode).toBe(0);
    expect(erroredOut.stdout).toBe(errored);
  });

  test("a stream with wire lines but no thread.started is human mode: passthrough, envelope path unchanged (al30)", () => {
    const stream = [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    // The whole-capture parse still answers null for exactly these bytes
    // (the envelope path's rule is untouched); the fold's regime is the
    // FIRST non-empty line's, and turn.started is not the announcement,
    // so the plain run passes the bytes through verbatim (round al30,
    // rule 3 — the al5 objects-only drift arm is gone with the per-line
    // hatch).
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a recovered top-level error remains a stderr note (al41)", () => {
    const stream = [
      THREAD, turnStarted(),
      JSON.stringify({ type: "error", message: "stream disconnected; retrying" }),
      agentMessage("the reply"), turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("the reply");
    expect(out.stderr).toContain("codemux: codex warning:");
    expect(out.stderr).toContain("stream disconnected; retrying");
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("an unsuperseded error event fails the run even at exit 0 (al6)", () => {
    // 0.11.0's plain verdict trusted the exit code alone; the stream's
    // own failure channels — turn.failed, or a top-level error no later
    // turn.completed superseded — fail the run at child exit 0 too, the
    // envelope path's long-standing rule (round al6's listing).
    const stream = [THREAD, JSON.stringify({ type: "error", message: "provider down" })].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("provider down");
    expect(out.usage).toEqual(emptyUsage());
  });

  test("error events with no thread announcement are human mode's bytes: passthrough at the child's own exit (al7, al30)", () => {
    // Al7's arm — a plain run whose stdout is only {"type":"error",...}
    // lines failing with codex's own error text — ended with the
    // per-line hatch (round al30, rule 3): the first non-empty line is
    // an error event, not the announcement, so the stream is human
    // mode's — verbatim stdout, the child's exit code its own verdict,
    // success exactly when the exit was 0. A binary that honored `--json`
    // and errored before starting a thread is indistinguishable from one
    // that never honored it and printed JSON, and the round settled the
    // ambiguity for the hatch: the announcement, or passthrough. The
    // envelope path still fails these bytes
    // (parseCodexEventStream answers null, pinned beside), and a stream
    // that DID announce keeps failing its errors (al6 below).
    const stream = [
      JSON.stringify({ type: "error", message: "stream error: upstream refused" }),
      JSON.stringify({ type: "error", message: "retry failed: quota exhausted" }),
    ].join("\n") + "\n";
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    // The child's own nonzero exit stays its verdict.
    const crashed = foldStream(stream).verdict({ stdout: stream, stderr: "", exitCode: 2, success: false });
    expect(crashed.success).toBe(false);
    expect(crashed.exitCode).toBe(2);
    expect(crashed.stdout).toBe(stream);
  });

  test("a failed turn prints nothing, exactly what human mode printed, and reports no usage", () => {
    // Upstream discards a failed turn's final message, so neither the
    // fold nor human mode prints one.
    const stream = [
      THREAD,
      turnStarted(),
      agentMessage("partial"),
      turnFailed("Usage limit reached"),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Usage limit reached");
    expect(out.usage).toEqual(emptyUsage());
  });

  test("codex's own non-zero exit fails the run while the message it printed stays on stdout", () => {
    // The decided contract (round al5): the stream completed the turn —
    // a turn.completed closed it and a final message exists — so the
    // reply stays on stdout even though codex then exited nonzero; human
    // mode printed that message before exiting.
    const result: RunResult = { stdout: "", stderr: "boom", exitCode: 3, success: false };
    const out = foldStream(completeStream("the reply")).verdict(result);
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toBe("the reply\n");
    expect(out.stderr).toBe("boom");
    // A figure from a run whose end the harness itself called failed is
    // at best incomplete: the receipt records none.
    expect(out.usage).toEqual(emptyUsage());
  });

  test("a truncated stream — a complete message whose turn never completed — fails the run and prints nothing (al5)", () => {
    // The decided contract: no turn.completed, no reply on stdout — the
    // message the reducer holds is an intermediate one.
    const stream = [THREAD, turnStarted(), agentMessage("partial")].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("turn.completed");
  });
  test("a completed turn with no message anywhere succeeds with empty stdout, human mode's verdict (al10)", () => {
    // The ninth review's finding, settled against 0.160.1's own human
    // output processor (event_processor_with_human_output.rs): a
    // TurnStatus::Completed turn shuts codex down normally — exit 0 —
    // whatever it holds, and print_final_output prints a final message
    // only when one exists, so a messageless completed turn printed
    // nothing and exited 0. The Plan-only turn under an untrusted sandbox
    // is this exact wire shape: the JSONL stream has no Plan variant, so
    // without the --output-last-message file that launch cannot have, the
    // text human mode printed never reaches codemux — empty stdout is the
    // faithful spelling, the usage stays, and the run succeeds. The
    // envelope path keeps failing the same stream (its promise is a
    // result envelope, and an empty result is a failed run;
    // result-envelope.test.ts).
    const reasoningItem = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "reasoning", text: "thinking" },
    });
    const stream = [THREAD, turnStarted(), reasoningItem, turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain("no result to report");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    // The same turn under a nonzero codex exit still fails, with nothing
    // to print: human mode printed nothing and exited nonzero.
    const crashed = foldStream(stream).verdict(
      { stdout: "", stderr: "boom", exitCode: 3, success: false }
    );
    expect(crashed.success).toBe(false);
    expect(crashed.exitCode).toBe(3);
    expect(crashed.stdout).toBe("");
    expect(crashed.usage).toEqual(emptyUsage());
    // An empty agent_message is the same rule one step further: human
    // mode's final_message_from_turn_items returned the empty text, so
    // println! printed a lone newline and exited 0; the plain path spells
    // exactly that since al11 (al10 had emptied it — the review's parity
    // finding) and succeeds the same.
    const empty = [THREAD, turnStarted(), agentMessage(""), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const emptyOut = foldStream(empty).verdict(finished(""));
    expect(emptyOut.success).toBe(true);
    expect(emptyOut.exitCode).toBe(0);
    expect(emptyOut.stdout).toBe("\n");
    expect(emptyOut.usage).toEqual(FULL_BLOCK);
    expect(emptyOut).toEqual(codexPlainStreamResult(finished(empty)));
  });

  test("a messageless turn with no fallback thunk succeeds empty — the default every replay keeps (al10, al29)", () => {
    // Round al29 restores the plain run's --output-last-message file, but
    // scoped: the verdict consults it only through a thunk the launch
    // passes after its own read, and only for a completed messageless
    // turn (the tests below). No thunk — the whole-capture replay, any
    // caller without a context, and the launch that named no file (the
    // untrusted sandbox) — keeps exactly the answer al10 settled and
    // al28 made universal: the messageless completed turn succeeds empty,
    // with the usage, and nothing on stderr names a fallback.
    const stream = [THREAD, turnStarted(), toolItem("thinking"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain("no result to report");
    expect(out.stderr).not.toContain("--output-last-message");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("the bounded fallback: a messageless completed turn answers from the file the launch named (al29)", () => {
    // The round al29 major's one case, spelled per outcome. A plain run
    // names a --output-last-message file again — a Plan-only turn's
    // recorded final message is the reply's only carrier, the one item
    // the JSONL wire does not carry — and the launch reads (and removes)
    // it before the verdict runs, handing the outcome over as the thunk
    // these tests stand in for. Text answers with the recorded message
    // and the fallback note; an empty file (upstream's own
    // messageless-turn record) confirms the empty reply with no note; a
    // missing file fails the run naming the unwritten file (round al34,
    // edges major 2 — the file was the reply's only carrier, so its
    // absence is an upstream write failure, never the no-fallback
    // shape); and a read that refused fails the run with its error.
    const planOnly =
      [THREAD, turnStarted(), toolItem("thinking"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const recorded = "the plan\nsteps one and two";

    const text = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "text",
      text: recorded,
    }));
    expect(text.success).toBe(true);
    expect(text.exitCode).toBe(0);
    // The recorded message verbatim plus the one trailing newline the
    // pinned printer appends (al11's spelling, the file's bytes included).
    expect(text.stdout).toBe(`${recorded}\n`);
    expect(text.stderr).toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
    expect(text.usage).toEqual(FULL_BLOCK);
    // The streaming fold and the whole-capture replay share the arm.
    expect(text).toEqual(
      codexPlainStreamResult(finished(planOnly), () => ({ outcome: "text", text: recorded }))
    );

    const empty = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "text",
      text: "",
    }));
    expect(empty.success).toBe(true);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe("");
    expect(empty.stderr).not.toContain("codemux:");
    expect(empty.usage).toEqual(FULL_BLOCK);

    const missing = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "missing",
      path: "/run/.codemux-scratch/last-message",
    }));
    // Round al34 (edges major 2): a NAMED file that is not there is a
    // write codex only logged — the completed messageless turn's only
    // carrier never landed, so the run fails naming it, with no usage
    // from a run whose end is a failure. (The no-fallback shape — a
    // launch that named no file — passes no thunk at all and keeps the
    // al10 empty success, the test above.)
    expect(missing.success).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain(
      "codex completed the turn but did not write the " +
        "--output-last-message file the launch named"
    );
    expect(missing.stderr).toContain("/run/.codemux-scratch/last-message");
    expect(missing.usage).toEqual(emptyUsage());

    const unreadable = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "unreadable",
      error: "EACCES: permission denied, open 'last-message'",
    }));
    expect(unreadable.success).toBe(false);
    expect(unreadable.exitCode).toBe(1);
    expect(unreadable.stdout).toBe("");
    expect(unreadable.stderr).toContain(
      "could not read codex's --output-last-message file"
    );
    expect(unreadable.stderr).toContain("permission denied");
    expect(unreadable.usage).toEqual(emptyUsage());
  });

  test("no other path touches the file: every verdict that is not a completed messageless turn ignores the thunk (al29)", () => {
    // The bounded case's other half, and the al28 lesson held: the file
    // may never contradict the stream. A thunk that THROWS if consulted
    // stands in for the read, and every other verdict shape — a stream
    // that carried its reply, failed its own way, never completed the
    // turn, exited nonzero after completing, or never proved itself the
    // wire at all — answers without it.
    const boom = (): CodexPlanFallbackRead => {
      throw new Error("the fallback thunk must not be consulted");
    };
    const normal = foldStream(completeStream("the reply")).verdict(finished(""), boom);
    expect(normal.success).toBe(true);
    expect(normal.stdout).toBe("the reply\n");
    expect(normal.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);

    const failed = foldStream(
      [THREAD, turnStarted(), turnFailed("Usage limit reached")].join("\n") + "\n"
    ).verdict(finished(""), boom);
    expect(failed.success).toBe(false);
    expect(failed.stderr).toContain("Usage limit reached");

    const truncated = foldStream(
      [THREAD, turnStarted(), agentMessage("partial")].join("\n") + "\n"
    ).verdict(finished(""), boom);
    expect(truncated.success).toBe(false);
    expect(truncated.stdout).toBe("");

    // Codex exited nonzero after completing: the message stays on stdout
    // (human mode printed it before exiting) and the file is beside the
    // point — the run already failed.
    const crashed = foldStream(completeStream("the reply")).verdict(
      { stdout: "", stderr: "boom", exitCode: 3, success: false },
      boom
    );
    expect(crashed.success).toBe(false);
    expect(crashed.exitCode).toBe(3);
    expect(crashed.stdout).toBe("the reply\n");

    const hatch = foldStream("a plain reply\n").verdict(finished("a plain reply\n"), boom);
    expect(hatch.success).toBe(true);
    expect(hatch.stdout).toBe("a plain reply\n");
  });
  test("keptBytes books the thread id and served model the reduction retains (al26)", () => {
    // Edges major: both are unbounded strings the verdict hands back,
    // and both sat outside keptBytes — two sub-limit events (a 9 MiB
    // thread_id, a 9 MiB reroute model name) retained twice the capture
    // bound while keptBytes answered 0, so the residue the bound
    // promises to measure was invisible to it.
    const hugeId = "t".repeat(9 * 1024 * 1024);
    const hugeModel = "m".repeat(9 * 1024 * 1024);
    const fold = new CodexPlainFold();
    fold.push(JSON.stringify({ type: "thread.started", thread_id: hugeId }) + "\n");
    fold.push(turnStarted() + "\n");
    fold.push(rerouteItem("from-model", hugeModel, "capacity") + "\n");
    // Both lines were under the bound individually, so neither dropped;
    // the retained pair is over it, and keptBytes says so.
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
  });

  test("retained metadata counts once: a tool line mid-arrival cannot cross a bound the residue stays under (al27)", () => {
    // Correctness major 1: keptBytes' wire branch counted the buffered
    // partial line — a tool event on its way to being parsed and dropped —
    // beside the retained residue, so the SAME stream died at exit 125
    // with empty stdout while the tool line's bytes were still buffered,
    // and succeeded once they arrived with their newline: the verdict rode
    // the pipe's read grouping. The bound now measures what the fold
    // RETAINS; the buffered partial counts only in the hatch branch,
    // where it becomes raw byte-for-byte (OpenCodePlainFold's rule since
    // review ul5). The retained total here sits just under the bound; the
    // 512 KiB tool line's mid-arrival buffer pushed the old combined
    // count over it in the chunked groupings only.
    const THREAD_ID_BYTES = MAX_CAPTURE_BYTES - 400 * 1024;
    const REPLY_BYTES = 90 * 1024;
    const TOOL_LINE_BYTES = 512 * 1024;
    const toolHead = `{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"`;
    const toolTail = `"}}`;
    const toolLine =
      toolHead +
      "x".repeat(TOOL_LINE_BYTES - Buffer.byteLength(toolHead) - Buffer.byteLength(toolTail)) +
      toolTail;
    expect(Buffer.byteLength(toolLine)).toBe(TOOL_LINE_BYTES);
    const stream =
      JSON.stringify({ type: "thread.started", thread_id: "t".repeat(THREAD_ID_BYTES) }) +
      "\n" +
      turnStarted() +
      "\n" +
      toolLine +
      "\n" +
      agentMessage("r".repeat(REPLY_BYTES)) +
      "\n" +
      turnCompleted(USAGE_FULL) +
      "\n";
    // readBounded's discipline (process-runner.ts): after EVERY chunk the
    // residue is checked against the bound, and one crossing fails the run
    // at exit 125. `over` records what the runner would have done.
    const runGrouping = (first: number, size: number): { over: boolean; out: RunResult } => {
      const fold = new CodexPlainFold();
      let over = false;
      const chunks: string[] = [];
      if (first > 0) chunks.push(stream.slice(0, first));
      for (let at = first; at < stream.length; at += size) {
        chunks.push(stream.slice(at, at + size));
      }
      for (const chunk of chunks) {
        fold.push(chunk);
        if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true;
      }
      return { over, out: fold.verdict(finished("")) };
    };
    const outs: RunResult[] = [];
    for (const [label, grouping] of [
      ["whole", [stream.length, stream.length]],
      ["64 KiB", [0, 64 * 1024]],
      ["256-byte first chunk", [256, 64 * 1024]],
    ] as Array<readonly [string, readonly [number, number]]>) {
      const { over, out } = runGrouping(grouping[0], grouping[1]);
      // The residue never crosses, in any grouping: the buffered tool line
      // is on its way to being dropped, never kept.
      expect(over, label).toBe(false);
      expect(out.success, label).toBe(true);
      expect(out.stdout, label).toBe("r".repeat(REPLY_BYTES) + "\n");
      expect(out.usage, label).toEqual(FULL_BLOCK);
      outs.push(out);
    }
    expect(outs[1]!).toEqual(outs[0]!);
    expect(outs[2]!).toEqual(outs[0]!);
    // The whole-capture replay answers the same success — one verdict for
    // the stream, whatever the pipe's read grouping.
    expect(codexPlainStreamResult(finished(stream))).toEqual(outs[0]!);
  });

  test("retained bytes past the bound answer over in every chunking (al27)", () => {
    // The mirror the rule demands: a stream whose RETAINED total is over
    // the bound fails at the capture limit in every grouping, the whole
    // delivery included — no chunking can dodge the residue the fold
    // keeps (round al26's rule) any more than a chunking may be killed by
    // bytes on their way to being dropped (the test above). A 9 MiB
    // thread id plus an 8 MiB reply, each line under the bound alone.
    const stream =
      JSON.stringify({ type: "thread.started", thread_id: "t".repeat(9 * 1024 * 1024) }) +
      "\n" +
      turnStarted() +
      "\n" +
      agentMessage("r".repeat(8 * 1024 * 1024)) +
      "\n" +
      turnCompleted(USAGE_FULL) +
      "\n";
    const runGrouping = (first: number, size: number): boolean => {
      const fold = new CodexPlainFold();
      let over = false;
      const chunks: string[] = [];
      if (first > 0) chunks.push(stream.slice(0, first));
      for (let at = first; at < stream.length; at += size) {
        chunks.push(stream.slice(at, at + size));
      }
      for (const chunk of chunks) {
        fold.push(chunk);
        if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true;
      }
      return over;
    };
    for (const [label, grouping] of [
      ["whole", [stream.length, stream.length]],
      ["64 KiB", [0, 64 * 1024]],
      ["256-byte first chunk", [256, 64 * 1024]],
    ] as Array<readonly [string, readonly [number, number]]>) {
      expect(runGrouping(grouping[0], grouping[1]), label).toBe(true);
    }
  });

  test("the same bytes answer one verdict in every chunking from 1 byte to 64 KiB (al28)", () => {
    // The round's property test: ONE accounting rule stated on completed
    // lines means the pipe's read grouping decides nothing. The same
    // bytes, delivered whole and in chunkings spanning 1 byte to 64 KiB,
    // give byte-identical stdout, stderr, exit code, and usage, the same
    // final keptBytes, and the same answer to the bound the process
    // runner polls after every chunk (keptBytes() over the capture bound
    // kills the run at exit 125, so `over` is the runner's own decision
    // and must be a function of the bytes alone). The size set spans the
    // range with every power of two plus odd sizes that land chunk
    // boundaries off the wire's newlines — the al16 lesson; the four
    // near-bound streams, each ~16 MiB, take the boundary-shifting
    // subset, for their retained lines complete at millions of offsets
    // already and the sizes that matter there are the small ones.
    // al27's tests pin the bound's two sides at three groupings each;
    // this sweeps every shape the rule touches. Round al36 extends the
    // sweep past the codex fold: the property is stated on any fold the
    // runner polls, so the opencode case below rides the same harness.
    // Round al37 makes `over` decide WHICH answer the runner gives: a
    // poll past the bound fails the run at the capture limit and the
    // fold's verdict never runs on that path, so `out` is the modeled
    // 125 result there (captureLimitResult over the fold's finish())
    // and the verdict everywhere else — and the oversized family below
    // states the round's own property: every stream containing one line
    // past the bound answers that 125 in every chunking, whole, halves,
    // one byte at a time, and seeded random splits alike.
    type Answer = { over: boolean; kept: number; out: RunResult; usage: ReturnType<CodexPlainFold["foldedUsage"]> };
    type ChunkedFold = CodexPlainFold | OpenCodePlainFold;
    const deliverBy = (
      makeFold: () => ChunkedFold,
      stream: string,
      nextSize: (remaining: number, at: number) => number,
      stopAtOverflow = false
    ): Answer => {
      const fold = makeFold();
      let over = false;
      let at = 0;
      while (at < stream.length) {
        const size = Math.min(nextSize(stream.length - at, at), stream.length - at);
        fold.push(stream.slice(at, at + size));
        at += size;
        if (fold.keptBytes() > MAX_CAPTURE_BYTES) {
          over = true;
          if (stopAtOverflow) break;
        }
      }
      // The runner finalizes the tail and checks the bound again at EOF.
      const captured = fold.finish();
      over ||= fold.keptBytes() > MAX_CAPTURE_BYTES;
      return {
        over,
        kept: fold.keptBytes(),
        usage: fold.foldedUsage(),
        out: over
          ? captureLimitResult(captured)
          : fold.verdict(finished(stream)),
      };
    };
    const whole = (stream: string, makeFold: () => ChunkedFold): Answer =>
      deliverBy(makeFold, stream, (remaining) => remaining);
    // A stream whose retained total sits just past the bound by a known
    // margin: two retained lines (the thread id, the reply) each under
    // the bound alone, as al26's finding shaped it.
    const nearBoundStream = (extraBytes: number): string =>
      JSON.stringify({ type: "thread.started", thread_id: "t".repeat(8 * 1024 * 1024) }) +
      "\n" +
      turnStarted() +
      "\n" +
      agentMessage("r".repeat(8 * 1024 * 1024 + extraBytes)) +
      "\n" +
      turnCompleted(USAGE_FULL) +
      "\n";
    const toolHead = `{"type":"item.completed","item":{"type":"command_execution","command":"ls","aggregated_output":"`;
    const toolTail = `"}}`;
    const oversizedToolLine =
      toolHead +
      "x".repeat(MAX_CAPTURE_BYTES + 1 - Buffer.byteLength(toolHead) - Buffer.byteLength(toolTail)) +
      toolTail;
    expect(Buffer.byteLength(oversizedToolLine)).toBe(MAX_CAPTURE_BYTES + 1);
    // Round al36's shape (the review's own repro), flipped by al37's one
    // rule: an opencode run whose FIRST event is a tool part over the
    // bound, followed by the wire events a real stream sends next. The
    // al36 answer let a later wire line reclassify the drop; the al37
    // answer is the one every oversized line gets — the latch at the
    // drop, the run failed at the capture limit, nothing after it read.
    const opencodeToolHead = `{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"output":"`;
    const opencodeToolTail = `"}}`;
    const opencodeOversizedToolEvent =
      opencodeToolHead +
      "x".repeat(
        MAX_CAPTURE_BYTES + 1 -
          Buffer.byteLength(opencodeToolHead) -
          Buffer.byteLength(opencodeToolTail)
      ) +
      opencodeToolTail;
    expect(Buffer.byteLength(opencodeOversizedToolEvent)).toBe(MAX_CAPTURE_BYTES + 1);
    const opencodeOversizedToolStream =
      opencodeOversizedToolEvent + "\n" +
      JSON.stringify({
        type: "text",
        sessionID: "ses_0123456789abcdef",
        part: { text: "the reply" },
      }) + "\n" +
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_0123456789abcdef",
        part: { tokens: { input: 8, output: 3, total: 11 }, cost: null },
      }) + "\n";
    const SMALL_SIZES = [1, 2, 3, 5, 7, 13, 31, 64, 127, 256, 1024, 4096, 16384, 65536];
    const BIG_SIZES = [1, 7, 64, 256, 1024, 65536];
    const codexFold = (): CodexPlainFold => new CodexPlainFold();
    const cases: Array<
      readonly [string, string, readonly number[], () => ChunkedFold, (w: Answer) => void]
    > = [
      [
        "whitespace crosses the bound before a valid codex stream (al40)",
        " \n".repeat(MAX_CAPTURE_BYTES / 2) + "\n" + completeStream("must not fold"),
        BIG_SIZES,
        codexFold,
        (w) => {
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.usage).toBeNull();
          expect(w.out).toEqual(captureLimitResult(" \n".repeat(MAX_CAPTURE_BYTES / 2)));
        },
      ],
      [
        "human lines cross the bound before a trailing line in the same chunk (al40)",
        "human\n" + "x\n".repeat((MAX_CAPTURE_BYTES - 6) / 2) + "ab\nTAIL\n",
        BIG_SIZES,
        codexFold,
        (w) => {
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult("human\n" + "x\n".repeat((MAX_CAPTURE_BYTES - 6) / 2)));
        },
      ],
      [
        "an unfinished human tail crosses the bound at EOF (al40)",
        "human\n" + "x\n".repeat((MAX_CAPTURE_BYTES - 6) / 2) + "あ",
        BIG_SIZES,
        codexFold,
        (w) => {
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult("human\n" + "x\n".repeat((MAX_CAPTURE_BYTES - 6) / 2)));
        },
      ],
      [
        "reply then overflowing warning then completion (al38)",
        [THREAD, turnStarted(), agentMessage("r".repeat(MAX_CAPTURE_BYTES - 2000)),
          JSON.stringify({ type: "item.completed", item: { id: "warning", type: "error", message: "w".repeat(3000) } }),
          turnCompleted(USAGE_FULL)].join("\n") + "\n",
        BIG_SIZES,
        codexFold,
        (w) => {
          expect(w.over).toBe(true);
          expect(w.usage).toBeNull(); // The completion after overflow was never folded.
          expect(w.out).toEqual(captureLimitResult("r".repeat(MAX_CAPTURE_BYTES - 2000) + "\n"));
        },
      ],
      ["small", completeStream("the reply"), SMALL_SIZES, codexFold, (w) => {
        expect(w.over).toBe(false);
        expect(w.out.success).toBe(true);
        expect(w.out.stdout).toBe("the reply\n");
        expect(w.out.usage).toEqual(FULL_BLOCK);
      }],
      [
        "warnings and errors",
        [THREAD, turnStarted(), warningItem(), turnFailed("Usage limit reached")].join("\n") + "\n",
        SMALL_SIZES,
        codexFold,
        (w) => {
          expect(w.over).toBe(false);
          expect(w.out.success).toBe(false);
          expect(w.out.exitCode).toBe(1);
          expect(w.out.stdout).toBe("");
          expect(w.out.stderr).toContain(codexWarningNote(WARNING_TEXT));
          expect(w.out.stderr).toContain("Usage limit reached");
          expect(w.out.usage).toEqual(emptyUsage());
        },
      ],
      [
        "a truncated last line",
        [THREAD, turnStarted(), agentMessage("partial"), turnCompleted(USAGE_FULL)].join("\n"),
        SMALL_SIZES,
        codexFold,
        (w) => {
          // The final event's newline never arrived; close() folds the
          // tail as an unterminated line and the value accounting applies
          // its delta exactly as a terminated one's — the completion rule
          // holds at the stream's own edge.
          expect(w.over).toBe(false);
          expect(w.out.success).toBe(true);
          expect(w.out.stdout).toBe("partial\n");
          expect(w.out.usage).toEqual(FULL_BLOCK);
        },
      ],
      [
        "blank lines",
        [THREAD, "", turnStarted(), "", agentMessage("the reply"), "", turnCompleted(USAGE_FULL), ""].join("\n") + "\n",
        SMALL_SIZES,
        codexFold,
        (w) => {
          expect(w.over).toBe(false);
          expect(w.out.success).toBe(true);
          expect(w.out.stdout).toBe("the reply\n");
          expect(w.out.usage).toEqual(FULL_BLOCK);
        },
      ],
      [
        "just under the bound",
        nearBoundStream(-8192),
        BIG_SIZES,
        codexFold,
        (w) => {
          // The pin al27's under test drew, swept across chunkings: the
          // residue never crosses, so no grouping dies at exit 125.
          expect(w.over).toBe(false);
          expect(w.out.success).toBe(true);
          expect(w.out.usage).toEqual(FULL_BLOCK);
        },
      ],
      [
        "just over the bound",
        nearBoundStream(8192),
        BIG_SIZES,
        codexFold,
        (w) => {
          // And its mirror: the retained total crosses in every
          // grouping, the whole delivery included, so the runner fails
          // every one at the capture limit — the modeled 125 carrying
          // the reply the fold holds as its partial output (round al37:
          // `over` decides the answer, and the verdict never runs past
          // it).
          expect(w.over).toBe(true);
          expect(w.out.exitCode).toBe(125);
          expect(w.out.success).toBe(false);
          expect(w.out.stderr).toBe(
            `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`
          );
          expect(w.out.stdout.endsWith("\n")).toBe(true);
        },
      ],
    ];
    for (const [label, stream, sizes, makeFold, expectWhole] of cases) {
      // Model the runner's first overflowing read for retained wire values.
      const reference = deliverBy(makeFold, stream, (remaining) => remaining, true);
      expectWhole(reference);
      for (const size of sizes) {
        const answer = deliverBy(makeFold, stream, () => size, true);
        expect(answer.over, `${label} / ${size}B chunks`).toBe(reference.over);
        expect(answer.kept, `${label} / ${size}B chunks`).toBe(reference.kept);
        expect(answer.out, `${label} / ${size}B chunks`).toEqual(reference.out);
        expect(answer.usage, `${label} / ${size}B chunks`).toEqual(reference.usage);
      }
    }
    // Round al37's own family: one line past the bound somewhere in the
    // stream, and the required answer is the runner's — exit 125 and
    // the same stderr in every chunking, with the partial output
    // (finish()) identical too, for the latch freezes the state at the
    // same completed-lines prefix whichever boundaries the pipe's reads
    // land on. The chunkings span the extremes (whole, one byte at a
    // time), the even split (halves), and a seeded random walk whose
    // boundaries land off every newline.
    const randState = { seed: 0x00a137 };
    const randomSize = (): number => {
      randState.seed = (Math.imul(randState.seed, 1664525) + 1013904223) >>> 0;
      return 1 + ((randState.seed >>> 8) % 2048);
    };
    const opencodeFold = (): OpenCodePlainFold => new OpenCodePlainFold();
    const oversizedCases: Array<
      readonly [string, string, () => ChunkedFold, (w: Answer) => void]
    > = [
      [
        "a codex oversized tool part",
        [THREAD, turnStarted(), oversizedToolLine, agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n",
        codexFold,
        (w) => {
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult(""));
        },
      ],
      [
        "a codex oversized text part",
        [THREAD, turnStarted(), agentMessage("r".repeat(MAX_CAPTURE_BYTES + 1)), turnCompleted(USAGE_FULL)].join("\n") + "\n",
        codexFold,
        (w) => {
          // The reply candidate itself over the bound: the run dies at
          // the capture limit, never a silently superseded answer — and
          // there is no partial output, for no message was read whole.
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult(""));
        },
      ],
      [
        "a codex oversized first line, regime undecided",
        oversizedToolLine + "\n" + [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n",
        codexFold,
        (w) => {
          // The wire is committed only by an announcement READ WHOLE, so
          // the regime stays undecided (al35's oversized commit rule is
          // deleted) and the answer is still the one 125.
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult(""));
        },
      ],
      [
        "a codex oversized line in decided human mode",
        ["hello", "w".repeat(MAX_CAPTURE_BYTES + 1), "world"].join("\n") + "\n",
        codexFold,
        (w) => {
          // al31's bounded prefix is the one thing al37 keeps: the
          // partial output carries the whole lines plus the prefix of
          // the dropped one, the same bytes in every chunking.
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out.exitCode).toBe(125);
          expect(w.out.stderr).toBe(
            `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`
          );
          expect(w.out.stdout.startsWith("hello\n")).toBe(true);
          expect(Buffer.byteLength(w.out.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
        },
      ],
      [
        "an opencode oversized tool event, then the wire (al36 flipped)",
        opencodeOversizedToolStream,
        opencodeFold,
        (w) => {
          // The al36 finding, re-answered: the oversized FIRST tool
          // event fails the run at the capture limit in every grouping —
          // no retained prefix, no later wire line to reclassify the
          // drop, no folded usage.
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult(""));
        },
      ],
      [
        "an opencode oversized plain line, hatch open",
        `line one\n${"x".repeat(MAX_CAPTURE_BYTES + 1)}\nline two\n`,
        opencodeFold,
        (w) => {
          expect(w.over).toBe(true);
          expect(w.kept).toBe(MAX_CAPTURE_BYTES + 1);
          expect(w.out).toEqual(captureLimitResult("line one\n"));
        },
      ],
    ];
    for (const [label, stream, makeFold, expectWhole] of oversizedCases) {
      const reference = whole(stream, makeFold);
      expectWhole(reference);
      const chunkings: Array<
        readonly [string, (remaining: number, at: number) => number]
      > = [
        ["halves", (remaining, at) => (at === 0 ? Math.ceil(remaining / 2) : remaining)],
        ["one byte at a time", () => 1],
        ["random splits", () => randomSize()],
      ];
      for (const [chunkLabel, nextSize] of chunkings) {
        const answer = deliverBy(makeFold, stream, nextSize);
        expect(answer.over, `${label} / ${chunkLabel}`).toBe(true);
        expect(answer.kept, `${label} / ${chunkLabel}`).toBe(reference.kept);
        expect(answer.out, `${label} / ${chunkLabel}`).toEqual(reference.out);
      }
    }
  }, 240_000);

  test("an oversized tool-part line over the whole capture bound fails the run at the capture limit (ul5, al8, al37)", () => {
    // The realistic oversized line: an item event carrying a tool's bulk
    // output. Since al8 the drop of such a line was reserved for a head
    // a classifier could read before letting the line go; al37 deletes
    // the classifier with its premise — a fold that picked which unread
    // bytes were safe to lose by their first bytes was guessing about a
    // line it never read. One rule answers every oversized line now:
    // the latch, and the run fails at the capture limit — exit 125, the
    // partial output the fold held, nothing of the line itself.
    const oversizedToolLine = (itemHead: string): CodexPlainFold => {
      const fold = new CodexPlainFold();
      fold.push(THREAD + "\n" + turnStarted() + "\n");
      fold.push(`{"type":"item.completed","item":${itemHead}`);
      fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
      fold.push(`"}}\n`);
      fold.push(agentMessage("the reply") + "\n");
      fold.push(turnCompleted(USAGE_FULL) + "\n");
      return fold;
    };
    for (const head of [
      `{"type":"command_execution","command":"ls","aggregated_output":"`,
      `{"id":"i0","type":"mcp_tool_call","server":"srv","arguments":{},"output":"`,
    ]) {
      const fold = oversizedToolLine(head);
      expect(fold.keptBytes(), head).toBe(MAX_CAPTURE_BYTES + 1);
      // Nothing after the latch folds: the reply and the completion the
      // stream went on to carry are the pipe's business, never the
      // run's — no message was read whole, so there is no partial
      // output to return.
      expect(fold.finish(), head).toBe("");
      expect(captureLimitResult(""), head).toEqual({
        stdout: "",
        stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
        exitCode: 125,
        success: false,
      });
    }
  });

  test("an oversized collaboration event fails the run at the capture limit like every item type (al13, al37)", () => {
    // The al13 finding — the classifier's vocabulary could never be
    // complete, for it was enumerated from the item types the fixtures
    // had shown — is answered by deleting the classifier: no item type
    // is named by the drop rule anymore, because no head is read at
    // all. Both wire spellings the grammar uses (the item's type tag
    // first, a short id before it) take the one answer: the latch,
    // exit 125.
    for (const head of [
      `{"type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"th_1","receiver_thread_ids":["th_2"],"prompt":"spawn a helper","agents_states":{"th_2":{"status":"running","message":"`,
      `{"id":"i0","type":"collab_tool_call","tool":"wait","agents_states":{"th_2":{"status":"completed","message":"`,
    ]) {
      const fold = new CodexPlainFold();
      fold.push(THREAD + "\n" + turnStarted() + "\n");
      fold.push(`{"type":"item.updated","item":${head}`);
      fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
      fold.push(`"}}}}\n`);
      fold.push(agentMessage("the reply") + "\n");
      fold.push(turnCompleted(USAGE_FULL) + "\n");
      expect(fold.keptBytes(), head).toBe(MAX_CAPTURE_BYTES + 1);
      expect(fold.finish(), head).toBe("");
      expect(captureLimitResult("").exitCode, head).toBe(125);
    }
  });

  test("an oversized final-message line inside an open turn fails the run at the capture limit (al8, al37)", () => {
    // The seventh review's finding, re-answered by al37's one rule: the
    // drop once left the reduction standing on the lines it had read,
    // so a turn that went on to complete printed the PREVIOUS
    // agent_message as a successful reply — "I will now look at the
    // files." posing as the answer. The drift arm al8 answered with is
    // deleted with the classifier it served: the line's size fails the
    // run at the capture limit — exit 125 — and the partial output is
    // the message the fold read whole before the drop, the same partial
    // the whole-stream capture would return.
    const fold = new CodexPlainFold();
    fold.push(
      [THREAD, turnStarted(), agentMessage("I will now look at the files.")].join("\n") + "\n"
    );
    // The giant final message arrives in chunks; the drop fires while the
    // line is still unterminated past the bound, exactly as the pipe
    // delivers it (the ul5 shape).
    fold.push(`{"type":"item.completed","item":{"id":"big","type":"agent_message","text":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}}\n`);
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("I will now look at the files.\n");
    expect(captureLimitResult("I will now look at the files.\n")).toEqual({
      stdout: "I will now look at the files.\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
  });

  test("an oversized `{`-shaped first line leaves the regime undecided and fails at the capture limit; a line READ WHOLE commits (al21, al30, al35, al37)", () => {
    // Round al37 deletes al35's oversized-commit rule with the premise
    // it served: the regime is committed only by an announcement read
    // whole, so a first line past the bound commits NOTHING — the
    // regime stays undecided, no prefix is retained (that arm belongs
    // to a stream human mode has already decided), and the run fails
    // at the capture limit, exit 125. Never a wire commitment whose
    // drift would fail the run at exit 1, never a silent truncation.
    const fold = new CodexPlainFold();
    // A blank line commits nothing: the regime is still undecided, and
    // the blank byte is undecided mode's.
    fold.push("\n");
    const hatched = fold as unknown as { raw: string; rawBytes: number };
    expect(hatched.rawBytes).toBe(1);
    // The oversized `{`-shaped line is the first non-empty output.
    fold.push(`{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}}\n`);
    // Undecided: no commitment was made, for the line was never read —
    // and no prefix joins raw on an undecided regime, so the partial
    // output is the blank byte alone. The latch answers every poll, and
    // the reduction never saw the line (no drift).
    expect((fold as unknown as { state: { mode: string | null } }).state.mode).toBeNull();
    expect(hatched.rawBytes).toBe(1);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("\n");
    expect(captureLimitResult("\n")).toEqual({
      stdout: "\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
    expect(
      (fold as unknown as { state: { reducer: { drift: string | null } } }).state.reducer.drift
    ).toBeNull();

    // The al21 rule survives on the read side: the announcement read
    // WHOLE is the wire commitment that frees human mode's bytes at that
    // moment, exactly as decideMode frees them.
    const read = new CodexPlainFold();
    read.push("\n");
    read.push(THREAD + "\n");
    expect((read as unknown as { state: { mode: string | null } }).state.mode).toBe("wire");
    const readHatched = read as unknown as { raw: string; rawBytes: number };
    expect(readHatched.raw).toBe("");
    expect(readHatched.rawBytes).toBe(0);
    expect(read.keptBytes()).toBeLessThan(1024);

    // The mirror: once a non-empty plain line has decided human mode, an
    // oversized `{`-shaped line is human stdout the fold could not hold —
    // the capture limit's answer with al31's bounded prefix as the
    // partial output, never a flip and never a silent truncation (rule
    // 3: nothing later flips the regime).
    const human = new CodexPlainFold();
    human.push("plain stdout line one\nplain stdout line two\n");
    human.push(`{"type":"item.completed","item":{`);
    human.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect((human as unknown as { state: { mode: string | null } }).state.mode).toBe("human");
    expect(human.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    const humanPartial = human.finish();
    expect(humanPartial.startsWith("plain stdout line one\nplain stdout line two\n")).toBe(true);
    expect(Buffer.byteLength(humanPartial)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(captureLimitResult(humanPartial).exitCode).toBe(125);
  });

  test("an oversized startup warning before the first turn fails the run at the capture limit; its small spelling keeps the warning arm (al35, al37)", () => {
    // The reducer's carve-out (result-envelope.ts) still accepts a
    // completed error item between thread.started and turn.started as a
    // startup warning — its SMALL spelling below succeeds with the
    // warning on stderr. The oversized spelling is not the reducer's to
    // judge: the line was never read, so no carve-out applies — al37's
    // one rule answers it with the capture-limit failure, exit 125.
    // Size decides the failure's kind, never the run's success, and it
    // decides that one thing for every event type alike.
    const oversizedWarningLine = (): string =>
      `{"type":"item.completed","item":{"id":"item_2","type":"error","message":"` +
      `ignored config key 'model_reasoning_effort' ` +
      "x".repeat(MAX_CAPTURE_BYTES) +
      `"}}`;
    // The small spelling succeeds with the warning on stderr (the
    // reducer's carve-out, pinned at the fold level).
    const small = new CodexPlainFold();
    small.push(
      [THREAD, warningItem(), turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)]
        .join("\n") + "\n"
    );
    const smallOut = small.verdict(finished(""));
    expect(smallOut.success).toBe(true);
    expect(smallOut.stdout).toBe("the reply\n");
    expect(smallOut.stderr).toContain("codex warning");
    // The oversized spelling is the capture limit's own failure: the
    // warning's text is gone — the line is past the bound, so its
    // message was never read — and with it the warning note the small
    // spelling carries.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n");
    fold.push(oversizedWarningLine() + "\n");
    fold.push(
      [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("");
    const out = captureLimitResult("");
    expect(out.exitCode).toBe(125);
    expect(out.stderr).not.toContain("codex warning");
  });

  test("an oversized reroute notice before the first turn fails at the capture limit; its small spelling keeps the drift (al34, al35, al37)", () => {
    // The al34 rule survives on the READ side — a reroute notice before
    // any turn is drift, for it attributes a model onto a turn that was
    // never served — and the oversized spelling never reaches it: the
    // line is dropped unread, al37's latch answers, and the run fails
    // at the capture limit. Size decides the failure's kind.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n");
    fold.push(
      `{"type":"item.completed","item":{"id":"item_1","type":"error","message":"model rerouted: gpt-5.1 -> gpt-5.2 (` +
        "x".repeat(MAX_CAPTURE_BYTES) +
        `)"}}` +
        "\n"
    );
    fold.push(
      [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(captureLimitResult(fold.finish()).exitCode).toBe(125);
    // The small spelling of the same notice still drifts — the reducer's
    // own rule, unchanged by the bound (pinned in full in
    // tests/result-envelope.test.ts).
    const small = new CodexPlainFold();
    small.push(THREAD + "\n");
    small.push(
      `{"type":"item.completed","item":{"id":"item_1","type":"error","message":"model rerouted: gpt-5.1 -> gpt-5.2 (region)"}}` +
        "\n"
    );
    small.push(
      [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    const smallOut = small.verdict(finished(""));
    expect(smallOut.success).toBe(false);
    expect(smallOut.stderr).toContain("outside a turn");
    expect(smallOut.servedModel).toBeNull();
  });

  test("an oversized warning inside an open turn fails the run at the capture limit (al22, al35, al37)", () => {
    // al22's rule — a completed error item inside a turn is a warning
    // the run survives — is the reducer's, and the reducer only ever
    // sees lines read whole. The oversized spelling is dropped unread:
    // al37's latch, exit 125, no head classified, no message read.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(
      `{"type":"item.completed","item":{"id":"item_2","type":"error","message":"` +
        "x".repeat(MAX_CAPTURE_BYTES + 1) +
        `"}}` +
        "\n"
    );
    fold.push(agentMessage("the reply") + "\n");
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("");
    expect(captureLimitResult("").exitCode).toBe(125);
  });

  test("an oversized warning past the last turn.completed fails at the capture limit, the reply its partial (al35, al37)", () => {
    // The carve-out's far boundary is unread too: the completed turn's
    // reply was read whole before the drop, so the modeled 125 carries
    // it as the partial output — the same partial the whole-stream
    // capture would have returned.
    const fold = new CodexPlainFold();
    fold.push(
      [THREAD, turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    fold.push(
      `{"type":"item.completed","item":{"id":"item_3","type":"error","message":"` +
        "x".repeat(MAX_CAPTURE_BYTES + 1) +
        `"}}` +
        "\n"
    );
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n")).toEqual({
      stdout: "the reply\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
  });

  test("an oversized line whose newline shares the crossing chunk latches exactly like the split one (al16, al37)", () => {
    // The review's repro, replayed with its own numbers: a 16,777,805-byte
    // item.completed event — an 8,388,864-byte reply padded to size — whose
    // newline arrived in the same 64 KiB pipe chunk that carried the line
    // past the bound. Only the unterminated line triggered the drop, so
    // this stream parsed the giant line whole while an initial 256-byte
    // chunk — shifting every boundary — answered the same bytes
    // differently: the verdict rode the pipe's read grouping. A completed
    // line is size-checked before it is parsed, and al37's latch freezes
    // the state at the same completed-lines prefix under every grouping,
    // so every grouping below answers the one runner result: exit 125,
    // the same stderr, the same partial output.
    const EVENT_BYTES = 16_777_805;
    const REPLY_BYTES = 8_388_864;
    const head = `{"type":"item.completed","item":{"id":"big","type":"agent_message","text":"`;
    const mid = `","padding":"`;
    const tail = `"}}`;
    const giant =
      head +
      "r".repeat(REPLY_BYTES) +
      mid +
      "p".repeat(EVENT_BYTES - head.length - REPLY_BYTES - mid.length - tail.length) +
      tail;
    expect(Buffer.byteLength(giant)).toBe(EVENT_BYTES);
    const stream =
      [THREAD, turnStarted(), agentMessage("I will now look at the files.")].join("\n") +
      "\n" +
      giant +
      "\n" +
      turnCompleted(USAGE_FULL) +
      "\n";
    const foldOf = (first: number, size: number): CodexPlainFold => {
      const fold = new CodexPlainFold();
      fold.push(stream.slice(0, first));
      for (let at = first; at < stream.length; at += size) {
        fold.push(stream.slice(at, at + size));
      }
      return fold;
    };
    const outs: RunResult[] = [];
    for (const [label, fold] of [
      ["whole", foldOf(stream.length, stream.length)],
      ["64 KiB", foldOf(0, 64 * 1024)],
      ["256-byte first chunk", foldOf(256, 64 * 1024)],
    ] as Array<readonly [string, CodexPlainFold]>) {
      expect(fold.keptBytes(), label).toBe(MAX_CAPTURE_BYTES + 1);
      expect(fold.finish(), label).toBe("I will now look at the files.\n");
      const out = captureLimitResult(fold.finish());
      expect(out.exitCode, label).toBe(125);
      expect(out.success, label).toBe(false);
      outs.push(out);
    }
    expect(outs[1]!).toEqual(outs[0]!);
    expect(outs[2]!).toEqual(outs[0]!);
    // The whole-capture replay — one push, so the completed-line check's
    // own observation point — latches too: its verdict refuses the
    // stream (the turn never completed, so no reply poses as the run's),
    // and no caller of either shape ever sees a success.
    const replay = codexPlainStreamResult(finished(stream));
    expect(replay.success).toBe(false);
    expect(replay.stdout).toBe("");
  });

  test("an oversized wire line the head cannot classify answers like every other: the capture limit (al8, al37)", () => {
    // The classifier's boundary question — which oversized heads may
    // die quietly — is deleted with the classifier (al37): an
    // unidentified head and an identified one take the one answer, for
    // no head is read at all. The reply candidate the line might have
    // carried is nobody's to guess about; the partial output is the
    // message read whole before the drop.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(agentMessage("partial") + "\n");
    fold.push(`{"type":"item.updated","item":{"id":"i0","type":"other","data":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}}\n`);
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("partial\n");
    expect(captureLimitResult("partial\n").exitCode).toBe(125);
  });

  test("an oversized wire line past the last turn.completed fails the run at the capture limit, whatever its shape (al11 re-review, al37)", () => {
    // al11's re-review made both sizes answer the same failure; al37
    // changes the oversized failure's kind — the capture limit, exit
    // 125, with the completed turn's reply as the partial output —
    // while the small spelling keeps the drift it always had. Size
    // decides the failure's kind, never the run's success.
    for (const shape of [
      `{"type":"item.completed","item":{"id":"tail","type":"agent_message","text":"`,
      `{"type":"item.completed","item":{"id":"tail","type":"command_execution","aggregated_output":"`,
    ]) {
      const fold = new CodexPlainFold();
      fold.push(completeStream("the reply"));
      fold.push(shape);
      fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
      fold.push(`"}}\n`);
      expect(fold.keptBytes(), shape).toBe(MAX_CAPTURE_BYTES + 1);
      expect(fold.finish(), shape).toBe("the reply\n");
      expect(captureLimitResult("the reply\n").exitCode, shape).toBe(125);
    }
    // The small spelling of the same trailing item drifts — the
    // reduction's own rule (round23), unchanged by the bound.
    const small = foldStream(
      completeStream("the reply") +
        JSON.stringify({
          type: "item.completed",
          item: { id: "tail", type: "agent_message", text: "late" },
        }) +
        "\n"
    ).verdict(finished(""));
    expect(small.success).toBe(false);
    expect(small.stderr).toContain("no turn reopened");
  });

  test("an oversized top-level error event past the last turn.completed fails the run at the capture limit (al11 re-review, al37)", () => {
    // The al11 shape whose small spelling fails through the error arm: an
    // error event is the stream's own terminal verdict, and the oversized
    // spelling is the capture limit's own failure now — exit 125, the
    // completed turn's reply as the partial output — while the small
    // spelling below keeps its own verdict. Neither size answers a
    // success.
    const fold = new CodexPlainFold();
    fold.push(completeStream("the reply"));
    fold.push(`{"type":"error","message":"`);
    fold.push("e".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}\n`);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n").exitCode).toBe(125);
    // The small spelling of the same stream fails through the error arm
    // (with codex's own text, the envelope path's rule).
    const small = foldStream(
      completeStream("the reply") +
        JSON.stringify({ type: "error", message: "provider down" }) +
        "\n"
    ).verdict(finished(""));
    expect(small.success).toBe(false);
    expect(small.exitCode).toBe(1);
    expect(small.stdout).toBe("");
    expect(small.stderr).toContain("codex run failed");
    expect(small.stderr).toContain("provider down");
  });

  test("an oversized non-wire line marks the run over the limit at once, never a silent truncation (ul5, al37)", () => {
    // The hatch's plain stdout, unreadable whole: the trailing check
    // latches mid-accumulation — the runner's next poll reads the bound
    // crossed — and the modeled result fails at the capture limit. No
    // line was ever completed, so there is no partial output.
    const fold = new CodexPlainFold();
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(captureLimitResult(fold.finish()).exitCode).toBe(125);
  });

  test("an oversized non-object line after the wire fails the run at the capture limit; its small spelling keeps the drift (al14, al37)", () => {
    // The al14 contracts finding — one stream answering differently by
    // the size of a single line — is settled by making the
    // capture-limit answer the rule for EVERY oversized line, read and
    // classified by nothing: the oversized spelling below latches, and
    // the small spelling after it keeps the drift, so the difference
    // between the sizes is the failure's kind, never the run's success.
    const fold = new CodexPlainFold();
    fold.push(completeStream("the reply"));
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push("\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n").exitCode).toBe(125);
    // The small spelling of the same trailing non-object line drifts.
    const small = foldStream(completeStream("the reply") + "noise\n").verdict(finished(""));
    expect(small.success).toBe(false);
    expect(small.exitCode).toBe(1);
    expect(small.stdout).toBe("");
    expect(small.stderr).toContain("cannot parse");
  });

  test("a turn that never completed prints no stdout, not its intermediate message (al3)", () => {
    // Codex killed on timeout after an agent_message but before
    // turn.completed: the reducer still holds that message, and it must not
    // be presented as the reply.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(agentMessage("half an answer") + "\n");
    const out = fold.verdict({ ...finished(""), exitCode: 124, success: false });
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
  });

  test("a drifted stream prints no stdout either (al3)", () => {
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(agentMessage("half an answer") + "\n");
    fold.push(`{"type":"turn.completed","usage":`); // cut mid-write, no newline
    const out = fold.verdict({ ...finished(""), exitCode: 137, success: false });
    expect(out.success).toBe(false);
    expect(out.stdout).toBe("");
  });

  test("foldedUsage reports the last turn.completed snapshot, or null (ul6)", () => {
    // The in-flight usage a signal interrupt's receipt records
    // (launch.ts): the last snapshot the stream reported, never a guess.
    const fold = new CodexPlainFold();
    expect(fold.foldedUsage()).toBeNull();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(agentMessage("the reply") + "\n");
    expect(fold.foldedUsage()).toBeNull(); // no turn completed yet
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.foldedUsage()).toEqual(FULL_BLOCK);
  });

  test("keptBytes counts UTF-8 bytes, the capture bound's unit — not code units (ul6)", () => {
    const hatch = new CodexPlainFold();
    hatch.push("あああ"); // plain stdout, no wire evidence: kept verbatim
    expect(hatch.keptBytes()).toBe(0); // The partial line is accounted at EOF.
    expect(hatch.finish()).toBe("あああ");
    expect(hatch.keptBytes()).toBe(9);
    // The wire regime's reply counts the same way: あ is 3 bytes each.
    const wire = new CodexPlainFold();
    wire.push(completeStream("あああ"));
    expect(wire.keptBytes()).toBeLessThan(1024);
    expect(wire.verdict(finished("")).stdout).toBe("あああ\n");
  });

  test("the sink and the whole-capture fold agree on every verdict shape (ul4)", () => {
    // One shared reduction and verdict is the design; this pins it. The
    // same stdout, streamed in 7-byte chunks versus handed over whole,
    // must produce equal RunResults — success, hatch, drift, failed turn,
    // truncated, and messageless alike.
    const drift = [THREAD, turnStarted(), agentMessage("partial"), "noise", turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const failed = [THREAD, turnStarted(), agentMessage("partial"), turnFailed("Usage limit reached")].join("\n") + "\n";
    const truncated = [THREAD, turnStarted(), agentMessage("partial")].join("\n") + "\n";
    const messageless = [THREAD, turnStarted(), toolItem("thinking"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const shapes: Array<[string, string]> = [
      ["success", completeStream("the reply")],
      ["hatch", "hello\n"],
      ["drift", drift],
      ["failed turn", failed],
      ["truncated", truncated],
      ["messageless", messageless],
    ];
    for (const [label, stream] of shapes) {
      const result = finished(stream);
      expect(foldStream(stream).verdict(result), label).toEqual(
        codexPlainStreamResult(result)
      );
    }
  });
});
