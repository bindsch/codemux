// Fold evidence for the hermetic check on goose and kimi (merge review of
// lane AN1, findings 4 and 5): goose's fold sheds user-role lines whatever
// the message's field order, a marker in a shed goose line reaches the
// run's scanSurface, and the kimi fold keeps every marker of a shed line.
import { describe, expect, test } from "bun:test";
import { GooseAdapter } from "../src/adapters/goose.js";
import { gooseStreamFold, isGooseUserMessageHead } from "../src/goose-answer.js";
import { KimiPlainFold } from "../src/plain-unwrap/kimi-fold.js";
import type { RunResult } from "../src/types.js";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });
const lines = (events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const MARKER = "CODEMUX-CANARY-0123ABCD";
const SECOND = "CODEMUX-CANARY-4567CDEF";

describe("goose fold", () => {
  test("a user line is shed whatever its field order", () => {
    for (const message of [
      { id: "r1", role: "user", created: 1, content: [] },
      { created: 1, role: "user", id: "r1", content: [] },
      { role: "user", content: [], id: null },
    ]) {
      expect(isGooseUserMessageHead(JSON.stringify({ type: "message", message }))).toBe(true);
    }
  });

  test("an assistant line whose tool arguments carry a user role is kept", () => {
    const line = JSON.stringify({ type: "message", message: { id: "a1", role: "assistant", created: 1,
      content: [{ type: "toolRequest", id: "t1", toolCall: { arguments: { role: "user" } } }] } });
    expect(isGooseUserMessageHead(line)).toBe(false);
  });

  test("a marker in a shed tool response reaches the run's scanSurface", () => {
    const fold = gooseStreamFold();
    fold.push(lines([
      { type: "message", message: { id: "u0", role: "user", created: 0, content: [{ type: "text", text: "audit" }] } },
      { type: "message", message: { created: 1, role: "user", id: "r1",
        content: [{ type: "toolResponse", id: "t", toolResult: { status: "success", value: [MARKER] } }] } },
      { type: "message", message: { id: "a1", role: "assistant", created: 2, content: [{ type: "text", text: "OK" }] } },
      { type: "complete", total_tokens: 3 },
    ]));
    const kept = fold.finish();
    expect(kept).not.toContain(MARKER);
    const out = new GooseAdapter({}).processRunResult(ok(kept), { agent: "goose", prompt: "p" }, { stdoutSink: fold });
    expect(out.stdout).toBe("OK\n");
    expect(out.scanSurface).toContain(MARKER);
  });
});

describe("kimi fold", () => {
  test("every marker of one shed tool line is kept, not only the first", () => {
    const fold = new KimiPlainFold();
    fold.push(`${JSON.stringify({ role: "tool", tool_call_id: "call_1", content: `${MARKER} ${"y".repeat(300)} ${SECOND}` })}\n`);
    fold.finish();
    expect(fold.droppedMarkerEvidence()).toContain(MARKER);
    expect(fold.droppedMarkerEvidence()).toContain(SECOND);
  });
});
