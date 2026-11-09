import { describe, expect, test } from "bun:test";
import { SessionOutputQueue } from "../src/session/completion.js";

// This is the common completion contract, including cline's declared
// session limitation. Driver integration is covered in the sibling files.
const AGENTS = ["claude", "zai", "codex", "kimi", "opencode", "agy", "aider",
  "cursor", "droid", "gemini", "pi", "qwen", "copilot", "goose", "openhands", "cline"] as const;

function fixture() {
  const events: Record<string, unknown>[] = [];
  const queue = new SessionOutputQueue((line) => { events.push(JSON.parse(line)); },
    () => { throw new Error("unexpected outbound failure"); });
  const emit = (event: Record<string, unknown>) => queue.enqueue(JSON.stringify(event));
  return { queue, events, emit };
}

describe("every agent shares the empty-answer session completion contract", () => {
  for (const agent of AGENTS) {
    test(`${agent}: empty and whitespace answers fail without losing usage`, async () => {
      for (const text of [undefined, "", " \n\t\u2003"]) {
        const h = fixture();
        h.emit({ type: "session_started", agent });
        h.emit({ type: "turn_started", turn_id: "t1" });
        if (text !== undefined) h.emit({ type: "assistant_message", turn_id: "t1", text });
        h.emit({ type: "turn_completed", turn_id: "t1", finish: "end", usage: { output_tokens: 17 } });
        await h.queue.flush();
        expect(h.events.at(-1)).toMatchObject({ finish: "failed", reason: "empty answer", usage: { output_tokens: 17 } });
        expect(h.queue.completeTurn("t1", "end")).toEqual({ finish: "failed", reason: "empty answer" });
      }
    });
  }

  test("assistant messages and streamed text count; tool and reasoning payloads do not", async () => {
    for (const type of ["assistant_message", "assistant_delta", "tool_result", "unknown"]) {
      const h = fixture();
      h.emit({ type: "turn_started", turn_id: "t1" });
      h.emit({ type, turn_id: "t1", text: "answer", delta: "answer", output: "answer" });
      h.emit({ type: "turn_completed", turn_id: "t1", finish: "end" });
      await h.queue.flush();
      expect(h.events.at(-1)?.finish).toBe(type.startsWith("assistant_") ? "end" : "failed");
    }
  });

  test("failed and interrupted completions retain their original reasons", async () => {
    for (const finish of ["failed", "interrupted"] as const) {
      const h = fixture();
      h.emit({ type: "turn_started", turn_id: "t1" });
      h.emit({ type: "turn_completed", turn_id: "t1", finish, reason: "native reason" });
      await h.queue.flush();
      expect(h.events.at(-1)).toMatchObject({ finish, reason: "native reason" });
    }
  });

  test("a prior turn or foreign text cannot answer the next turn", async () => {
    const h = fixture();
    h.emit({ type: "assistant_message", turn_id: "t1", text: "replayed answer" });
    h.emit({ type: "turn_started", turn_id: "t1" });
    h.emit({ type: "assistant_message", turn_id: "t1", text: "first answer" });
    h.emit({ type: "turn_completed", turn_id: "t1", finish: "end" });
    h.emit({ type: "turn_started", turn_id: "t2" });
    h.emit({ type: "assistant_message", turn_id: "t1", text: "late first answer" });
    h.emit({ type: "assistant_delta", turn_id: "t2", delta: " \n" });
    h.emit({ type: "assistant_message", turn_id: "t2", text: null });
    h.emit({ type: "turn_completed", turn_id: "t2", finish: "end" });
    h.emit({ type: "assistant_message", turn_id: "t2", text: "after completion" });
    await h.queue.flush();
    expect(h.events.filter((event) => event.type === "turn_completed").map((event) => event.finish))
      .toEqual(["end", "failed"]);
    expect(h.queue.completeTurn("t2", "end")).toEqual({ finish: "failed", reason: "empty answer" });
  });

  test("unasked completions and unrelated event fields remain unchanged", async () => {
    const h = fixture();
    const unasked = { type: "turn_completed", finish: "end", raw: "original" };
    h.emit(unasked);
    h.emit({ type: "turn_completed", turn_id: "unknown", finish: "native-extension" });
    await h.queue.flush();
    expect(h.events[0]).toEqual(unasked);
    expect(h.events[1]?.finish).toBe("native-extension");
    expect(h.queue.completeTurn("unknown", "end", "native reason"))
      .toEqual({ finish: "end", reason: "native reason" });
  });

  test("a sink can open the next turn before the previous ledger effect runs", async () => {
    const h = fixture();
    h.emit({ type: "turn_started", turn_id: "t1" });
    h.emit({ type: "turn_completed", turn_id: "t1", finish: "end" });
    h.emit({ type: "turn_started", turn_id: "t2" });
    h.emit({ type: "assistant_message", turn_id: "t2", text: "next answer" });
    expect(h.queue.completeTurn("t1", "end")).toEqual({ finish: "failed", reason: "empty answer" });
    expect(h.queue.completeTurn("t2", "end")).toEqual({ finish: "end" });
    await h.queue.flush();
  });
});
