import { describe, expect, test } from "bun:test";
import { CodexPlainFold, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunResult } from "../src/types.js";
import {
  agentMessage,
  codexFoldStream,
  completeStream,
  finished,
  FULL_BLOCK,
  rerouteItem,
  THREAD,
  toolItem,
  turnCompleted,
  turnFailed,
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
