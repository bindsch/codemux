import { describe, expect, test } from "bun:test";
import { CodexPlainFold, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunResult } from "../src/types.js";
import {
  agentMessage,
  captureLimitResult,
  codexFoldStream,
  completeStream,
  finished,
  THREAD,
  turnCompleted,
  turnStarted,
  USAGE_FULL,
} from "./helpers/plain-unwrap.js";

const foldStream = codexFoldStream;

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.

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
});
