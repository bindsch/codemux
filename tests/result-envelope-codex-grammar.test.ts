import { describe, expect, test } from "bun:test";
import {
  CodexEventReducer,
  codexResult,
  codexStreamVerdict,
  parseCodexEventStream,
} from "../src/result-envelope.js";
import {
  finished,
  codexStream,
} from "./helpers/result-envelope.js";

describe("parseCodexEventStream grammar and model attribution", () => {
  test("a second thread.started is drift, not an announcement to ignore", () => {
    // The round7 finding: the case's comment called a second announcement
    // drift while the code silently ignored it, so a wrapper concatenating
    // two valid streams returned the second run's result with the first
    // run's thread. The reduction refuses the stream like any other
    // format drift.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "first-thread" },
      { type: "thread.started", thread_id: "second-thread" },
    ]))).toBeNull();
  });

  test("an empty thread.started announcement names nothing and is refused", () => {
    // The thread id identifies the conversation this stream records; an
    // announcement without one names nothing, so it is drift like any
    // other malformed event.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))).toBeNull();
  });

  test("a thread.started after any other event is drift, not an announcement", () => {
    // The round9 finding: the ordering the grammar documents (thread.started
    // opens the stream) was not enforced, so turn.started, a message, and a
    // completed turn followed by thread.started parsed successfully and the
    // completed response could pair with an unrelated thread.
    expect(parseCodexEventStream(codexStream([
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
    ]))).toBeNull();
  });

  test("a turn.started inside an open turn is drift, not a nested turn", () => {
    // The round9 finding: nested turns were counted, so a wrapper
    // concatenating streams that dropped the first turn's terminal event
    // let the tail's events close as a turn of this stream.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))).toBeNull();
  });

  test("a turn.completed no turn.started opened is drift, not a count to clamp", () => {
    // The round-8 finding: an unmatched terminal event was clamped to zero
    // open turns, so the tail of a prefix-truncated stream (or a wrapper's
    // splice) posed as a complete run. Every terminal event must match an
    // open turn; anything else is refused.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))).toBeNull();
    // The failed-terminal twin, for the same reason.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
    ]))).toBeNull();
  });

  test("a turn.failed is terminal: a later completed turn does not clear it", () => {
    // The round-8 finding: turn.completed cleared the failure
    // unconditionally, so a stream whose turn failed and whose next turn
    // completed read as success. Upstream discards a failed turn's final
    // message and no later event un-fails the run that reported it; only a
    // top-level `error` is superseded (the retried-error test above).
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
      { type: "turn.failed", error: { message: "Usage limit reached" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "retry reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))!;
    expect(stream.failure).toBe("Usage limit reached");
    expect(stream.finalMessage).toBeNull();
    // Through the verdict: the failure stands.
    expect(
      codexStreamVerdict(stream, { stdout: "", stderr: "", exitCode: 0, success: true })
    ).toEqual({ failed: true, diagnostic: expect.stringContaining("Usage limit reached") });
    const out = codexResult(
      {
        stdout: codexStream([
          { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "Usage limit reached" } },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "retry reply" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
        ]),
        stderr: "",
        exitCode: 0,
        success: true,
      },
      { agent: "codex", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout).codemux.session_id).toBeNull();
    expect(out.stderr).toContain("Usage limit reached");
  });

  test("a second turn after a completed one is drift: one run is one turn", () => {
    // The round19 finding: the parser accepted multiple sequential
    // completed turns after one thread.started, so a concatenated or
    // malformed stream returned the second run's result while the stream's
    // single announcement named the first run's thread. A turn.started
    // after any turn.completed is refused now, exactly like the second
    // thread.started -- and through codexResult the raw stream is kept and
    // the run fails, so the second turn's reply cannot pose as this run's
    // result.
    const stream = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first run's reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "second run's reply" } },
      { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = codexResult(
      finished(stream),
      { agent: "codex", prompt: "p", resultJson: true }
    );
    expect(out.stdout).toBe(stream);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("any item event after the last turn.completed is drift, not only an agent message", () => {
    // Round23: the ordering rule covered only a trailing agent_message, so
    // a recognized reasoning or tool item completing after turn.completed
    // -- or an item.started/item.updated arriving there -- was accepted
    // and the completed turn's response returned successfully. Items
    // belong inside turns, so every shape is refused as the drift of a
    // concatenated or truncated stream.
    const trailing = (eventType: string, item: object): string =>
      codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
        { type: eventType, item },
      ]);
    expect(parseCodexEventStream(trailing("item.completed", { id: "item_1", type: "reasoning", text: "thinking" }))).toBeNull();
    expect(parseCodexEventStream(trailing("item.completed", { id: "item_1", type: "command_execution", command: "grep -r secret .", aggregated_output: "", exit_code: 0 }))).toBeNull();
    expect(parseCodexEventStream(trailing("item.started", { id: "item_1", type: "reasoning", text: "thinking" }))).toBeNull();
    expect(parseCodexEventStream(trailing("item.updated", { id: "item_1", type: "reasoning", text: "thinking" }))).toBeNull();
    // Inside a turn, the same events are ordinary stream content: the
    // grammar emits item.started/item.updated there, and the reduction
    // keeps reading the message that follows them.
    const inTurn = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_0", type: "reasoning", text: "" } },
      { type: "item.updated", item: { id: "item_0", type: "reasoning", text: "thinking" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(inTurn.finalMessage).toBe("the reply");
    expect(inTurn.turnCompleted).toBe(true);
  });

  test("an empty stream is a parse failure: the grammar opens with thread.started", () => {
    // The round-8 strict grammar: every stream the reduction is documented
    // to read opens with its one thread.started announcement, and "" carries
    // no events at all. Parsing it to a nulls-everywhere stream left the
    // verdict to fail it as a messageless run; now the reduction rejects it
    // like any other drift and codexResult fails it with the raw stdout
    // kept (see the codexResult test below).
    expect(parseCodexEventStream("")).toBeNull();
  });

  test("an item event before the first turn.started is drift, and a pre-turn reroute attributes nothing", () => {
    // Round al34 (edges major 3): the outside-a-turn refusal covered only
    // the stream's tail. An item between thread.started and turn.started
    // was accepted there, so a pre-turn item.completed error -- a reroute
    // notice -- overwrote servedModel onto a run whose turns that model
    // never served. The grammar nests items inside turns, so the head is
    // drift like the tail.
    const preTurn = (eventType: string, item: object): string =>
      codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: eventType, item },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ]);
    expect(parseCodexEventStream(preTurn("item.completed", { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-mini (Unavailable)" }))).toBeNull();
    expect(parseCodexEventStream(preTurn("item.completed", { id: "item_0", type: "reasoning", text: "thinking" }))).toBeNull();
    expect(parseCodexEventStream(preTurn("item.started", { id: "item_0", type: "reasoning", text: "thinking" }))).toBeNull();
    expect(parseCodexEventStream(preTurn("item.updated", { id: "item_0", type: "reasoning", text: "thinking" }))).toBeNull();
    // The reducer's own state pins the attribution half of the finding:
    // the drift freezes the reroute arm before it runs, so servedModel
    // stays null -- the model no turn served reports nothing.
    const reducer = new CodexEventReducer();
    reducer.takeEvent({ type: "thread.started", thread_id: "t" });
    reducer.takeEvent({ type: "item.completed", item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-mini (Unavailable)" } });
    expect(reducer.drift).toContain("outside a turn");
    expect(reducer.drift).toContain("before the first turn.started");
    expect(reducer.servedModel).toBeNull();
    // The same reroute inside the turn is the documented attribution and
    // still parses: the refusal is about position, not the item.
    const inTurn = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-mini (Unavailable)" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(inTurn.servedModel).toBe("gpt-5.3-mini");
    expect(inTurn.finalMessage).toBe("the reply");
  });

  test("a pre-turn completed error item with a plain message is a startup warning, and only that (al35)", () => {
    // Round al35 (correctness major 1): codex reports non-fatal startup
    // warnings as completed `error` items between thread.started and
    // turn.started, and a stream that carries one is a successful run
    // with the warning retained — the al34 head refusal (the test above)
    // dropped the whole stream for it. The carve-out is scoped to the
    // head position AND the warning's own shape: a warning-shaped item
    // after the last turn.completed still drifts (the tail rule the
    // outside-a-turn refusal always was), a non-string message still
    // drifts (nothing to retain), and the reroute notice keeps its own
    // al34 refusal — it is an attribution item, not a warning.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "mcp server telemetry failed to start" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))!;
    expect(stream).not.toBeNull();
    expect(stream.turnCompleted).toBe(true);
    expect(stream.finalMessage).toBe("the reply");
    // The warnings the reduction retained (toStream does not carry them;
    // the reducer's own state is where the al34 test reads its halves
    // too).
    const warningsOf = (events: Record<string, unknown>[]): string[] => {
      const reducer = new CodexEventReducer();
      for (const event of events) reducer.takeEvent(event);
      expect(reducer.drift).toBeNull();
      return reducer.warnings;
    };
    expect(warningsOf([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "mcp server telemetry failed to start" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ])).toEqual(["mcp server telemetry failed to start"]);
    // Two warnings both retain, in arrival order.
    expect(warningsOf([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "first warning" } },
      { type: "item.completed", item: { id: "item_1", type: "error", message: "second warning" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ])).toEqual(["first warning", "second warning"]);
    // The tail: the same item after the last turn.completed drifts — the
    // carve-out ends where the turns do.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      { type: "item.completed", item: { id: "item_1", type: "error", message: "a late warning" } },
    ]))).toBeNull();
    // A non-string message is not a warning shape and keeps the refusal.
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: { code: 7 } } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))).toBeNull();
    // The reroute notice stays refused at the head (al34's own finding:
    // it attributes, so accepting it would vouch a model no turn
    // served).
    expect(parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-mini (Unavailable)" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "the reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]))).toBeNull();
  });

  test("a reroute item names the model that served the run, the last one winning", () => {
    // Codex 0.159.3 reports a rerouted model as a completed `error` item
    // (ModelRerouted in exec_events.rs), message formatted `model rerouted:
    // <from> -> <to> (<reason>)` with the reason Debug-formatted upstream --
    // matched here as one unit, so a reason carrying parentheses (an
    // `Other("...")` say) still parses. A reroute is not a failure: the
    // stream's failure channels are turn.failed and the top-level error
    // event, so the turn completes and the message stands.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-codex (Unavailable)" },
      },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "reply" } },
      {
        type: "item.completed",
        item: { id: "item_2", type: "error", message: "model rerouted: gpt-5.3-codex -> gpt-5.3-mini (Other(\"x -> y\"))" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))!;
    // The last reroute supersedes: an earlier one named a model a later one
    // replaced.
    expect(stream.servedModel).toBe("gpt-5.3-mini");
    expect(stream.failure).toBeNull();
    expect(stream.turnCompleted).toBe(true);
    expect(stream.finalMessage).toBe("reply");
  });

  test("a reroute message outside the documented shape attributes nothing", () => {
    // The format is pinned against 0.159.3, and a message that does not
    // match it is not guessed from: attribution stays null (the request's
    // model shows through in the envelope) rather than half-parsed. An
    // unrecognized error item is not drift the way an agent_message with a
    // non-string text is -- nothing this reduction reports depends on it.
    const stream = parseCodexEventStream(codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        // No parenthetical reason: not the shape the format string builds.
        item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-codex" },
      },
      {
        type: "item.completed",
        item: { id: "item_1", type: "error", message: "something else entirely" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]))!;
    expect(stream).not.toBeNull();
    expect(stream.servedModel).toBeNull();
    expect(stream.failure).toBeNull();
  });
});
