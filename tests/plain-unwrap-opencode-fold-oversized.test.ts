import { describe, expect, test } from "bun:test";
import { OpenCodePlainFold } from "../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import { captureLimitResult, finished, part, stepFinish } from "./helpers/plain-unwrap.js";

describe("OpenCodePlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--format json` stream (review ul4). The part/stepFinish builders from
  // the whole-capture describe apply here too.

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
});
