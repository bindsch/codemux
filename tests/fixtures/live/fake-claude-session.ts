/**
 * A scenario-driven fake of the claude-family stream-json harness, built
 * from the shapes pinned by the step-0 fixtures. The e2e tests drive the
 * real driver against this script instead of a recorded transcript, so
 * every round-trip (user lines, control responses, interrupts) is live.
 *
 * Protocol: NDJSON on stdin (the lines codemux sends), stream-json on
 * stdout (the lines the fixtures recorded). The scenario for a turn is
 * selected by the user text's `scenario:<name>` prefix:
 *
 *   basic   — deltas, one assistant message, a successful result
 *   tools   — an Edit tool_use, its tool_result, a message, a result
 *   askedit — an Edit tool_use on the wire, then a can_use_tool for the
 *             same call; the allow/deny arms below report the tool_result,
 *             so a derived file change exists to confirm or drop
 *   write   — a Write tool_use whose target rides the text
 *             (`scenario:write <rel>`), then its successful tool_result;
 *             the driver's stash-time existsSync reads the workspace, so
 *             a pre-existing target derives "edit" and a fresh one "add"
 *   ask     — a can_use_tool request for Bash; the turn continues only
 *             after the control_response, and the tool_result reports
 *             the behavior and any updatedInput it carried
 *   dupask  — two can_use_tool requests under one request id (tier 2,
 *             review live21)
 *   badask  — a can_use_tool with no input object; the driver answers
 *             deny and the turn continues (tier-1, non-fatal)
 *   asklose — a can_use_tool for Bash, then the turn completes by itself
 *             while the decision is still out (review live11)
 *   ctlreq  — a control_request of a subtype codemux does not implement
 *             (`hook_callback`); the turn completes only once it is
 *             answered, the way a real harness blocks on it (review live18)
 *   wait    — one assistant message, then nothing until interrupted
 *   deaf    — like wait, but every interrupt is acknowledged and
 *             ignored, so the turn never completes (review live17)
 *   refuseint — like wait, but the interrupt is answered with the
 *             control protocol's error, and the turn then ends on its
 *             own API-error result (review live22)
 *   nostdin — one assistant message, then stdin is never read again
 *             (the stdin backlog bound, review live19)
 *   race    — one assistant message, then hold; an interrupt during this
 *             turn completes it CLEANLY, as if the result were already
 *             in flight, and the interrupt is spent: the harness has no
 *             turn left to interrupt and drops it (the stale-interrupt
 *             race, reviews live12 and live21)
 *   apierror — an API failure: a result with `is_error` true under
 *             subtype `success`, the way the real wire reports one
 *             (review live20)
 *   ede     — a result with subtype `error_during_execution` and no
 *             interrupt behind it (review live21)
 *   crash   — one assistant message, then exit 1
 *   garbage — a non-JSON line, then nothing (tier-3 fatal)
 *   badinit — a second system/init mid-turn (tier-1 unknown now); the
 *             turn still completes
 *   wrongsession — an event framed with a foreign session id (tier-2)
 *
 * Costs model the real wire (fixture zai-session-a.ndjson): a result's
 * token counts are that turn's own, while total_cost_usd is the running
 * session total — each result reports the counter, which already
 * includes every earlier turn. Results without the field (ask, badask,
 * the default arm) exercise a turn that reports no cost.
 *
 * Everything received (argv, user texts, control responses) is recorded
 * as JSONL under $FAKE_STATE_DIR for the assertions.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-claude-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_VERSION ?? "2.1.280"}\n`);
  process.exit(0);
}

const sessionIdIndex =
  args.indexOf("--session-id") !== -1 ? args.indexOf("--session-id") : args.indexOf("--resume");
const sessionId = sessionIdIndex !== -1 ? args[sessionIdIndex + 1] : "fake-session-id";
record("argv.jsonl", { args, pid: process.pid });
// A `resume-missing` marker in the state dir: `--resume <id>` names a
// transcript that no longer exists (Claude Code deletes old ones after
// cleanupPeriodDays). The real harness (live21 probe, 2026-10-07) sends
// one `result` with no init frame before it — subtype
// error_during_execution, is_error, the reason in `errors` — prints the
// reason on stderr, and exits 1. A marker file, not an env switch: the
// CLI tests pass only the recorded `--pass-env` names, and adding one
// would trip the resume guard.
if (args.includes("--resume") && existsSync(join(stateDir, "resume-missing"))) {
  const reason = `No conversation found with session ID: ${sessionId}`;
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      session_id: sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      errors: [reason],
    })}\n`
  );
  process.stderr.write(`${reason}\n`);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(1);
}
// The endpoint identity the adapter injected (zai's Z.AI mode), for the
// tests that drive one binary under two agents.
record("env.jsonl", {
  anthropic_base_url: process.env.ANTHROPIC_BASE_URL ?? null,
  anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN !== undefined,
  zai_api_key_present: process.env.ZAI_API_KEY !== undefined,
});

// The recorded wire stamps every system/assistant/user/stream_event/result
// frame with the session id (the step-0 fixtures); control frames never
// carry one. write() stamps the five types unless the frame already
// carries an id — the wrongsession scenario's foreign id passes through.
const SESSION_STAMPED_TYPES = new Set([
  "system",
  "assistant",
  "user",
  "stream_event",
  "result",
]);
const write = (value: unknown): void => {
  let frame = value as Record<string, unknown>;
  if (
    frame !== null &&
    typeof frame === "object" &&
    SESSION_STAMPED_TYPES.has(frame["type"] as string) &&
    frame["session_id"] === undefined
  ) {
    frame = { ...frame, session_id: sessionId };
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

// The session-lifetime cost counter, in integer micro-dollars so
// multi-turn totals add exactly (0.01 + 0.005 must be 0.015, not
// 0.015000000000000001). spend() folds one turn's delta in and reports
// the running total the way the real harness does.
let sessionCostMicro = 0;
const spend = (micro: number): number => {
  sessionCostMicro += micro;
  return sessionCostMicro / 1_000_000;
};

let buffer = "";
let pendingAsk: { requestId: string; tool: string; input: Record<string, unknown> } | null = null;
// FAKE_SIGTERM_PERSIST=ask state: the drain-window ask is deliberately
// NOT tracked in pendingAsk — setting it would make the deny branch emit
// a second result for a turn the interrupt is about to complete.
let drainAskPending = false;
let drainInterruptId = "";
// A user line arriving while a turn is still emitting waits for that
// turn's result and then runs as its own turn: the recorded text-only
// case (review live21). The real wire folds the line into the running
// turn instead when that turn makes another model request (fixture
// zai-session-a.ndjson); the fake does not model the fold, because the
// driver never forwards a mid-turn line (`user_during_turn: false`) and
// only the drain-window and pre-init paths can reach this queue.
let turnActive = false;
const inputQueue: string[] = [];
// The scenario of the running turn (set in runUserText), so the
// interrupt handler can race the race scenario's result (below).
let currentScenario = "basic";

const finishTurn = (): void => {
  turnActive = false;
  const next = inputQueue.shift();
  if (next !== undefined) runUserText(next);
};

const emitInterruptedTurn = (requestId: string): void => {
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

const runUserText = (text: string): void => {
  turnActive = true;
  // The real wire emits one system/init per turn, with the same session
  // id every time (the step-0 fixtures): nothing is emitted at spawn, so
  // session_started follows the first user line, not the process start.
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.env.FAKE_CWD ?? process.cwd(),
    tools: ["Bash", "Edit", "Write", "Read"],
  });
  // `--replay-user-messages`: the turn's own line, echoed after its init
  // (fixture zai-session-a.ndjson lines 6-8).
  write({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    isReplay: true,
  });
  const scenario = /^scenario:([a-z0-9-]+)/.exec(text)?.[1] ?? "basic";
  currentScenario = scenario;
  runTurn(scenario, text);
};

const runTurn = (scenario: string, text: string): void => {
  switch (scenario) {
    case "basic":
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
      finishTurn();
      return;
    case "tools": {
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
      finishTurn();
      return;
    }
    case "askedit": {
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
      pendingAsk = { requestId: "toolu_edit_1", tool: "Edit", input: { file_path: filePath, old_string: "a", new_string: "b" } };
      write({
        type: "control_request",
        request_id: "toolu_edit_1",
        request: { subtype: "can_use_tool", tool_name: "Edit", input: pendingAsk.input },
      });
      return;
    }
    case "write": {
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
      finishTurn();
      return;
    }
    case "ask":
      write({
        type: "assistant",
        message: { id: "msg-ask", content: [{ type: "text", text: "I need bash." }], usage: { input_tokens: 8, output_tokens: 2 } },
      });
      pendingAsk = { requestId: "toolu_ask_1", tool: "Bash", input: { command: "echo hi", description: "say hi" } };
      write({
        type: "control_request",
        request_id: "toolu_ask_1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: pendingAsk.input },
      });
      return;
    case "dupask":
      // Two can_use_tool requests under one request id: a grammar
      // violation whose second line must still go out raw (review live21).
      for (const command of ["echo one", "echo two"]) {
        write({
          type: "control_request",
          request_id: "toolu_dup_1",
          request: { subtype: "can_use_tool", tool_name: "Bash", input: { command, description: "dup" } },
        });
      }
      return;
    case "badask":
      // A can_use_tool whose payload cannot be read (no input object):
      // the driver must answer deny keyed by request_id and keep the
      // session alive; the turn continues only after that deny.
      pendingAsk = { requestId: "toolu_bad_1", tool: "Bash", input: {} };
      write({
        type: "control_request",
        request_id: "toolu_bad_1",
        request: { subtype: "can_use_tool", tool_name: "Bash" },
      });
      return;
    case "asklose": {
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
      pendingAsk = { requestId: "toolu_lose_1", tool: "Bash", input: { command: "echo lose", description: "lose" } };
      write({
        type: "control_request",
        request_id: "toolu_lose_1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: pendingAsk.input },
      });
      setTimeout(() => {
        if (!turnActive) return;
        pendingAsk = null;
        write({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: sessionId,
          usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        });
        finishTurn();
      }, 200);
      return;
    }
    case "ctlreq":
      write({
        type: "assistant",
        message: { id: "msg-ctlreq", content: [{ type: "text", text: "Calling a hook." }], usage: { input_tokens: 5, output_tokens: 1 } },
      });
      write({
        type: "control_request",
        request_id: "ctl_1",
        request: { subtype: "hook_callback", callback_id: "hook_0", input: {} },
      });
      return;
    case "wait":
      write({
        type: "assistant",
        message: { id: "msg-wait", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
      });
      return;
    case "refuseint":
      write({
        type: "assistant",
        message: { id: "msg-refuseint", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
      });
      return;
    case "deaf":
      // Like wait, but every interrupt is acknowledged and ignored: the
      // turn never completes (the --turn-timeout cap's shape, live17).
      write({
        type: "assistant",
        message: { id: "msg-deaf", content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 6, output_tokens: 1 } },
      });
      return;
    case "nostdin":
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
      return;
    case "race":
      // Like wait — one message, then hold — but the turn's interrupt
      // completes it cleanly instead (see the interrupt handler), so the
      // interrupt that was already written strikes the next turn.
      write({
        type: "assistant",
        message: { id: "msg-race", content: [{ type: "text", text: "Racing." }], usage: { input_tokens: 6, output_tokens: 1 } },
      });
      return;
    case "apierror":
      write({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        result: "API Error: 529 overloaded",
        session_id: sessionId,
        usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      finishTurn();
      return;
    case "ede":
      // A turn that fails during execution with no interrupt: the
      // interrupted turn's subtype, reached some other way.
      write({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId,
        usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      finishTurn();
      return;
    case "crash":
      write({
        type: "assistant",
        message: { id: "msg-crash", content: [{ type: "text", text: "About to crash." }], usage: { input_tokens: 6, output_tokens: 1 } },
      });
      setTimeout(() => process.exit(1), 100);
      return;
    case "garbage":
      process.stdout.write("this is not json\n");
      return;
    case "badinit":
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
      finishTurn();
      return;
    case "wrongsession":
      write({
        type: "assistant",
        session_id: "00000000-dead-beef-0000-000000000000",
        message: { id: "msg-wrong", content: [{ type: "text", text: "wrong session" }], usage: {} },
      });
      return;
    default:
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      finishTurn();
  }
};

const handleLine = (line: string): void => {
  if (line.trim() === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const event = parsed as Record<string, unknown>;
  if (event["type"] === "user") {
    const message = event["message"] as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.["content"]) ? (message?.["content"] as Record<string, unknown>[]) : [];
    const text = typeof content[0]?.["text"] === "string" ? (content[0]["text"] as string) : "";
    record("input-lines.jsonl", { text });
    if (turnActive) {
      inputQueue.push(text);
      return;
    }
    runUserText(text);
    return;
  }
  if (event["type"] === "control_response") {
    const response = event["response"] as Record<string, unknown> | undefined;
    const inner = response?.["response"] as Record<string, unknown> | undefined;
    record("responses.jsonl", {
      request_id: response?.["request_id"],
      behavior: inner?.["behavior"],
      updatedInput: inner?.["updatedInput"] ?? null,
      message: inner?.["message"] ?? null,
    });
    const behavior = inner?.["behavior"];
    const updated = (inner?.["updatedInput"] ?? undefined) as Record<string, unknown> | undefined;
    if (response?.["subtype"] === "error") {
      record("control-errors.jsonl", { request_id: response["request_id"], error: response["error"] ?? null });
      if (response["request_id"] === "ctl_1" && turnActive && currentScenario === "ctlreq") {
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
    if (drainAskPending && response?.["request_id"] === "toolu_drain_1") {
      // The deny the drain-window ask owed: the tool never runs, and the
      // interrupted turn's frames follow so the drain completes as ever.
      drainAskPending = false;
      emitInterruptedTurn(drainInterruptId);
      return;
    }
    if (pendingAsk !== null && behavior === "allow") {
      const command = typeof updated?.["command"] === "string" ? updated["command"] : pendingAsk.input["command"];
      write({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: pendingAsk.requestId, content: `allowed:${command}`, is_error: false }],
        },
      });
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      pendingAsk = null;
      finishTurn();
      return;
    }
    if (pendingAsk !== null && behavior === "deny") {
      write({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: pendingAsk.requestId, content: "denied", is_error: true }],
        },
      });
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
      pendingAsk = null;
      finishTurn();
    }
    return;
  }
  if (event["type"] === "control_request") {
    const request = event["request"] as Record<string, unknown> | undefined;
    if (request?.["subtype"] === "interrupt") {
      record("interrupts.jsonl", { request_id: event["request_id"] });
      // An interrupt with no open turn (the deny that superseded a
      // pending ask can already have completed it) is acknowledged and
      // nothing else — completing a turn twice would corrupt the stream.
      if (!turnActive || currentScenario === "deaf") {
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
      if (currentScenario === "refuseint") {
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
      if (currentScenario === "race") {
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
        drainAskPending = true;
        drainInterruptId = typeof event["request_id"] === "string" ? event["request_id"] : "";
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
      emitInterruptedTurn(typeof event["request_id"] === "string" ? event["request_id"] : "");
    }
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    handleLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});

// FAKE_SIGTERM_PERSIST=1: survive the shutdown SIGTERM for a moment the
// way the real harness survives it inside the grace window — the
// end-interrupt request arrives on stdin either just before or just
// after the signal, its interrupted-turn frames (control_response, the
// user message, the result with its usage) go back while the pipes are
// still open, and only then does the process exit — with code 1, the
// real claude convention for a turn interrupted at shutdown (step-0
// probe 4: the interrupt round-trip ends in result
// error_during_execution, is_error true, exit 1). The live9 rule reads
// that as success, because the completion was delivered.
// =garbage additionally writes one non-JSON line before dying — a
// harness emitting unusable output inside the grace window, which the
// live7 regression pins as costing success rather than being absorbed by
// the already-running end path. =ask survives the same way but, on the
// end-interrupt itself, first surfaces a can_use_tool that lands inside
// the drain window (see the interrupt branch) and completes the
// interrupted turn only after its answer — the live8 regression's shape.
// =exit2 answers like =1 but exits 2: a harness that answered the
// end-interrupt and then failed while persisting (review live18 — only
// exit 1 after an interrupted turn is the convention).
// =exit42 answers nothing: the turn stays open and the process exits 42
// — a harness failing while persisting during the shutdown, the live9
// shape whose cost the driver must report (exit 1, not 0). =exit143 is
// the same silence with exit code 143 — a wrapper answering the SIGTERM
// with an exit code instead of dying by signal (the scode spelling),
// which must NOT be read as the live9 failure (review live11). Without
// the env the default SIGTERM disposition applies (die at once), the
// pre-fix behavior every other test relies on.
const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (
  persistMode === "1" ||
  persistMode === "exit2" ||
  persistMode === "garbage" ||
  persistMode === "ask" ||
  persistMode === "exit42" ||
  persistMode === "exit143"
) {
  process.on("SIGTERM", () => {
    if (persistMode === "garbage") {
      process.stdout.write("this line is not json\n");
    }
    setTimeout(
      () =>
        process.exit(
          persistMode === "exit42"
            ? 42
            : persistMode === "exit143"
              ? 143
              : persistMode === "exit2"
                ? 2
                : 1
        ),
      300
    );
  });
}
