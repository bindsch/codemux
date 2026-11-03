/**
 * The control-frame handlers (control_response decisions and the
 * interrupt control_request) for the claude-family fake;
 * tests/fixtures/live/fake-claude-session.ts owns the dispatch and passes
 * its finishTurn in, because that drain lives on the entry's own queue.
 */
import { record, sessionId, spend, state, write } from "./wire.js";

const emitInterruptedTurn = (requestId: string, finishTurn: () => void): void => {
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { still_queued: [] } },
  });
  write({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  });
  write({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: sessionId,
    usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: spend(1000),
  });
  finishTurn();
};

export const handleControlResponse = (event: Record<string, unknown>, finishTurn: () => void): void => {
  const response = event["response"] as Record<string, unknown> | undefined;
  const inner = response?.["response"] as Record<string, unknown> | undefined;
  record("responses.jsonl", {
    request_id: response?.["request_id"],
    behavior: inner?.["behavior"],
    updatedInput: inner?.["updatedInput"] ?? null,
    message: inner?.["message"] ?? null,
  });
  const behavior = inner?.["behavior"];
  // The denial message, which the real harness shows the model as the
  // failing tool result's text — echoed there below so tests can pin
  // what the agent actually saw.
  const denialMessage = typeof inner?.["message"] === "string" ? inner["message"] : null;
  const updated = (inner?.["updatedInput"] ?? undefined) as Record<string, unknown> | undefined;
  if (response?.["subtype"] === "error") {
    record("control-errors.jsonl", { request_id: response["request_id"], error: response["error"] ?? null });
    if (response["request_id"] === "ctl_1" && state.turnActive && state.currentScenario === "ctlreq") {
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      finishTurn();
    }
    return;
  }
  if (state.drainAskPending && response?.["request_id"] === "toolu_drain_1") {
    // The deny the drain-window ask owed: the tool never runs, and the
    // interrupted turn's frames follow so the drain completes as ever.
    state.drainAskPending = false;
    emitInterruptedTurn(state.drainInterruptId, finishTurn);
    return;
  }
  if (state.pendingAsk !== null && behavior === "allow") {
    const command = typeof updated?.["command"] === "string" ? updated["command"] : state.pendingAsk.input["command"];
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: state.pendingAsk.requestId, content: `allowed:${command}`, is_error: false }],
      },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    state.pendingAsk = null;
    finishTurn();
    return;
  }
  if (state.pendingAsk !== null && behavior === "deny") {
    write({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: state.pendingAsk.requestId,
            content: denialMessage ?? "denied",
            is_error: true,
          },
        ],
      },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    state.pendingAsk = null;
    finishTurn();
  }
};

export const handleControlRequest = (event: Record<string, unknown>, finishTurn: () => void): void => {
  const request = event["request"] as Record<string, unknown> | undefined;
  if (request?.["subtype"] === "interrupt") {
    record("interrupts.jsonl", { request_id: event["request_id"] });
    // An interrupt with no open turn (the deny that superseded a
    // pending ask can already have completed it) is acknowledged and
    // nothing else — completing a turn twice would corrupt the stream.
    if (!state.turnActive || state.currentScenario === "deaf") {
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: event["request_id"],
          response: { still_queued: [] },
        },
      });
      return;
    }
    if (state.currentScenario === "refuseint") {
      write({
        type: "control_response",
        response: { subtype: "error", request_id: event["request_id"], error: "cannot interrupt now" },
      });
      write({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        result: "API Error: 529 overloaded",
        session_id: sessionId,
        usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      finishTurn();
      return;
    }
    if (state.currentScenario === "race") {
      // The stale-interrupt race (review live12): the result for this
      // turn was already on its way when the interrupt was written, so
      // the turn completes CLEANLY — the interrupt does not touch it,
      // and with no turn left to interrupt it is dropped (review
      // live21: no later turn can be waiting harness-side).
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      finishTurn();
      return;
    }
    if (process.env.FAKE_SIGTERM_PERSIST === "ask") {
      // The end-interrupt arrives after codemux's finish() began (the
      // driver writes it inside the end path), so a can_use_tool the
      // harness still had in flight surfaces HERE — inside the shutdown
      // drain, after finish() denied everything it found pending.
      // Emit it and hold the interrupted-turn frames until the answer
      // comes back; the live8 regression pins that the driver denies
      // this one rather than leaving it pending forever.
      state.drainAskPending = true;
      state.drainInterruptId = typeof event["request_id"] === "string" ? event["request_id"] : "";
      write({
        type: "control_request",
        request_id: "toolu_drain_1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo drain", description: "asked during the drain" },
        },
      });
      return;
    }
    if (
      process.env.FAKE_SIGTERM_PERSIST === "exit42" ||
      process.env.FAKE_SIGTERM_PERSIST === "exit143"
    ) {
      // The harness dies without ever answering the end-interrupt: the
      // turn stays open and the process exits nonzero inside the grace
      // window. 42 is the live9 shape the driver must report as a
      // failure; 143 is the wrapper answering the SIGTERM with an exit
      // code (the scode spelling), which must NOT be read as one
      // (review live11). The interrupt above is recorded either way, so
      // the test can pin that it was received and left unanswered.
      return;
    }
    emitInterruptedTurn(typeof event["request_id"] === "string" ? event["request_id"] : "", finishTurn);
  }
};
