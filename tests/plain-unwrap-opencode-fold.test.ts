import { describe, expect, test } from "bun:test";
import { OpenCodePlainFold, opencodePlainResult } from "../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunResult } from "../src/types.js";
import {
  captureLimitResult,
  finished,
  opencodeFoldStream,
  part,
  stepFinish,
  toolUse,
} from "./helpers/plain-unwrap.js";

const foldStream = opencodeFoldStream;

describe("OpenCodePlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--format json` stream (review ul4). The part/stepFinish builders from
  // the whole-capture describe apply here too.

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
    // the framing pin's (session-process-stdout.test.ts): the SAME 12 MiB of
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
