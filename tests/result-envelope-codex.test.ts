import { describe, expect, test } from "bun:test";
import {
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  codexResult,
  emptyUsage,
  parseCodexEventStream,
} from "../src/result-envelope.js";
import type { RunRequest } from "../src/types.js";
import {
  CODEX_EVENTS,
  finished,
  codexStream,
} from "./helpers/result-envelope.js";

describe("codexResult", () => {
  const request: RunRequest = { agent: "codex", prompt: "p", resultJson: true };

  test("builds the envelope codemux promised: result text plus the block", () => {
    const out = codexResult(finished(CODEX_EVENTS), request);
    const envelope = JSON.parse(out.stdout);
    expect(Object.keys(envelope).sort()).toEqual(["codemux", "result"]);
    expect(envelope.result).toBe("final message");
    expect(envelope.codemux).toEqual({
      agent: "codex",
      model: null,
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cached_input_tokens: 800,
        total_tokens: 1050,
        cost_usd: null,
      },
      // The run launched with --ephemeral: the stream names a thread id,
      // but no later run can resume it, so it is not reported as though
      // one could.
      session_id: null,
      recording: null,
      labels: null,
    });
  });

  test("carries the selected model when the stream names none", () => {
    const out = codexResult(finished(CODEX_EVENTS), { ...request, model: "gpt-5.3-codex" });
    expect(JSON.parse(out.stdout).codemux.model).toBe("gpt-5.3-codex");
  });

  test("a rerouted run is attributed to the model that served it", () => {
    // The finding: the parser discarded the reroute item, so a run the
    // harness served with a different model reported the requested one (or
    // null) despite codex naming the served model in the stream. The
    // envelope's model is the served model now, and a stderr note says the
    // run was rerouted, so an operator who selected gpt-5.3 does not read
    // the reply as though gpt-5.3 wrote it.
    const rerouted = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "model rerouted: gpt-5.3 -> gpt-5.3-codex (Unavailable)" },
      },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]);
    const out = codexResult(finished(rerouted), { ...request, model: "gpt-5.3" });
    const envelope = JSON.parse(out.stdout);
    expect(out.success).toBe(true);
    expect(envelope.result).toBe("reply");
    expect(envelope.codemux.model).toBe("gpt-5.3-codex");
    expect(out.stderr).toContain("rerouted");
    expect(out.stderr).toContain("served by gpt-5.3-codex");
    expect(out.stderr).toContain("not the requested gpt-5.3");
  });

  test("an unparseable stream keeps the raw stdout and fails the run", () => {
    // The documented contract (README, CHANGELOG) keeps the raw stdout for
    // inspection when the JSON promise breaks; the envelope path used to
    // overwrite it with a null-only envelope, so the bytes appeared
    // nowhere. No envelope is emitted, like the Claude-family path.
    const out = codexResult(finished("human-mode text\n"), request);
    expect(out.stdout).toBe("human-mode text\n");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a truncated stream from a zero-exit wrapper fails, not poses as done", () => {
    // The finding's reproduction: a wrapper like `codex-real "$@" | sed
    // '$d'` drops the final event yet exits 0. Item completion is not turn
    // completion (exec_events.rs), so an agent_message item alone used to
    // pass as the result.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "commentary" } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("turn.completed");
  });

  test("an empty stream with codex's exit 0 is a parse failure, not a null envelope", () => {
    // No events at all is not the event stream the launch asked for; before
    // strict parsing it built a successful-looking envelope with nulls
    // everywhere. Now the raw (empty) stdout stays and no envelope is
    // emitted, like any other drift.
    const out = codexResult(finished(""), request);
    expect(out.stdout).toBe("");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a turn with no agent message reports result null", () => {
    const out = codexResult(
      finished(codexStream([{ type: "thread.started", thread_id: "t" }])),
      request
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
  });

  test("a stream that ends without a final assistant message fails the run", () => {
    // A turn may complete without an agent_message item (an interrupted
    // turn keeps no final message either); the run still needs a result.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("without a final assistant message");
  });

  test("a failed turn fails the run on every channel", () => {
    // The finding's reproduction: a usage-limit turn.failed with codex's
    // own exit 0 produced empty stderr under --result-json. Now the exit
    // is forced non-zero, the partial message is not the result, and the
    // diagnostic rides on stderr.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
        { type: "turn.failed", error: { message: "Usage limit reached" } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("Usage limit reached");
  });

  test("a failed envelope carries null usage even from a complete stream", () => {
    // Round23: a complete event stream paired with codex's own non-zero
    // exit correctly failed the run, but the envelope still carried the
    // stream's snapshot as exact usage. A failed run reports null fields
    // on every channel -- an exact-looking total for a run whose end the
    // harness itself called failed is worse than none.
    const out = codexResult(
      { stdout: CODEX_EVENTS, stderr: "", exitCode: 1, success: false },
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.usage).toEqual(emptyUsage());
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
  });

  test("a failed run's envelope carries null usage, not the last snapshot", () => {
    // Round17: a completed turn's cumulative figure used to survive the
    // failure as exact usage for a run that failed past it. The verdict
    // fails the run, so the usage fields are null -- incomplete totals are
    // not presented as exact.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "Usage limit reached" } },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first" } },
        { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.codemux.usage).toEqual(emptyUsage());
    expect(out.success).toBe(false);
  });

  test("a whitespace-only final message is no message", () => {
    // Round17: the verdict rejected only the empty string, so a completed
    // turn whose one agent_message carried spaces and newlines passed as a
    // successful run with a whitespace result -- the same gap the Claude
    // envelope path had for `result: " \\n"`.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: " \n" } },
        { type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request
    );
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("without a final assistant message");
  });

  test("an agent message after the last turn.completed is drift, not a result", () => {
    // The round6 finding: an item.completed arriving after turn.completed
    // replaced the final message with no turn reopened, so a truncated or
    // concatenated stream could return its trailing uncompleted message as
    // a successful result. The reduction now refuses the stream outright.
    const stream = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "completed turn's message" },
      },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      // Drift: no turn.started reopened a turn, yet an agent message
      // completes -- the shape a wrapper concatenating two streams makes.
      {
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "trailing uncompleted message" },
      },
    ]);
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = codexResult(finished(stream), request);
    // Fail closed with the raw stream kept verbatim, like any other drift.
    expect(out.stdout).toBe(stream);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("two concatenated complete streams fail closed, raw stdout kept", () => {
    // The round7 finding: the second thread.started was silently ignored,
    // so a wrapper concatenating two valid streams could pair run two's
    // final message with run one's thread. The reduction refuses the
    // concatenation at the second announcement.
    const oneRun = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "run one reply" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    const concatenated = `${oneRun}${oneRun}`;
    expect(parseCodexEventStream(concatenated)).toBeNull();
    const out = codexResult(finished(concatenated), request);
    expect(out.stdout).toBe(concatenated);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("cannot parse");
  });

  test("a plan-only turn succeeds through the recorded final message", () => {
    // The finding's reproduction: codex 0.159.3 ends some successful turns
    // with a Plan item and no agent_message, and its JSONL mapper drops the
    // item, so the stream alone made a valid completed run exit 1. The final
    // message codex itself records (--output-last-message) is the result,
    // with the note saying where it came from.
    const planOnly = codexStream([
      { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    const out = codexResult(
      finished(planOnly),
      request,
      "1. Inspect the tree.\n2. Plan the change."
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe("1. Inspect the tree.\n2. Plan the change.");
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.success).toBe(true);
    expect(out.stderr).toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("a plan-only turn with nothing recorded still fails", () => {
    // The fallback is a supplement, not a bypass: codex wrote no final
    // message anywhere, so there is no result to report.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request,
      null
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("the recorded message does not displace the stream's own", () => {
    // The stream is the documented source; the file only supplies what the
    // mapper drops, so a stream that carries its own agent_message stands
    // and no note is added.
    const out = codexResult(finished(CODEX_EVENTS), request, "recorded but unused");
    expect(JSON.parse(out.stdout).result).toBe("final message");
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("the recorded message does not rescue a failed turn", () => {
    // Upstream itself discards the final message on TurnStatus::Failed, so
    // a file written anyway (or planted) cannot turn the failure into a
    // result.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "turn.failed", error: { message: "Usage limit reached" } },
      ])),
      request,
      "planted after the failure"
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("Usage limit reached");
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("an agent_message with malformed text is drift, not an item to skip", () => {
    // Round10: a recognized agent_message whose text was not a string was
    // silently ignored, so a nonempty --output-last-message fallback could
    // pass the malformed stream off as a successful Plan-only run. The
    // stream is the documented source; one it cannot carry fails closed.
    const malformed = codexStream([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: 42 } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
    ]);
    expect(parseCodexEventStream(malformed)).toBeNull();
    const out = codexResult(finished(malformed), request, "1. a plan");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stdout).toBe(malformed);
    expect(out.stderr).toContain("cannot parse");
    expect(out.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
  });

  test("an empty agent message is no message, and a recorded one does not paper over it", () => {
    // Round10: the verdict required a final message but accepted the empty
    // one, so a completed turn whose only agent_message carried empty text
    // passed as a successful run with result "" -- the codex half of the
    // empty-response finding. result null, exit 1.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request,
      "planted over the empty message"
    );
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("without a final assistant message");
  });

  test("a completed turn whose named fallback file is missing fails naming the file (al29)", () => {
    // The al29 contracts minor's own arm, pinned here so the al30 gate
    // below has its contrast: a messageless stream whose turn completed,
    // a run clean, and the --output-last-message file the launch named
    // not there — upstream writes one for every completed turn, so the
    // write codex only logged never happened, and the caller learns
    // that, not a generic "no result".
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 } },
      ])),
      request,
      { missing: "/tmp/codemux-last-message-al29" }
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("--output-last-message");
    expect(out.stderr).toContain("/tmp/codemux-last-message-al29");
    expect(out.stderr).toContain("is missing");
  });

  test("a truncated stream never reaches the missing-file arm: the turn never finished (al30)", () => {
    // Round al30, rule 4 (edges minor): the missing-fallback override
    // required only a clean run and a messageless stream, so a stream
    // cut after turn.started — no turn.completed, nothing upstream could
    // have written — blamed the absent file for a turn that never
    // reached its end. The override now requires stream.turnCompleted:
    // the truncated stream keeps the truncation verdict, and the
    // missing-file note never fires.
    const out = codexResult(
      finished(codexStream([
        { type: "thread.started", thread_id: "t" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "partial" } },
      ])),
      request,
      { missing: "/tmp/codemux-last-message-al30" }
    );
    expect(JSON.parse(out.stdout).result).toBeNull();
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("turn.completed");
    expect(out.stderr).toContain("the turn never finished");
    expect(out.stderr).not.toContain("--output-last-message");
    expect(out.stderr).not.toContain("/tmp/codemux-last-message-al30");
  });
});
