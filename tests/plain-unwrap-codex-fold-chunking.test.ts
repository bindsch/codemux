import { describe, expect, test } from "bun:test";
import { CodexPlainFold, OpenCodePlainFold } from "../src/plain-unwrap.js";
import { codexWarningNote, emptyUsage } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunResult } from "../src/types.js";
import {
  agentMessage,
  captureLimitResult,
  completeStream,
  finished,
  FULL_BLOCK,
  THREAD,
  turnCompleted,
  turnFailed,
  turnStarted,
  USAGE_FULL,
  warningItem,
  WARNING_TEXT,
} from "./helpers/plain-unwrap.js";

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.

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
  // Measured: 126 s locally, 137 s to 260 s on the macOS CI runner
  // (2026-11-11), which overran a 240 s timeout without a defect.
  }, 600_000);

});
