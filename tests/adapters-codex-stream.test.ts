import { describe, test, expect } from "bun:test";
import { CodexAdapter } from "../src/adapters/codex.js";

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  test("processRunResult reduces the event stream to the envelope", () => {
    const stream = [
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "the reply" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          cache_write_input_tokens: 0,
          output_tokens: 6,
          reasoning_output_tokens: 0,
        },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe("the reply");
    expect(envelope.codemux.agent).toBe("codex");
    // The run launched with --ephemeral, so the thread id the stream named
    // is not one a later run could continue: null.
    expect(envelope.codemux.session_id).toBeNull();
    expect(envelope.codemux.usage.total_tokens).toBe(16);
  });

  test("processRunResult leaves stdout alone without --result-json", () => {
    const result = { stdout: "the reply\n", stderr: "", exitCode: 0, success: true };
    expect(adapter.processRunResult(result, { agent: "codex", prompt: "t" })).toEqual({ ...result, reply: "" });
  });

  test("a stream with no thread.started is a parse failure, not a warned run", () => {
    // The old warning still exited 0 on a stream like this. Strict parsing
    // now rejects a stream with no thread.started outright -- the grammar
    // opens every stream with it -- so the raw stdout stays and the run
    // fails as a parse failure.
    const stream = [
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "the reply" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe(stream);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a turn failure fails the run even when codex exits 0", () => {
    // The blocker's reproduction: thread.started plus a usage-limit
    // turn.failed with codex's own exit 0 used to stay successful with
    // empty stdout.
    const stream = [
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    // A failed turn has no final message, so the envelope carries none.
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.stderr).toContain("Usage limit reached");
  });

  test("an unparseable stream fails a --result-json run", () => {
    // Drift: the raw stdout stays for inspection and the run fails
    // instead of warning and exiting 0.
    const out = adapter.processRunResult(
      { stdout: "human-mode text\n", stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("human-mode text\n");
    expect(out.stderr).toContain("cannot parse");
  });

  test("a truncated stream fails the run too", () => {
    // The wrapper shape from the round-4 finding: a zero-exit stream whose
    // message item completed but whose turn never did has no result.
    const stream = [
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "partial" },
      },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("turn.completed");
  });

  test("an envelope whose stream names no thread cannot parse", () => {
    // A stream without the thread announcement is drift, so no envelope is
    // built from it: strict parsing rejects the stream before any verdict
    // runs, the raw stdout stays.
    const stream = [
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "continued" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const out = adapter.processRunResult(
      { stdout: stream, stderr: "", exitCode: 0, success: true },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stdout).toBe(stream);
    expect(out.stderr).toContain("cannot parse");
  });

});
