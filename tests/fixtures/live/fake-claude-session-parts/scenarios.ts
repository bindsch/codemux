/**
 * The per-scenario turn bodies of the claude-family fake, one function
 * per switch arm; tests/fixtures/live/fake-claude-session.ts owns the
 * scenario switch. The entry's finishTurn is injected because it drains
 * the input queue back into the entry's own dispatch.
 */
import { join } from "node:path";
import { sessionId, spend, state, write } from "./wire.js";

/** What the scenario bodies need from the entry: the turn-end drain. */
export interface ScenarioDeps {
  finishTurn: () => void;
}

export const makeScenarioHandlers = (deps: ScenarioDeps) => ({
  basic: (): void => {
    write({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    });
    write({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    });
    write({
      type: "stream_event",
      event: { type: "message_stop" },
    });
    write({
      type: "assistant",
      message: { id: "msg-basic", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 10, output_tokens: 4 } },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      total_cost_usd: spend(10000),
    });
    deps.finishTurn();
  },

  tools: (text: string): void => {
    const filePath = join(process.env.FAKE_CWD ?? process.cwd(), "file.txt");
    write({
      type: "assistant",
      message: {
        id: "msg-tools",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: filePath, old_string: "a", new_string: "b" } },
        ],
      },
    });
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "The file was edited.", is_error: false }],
      },
    });
    write({
      type: "assistant",
      message: { id: "msg-tools-2", content: [{ type: "text", text: `Edited ${text}` }], usage: { input_tokens: 12, output_tokens: 3 } },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: spend(5000),
    });
    deps.finishTurn();
  },

  askedit: (): void => {
    const filePath = join(process.env.FAKE_CWD ?? process.cwd(), "file.txt");
    write({
      type: "assistant",
      message: {
        id: "msg-askedit",
        content: [
          { type: "tool_use", id: "toolu_edit_1", name: "Edit", input: { file_path: filePath, old_string: "a", new_string: "b" } },
        ],
      },
    });
    state.pendingAsk = { requestId: "toolu_edit_1", tool: "Edit", input: { file_path: filePath, old_string: "a", new_string: "b" } };
    write({
      type: "control_request",
      request_id: "toolu_edit_1",
      request: { subtype: "can_use_tool", tool_name: "Edit", input: state.pendingAsk.input },
    });
  },

  write: (text: string): void => {
    // `scenario:write <rel>` names the target; a `rel:`-prefixed target
    // rides the tool_use verbatim (a relative file_path, the spelling
    // whose add/edit split must resolve against the session cwd, not
    // codemux's own — review live15).
    const rel = text.slice("scenario:write".length).trim() || "made.txt";
    const filePath = rel.startsWith("rel:")
      ? rel.slice("rel:".length)
      : join(process.env.FAKE_CWD ?? process.cwd(), rel);
    write({
      type: "assistant",
      message: {
        id: "msg-write",
        content: [
          { type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: filePath, content: "x" } },
        ],
      },
    });
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_w1", content: `Wrote ${filePath}`, is_error: false }],
      },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    deps.finishTurn();
  },

  lostwrite: (): void => {
    // A Write tool_use whose tool_result never arrives: the result frame
    // ends the turn with the call unanswered. The candidate must die with
    // the turn — the LATEWRITE scenario reuses the call id in the next
    // turn and reports the result then, which must derive nothing (review
    // round 259).
    const filePath = join(process.env.FAKE_CWD ?? process.cwd(), "lost.txt");
    write({
      type: "assistant",
      message: {
        id: "msg-lostwrite",
        content: [
          { type: "tool_use", id: "toolu_lw_1", name: "Write", input: { file_path: filePath, content: "x" } },
        ],
      },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    deps.finishTurn();
  },

  latewrite: (): void => {
    // The delayed tool_result for the call the PREVIOUS turn made
    // (lostwrite), under the same call id a harness could reuse: with the
    // candidate cleared at turn completion this confirms nothing; before
    // round 259 it emitted a file_change outside its originating turn.
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_lw_1", content: "Wrote (late)", is_error: false }],
      },
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 6, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    deps.finishTurn();
  },

  ask: (): void => {
    write({
      type: "assistant",
      message: { id: "msg-ask", content: [{ type: "text", text: "I need bash." }], usage: { input_tokens: 8, output_tokens: 2 } },
    });
    state.pendingAsk = { requestId: "toolu_ask_1", tool: "Bash", input: { command: "echo hi", description: "say hi" } };
    write({
      type: "control_request",
      request_id: "toolu_ask_1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: state.pendingAsk.input },
    });
  },

  dupask: (): void => {
    // Two can_use_tool requests under one request id: a grammar
    // violation whose second line must still go out raw (review live21).
    for (const command of ["echo one", "echo two"]) {
      write({
        type: "control_request",
        request_id: "toolu_dup_1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command, description: "dup" } },
      });
    }
  },

  badask: (): void => {
    // A can_use_tool whose payload cannot be read (no input object):
    // the driver must answer deny keyed by request_id and keep the
    // session alive; the turn continues only after that deny.
    state.pendingAsk = { requestId: "toolu_bad_1", tool: "Bash", input: {} };
    write({
      type: "control_request",
      request_id: "toolu_bad_1",
      request: { subtype: "can_use_tool", tool_name: "Bash" },
    });
  },

  asklose: (): void => {
    // A can_use_tool surfaces, then the harness completes the turn by
    // itself while the decision is still out: the driver must supersede
    // the pending request rather than leave it pending (review live11,
    // the codex sibling's finding). pendingAsk is cleared before the
    // result so the supersede's deny answer (which arrives after)
    // matches no open ask and emits nothing — the turn is already over.
    write({
      type: "assistant",
      message: { id: "msg-asklose", content: [{ type: "text", text: "Asking." }], usage: { input_tokens: 8, output_tokens: 2 } },
    });
    state.pendingAsk = { requestId: "toolu_lose_1", tool: "Bash", input: { command: "echo lose", description: "lose" } };
    write({
      type: "control_request",
      request_id: "toolu_lose_1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: state.pendingAsk.input },
    });
    setTimeout(() => {
      if (!state.turnActive) return;
      state.pendingAsk = null;
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      deps.finishTurn();
    }, 200);
  },

  ctlreq: (): void => {
    write({
      type: "assistant",
      message: { id: "msg-ctlreq", content: [{ type: "text", text: "Calling a hook." }], usage: { input_tokens: 5, output_tokens: 1 } },
    });
    write({
      type: "control_request",
      request_id: "ctl_1",
      request: { subtype: "hook_callback", callback_id: "hook_0", input: {} },
    });
  },

  wait: (): void => {
    write({
      type: "assistant",
      message: { id: "msg-wait", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
    });
  },

  refuseint: (): void => {
    write({
      type: "assistant",
      message: { id: "msg-refuseint", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
    });
  },

  deaf: (): void => {
    // Like wait, but every interrupt is acknowledged and ignored: the
    // turn never completes (the --turn-timeout cap's shape, live17).
    write({
      type: "assistant",
      message: { id: "msg-deaf", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
    });
  },

  nostdin: (): void => {
    // One message, then stop reading stdin for good: whatever codemux
    // writes next stays unread (the stdin backlog bound, review live19).
    write({
      type: "assistant",
      message: { id: "msg-nostdin", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
    });
    process.stdin.pause();
    // A paused stdin no longer keeps the event loop alive; hold until
    // codemux ends the session.
    setInterval(() => {}, 60_000);
  },

  race: (): void => {
    // Like wait — one message, then hold — but the turn's interrupt
    // completes it cleanly instead (see the interrupt handler), so the
    // interrupt that was already written strikes the next turn.
    write({
      type: "assistant",
      message: { id: "msg-race", content: [{ type: "text", text: "Racing." }], usage: { input_tokens: 6, output_tokens: 1 } },
    });
  },

  apierror: (): void => {
    write({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 529,
      result: "API Error: 529 overloaded",
      session_id: sessionId,
      usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    deps.finishTurn();
  },

  ede: (): void => {
    // A turn that fails during execution with no interrupt: the
    // interrupted turn's subtype, reached some other way.
    write({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: sessionId,
      usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    deps.finishTurn();
  },

  crash: (): void => {
    write({
      type: "assistant",
      message: { id: "msg-crash", content: [{ type: "text", text: "About to crash." }], usage: { input_tokens: 6, output_tokens: 1 } },
    });
    setTimeout(() => process.exit(1), 100);
  },

  garbage: (): void => {
    process.stdout.write("this is not json\n");
  },

  badinit: (): void => {
    // The per-turn init already ran in runUserText, so this is the
    // second one; the turn then completes normally.
    write({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash"] });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: spend(2000),
    });
    deps.finishTurn();
  },

  wrongsession: (): void => {
    write({
      type: "assistant",
      session_id: "00000000-dead-beef-0000-000000000000",
      message: { id: "msg-wrong", content: [{ type: "text", text: "wrong session" }], usage: {} },
    });
  },

  defaultArm: (): void => {
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    deps.finishTurn();
  },
});
