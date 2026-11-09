/**
 * The JSON-RPC request handlers (initialize, thread start/resume, steer,
 * interrupt) and the decision-response handling for the codex app-server
 * fake; tests/fixtures/live/fake-codex-app-server.ts owns the dispatch.
 */
import { join } from "node:path";
import { FAKE_CWD, THREAD_ID, notify, record, respond, respondError, state, stateDir } from "./wire.js";
import { agentMessageCompleted, askApproval, completeTurn, itemParams, usage } from "./items.js";

export const startThread = (id: unknown, announce: boolean): void => {
  if (process.env.FAKE_ANNOUNCE_OTHER_THREAD === "1" && announce) {
    // Review live15: the notification names a DIFFERENT id first — the
    // driver adopts and announces it — and the thread/start response then
    // contradicts it. One session cannot run under two ids: the mismatch
    // must fail closed naming both.
    notify("thread/started", { thread: { id: "99999999-8888-7777-6666-555555555555" } });
    respond(id, { thread: { id: THREAD_ID }, model: "gpt-fake" });
    return;
  }
  // FAKE_RESUME_WRONG_THREAD=1: a thread/resume answered with a
  // DIFFERENT thread id than the one requested — a server that resumed
  // into another thread. No thread/started follows (the real server
  // does not send one on resume), so the wrong id rides the response
  // alone and the driver must reject it (review live12).
  const answeredId =
    !announce && process.env.FAKE_RESUME_WRONG_THREAD === "1"
      ? "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb"
      : THREAD_ID;
  respond(id, { thread: { id: answeredId }, model: "gpt-fake" });
  // A fresh thread/start is followed by thread/started — the shape the
  // recorded fixture pins. thread/resume is NOT: the reference clients
  // of the same app-server validate the response's thread.id and never
  // wait for a notification there (review live11's resume probe).
  // FAKE_RESUME_ANNOUNCES=1 models the opposite server for the benign
  // late-notification passthrough test.
  if (announce || process.env.FAKE_RESUME_ANNOUNCES === "1") {
    notify("thread/started", { thread: { id: THREAD_ID } });
  }
};

export const handleInitialize = (id: unknown): void => {
  if (process.env.FAKE_STALL_INIT === "1") {
    // Recorded above, never answered: the handshake stalls.
    return;
  }
  if (
    process.env.FAKE_STALL_INIT === "release" ||
    process.env.FAKE_STALL_INIT === "rejectrelease"
  ) {
    // Recorded above, held: the shutdown SIGTERM answers it (the
    // handler at the bottom), so the response lands inside codemux's
    // drain window (review live15).
    state.heldInitId = id;
    return;
  }
  respond(
    // FAKE_STRING_ID_RESPONSE: echo the id as a string — a reply no
    // numbered request ever made (review live15).
    process.env.FAKE_STRING_ID_RESPONSE === "1" ? String(id) : id,
    {
      userAgent: `codemux-fake/0.159.3 (${process.platform}; ${process.arch})`,
      codexHome: process.env.FAKE_CODEX_HOME ?? `${stateDir}/codex-home`,
      platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : "linux",
    }
  );
};

export const handleSteer = (id: unknown, params: Record<string, unknown>): void => {
  if (state.currentScenario === "refusesteer") {
    record("steers.jsonl", { expectedTurnId: params["expectedTurnId"], refused: true });
    respondError(id, "the turn already completed");
    return;
  }
  respond(id, {});
  const input = Array.isArray(params["input"]) ? (params["input"] as Record<string, unknown>[]) : [];
  for (const piece of input) {
    if (typeof piece["text"] === "string") state.steeredTexts.push(piece["text"] as string);
  }
  record("steers.jsonl", { expectedTurnId: params["expectedTurnId"], texts: [...state.steeredTexts] });
  if (state.currentTurn !== null && (state.currentScenario === "steer" || state.currentScenario === "wait")) {
    agentMessageCompleted(state.currentTurn, "msg-steer", `Steered: ${state.steeredTexts.join(" | ")}`);
    completeTurn(state.currentTurn, "completed");
  }
};

export const handleInterrupt = (id: unknown, params: Record<string, unknown>): void => {
  record("interrupts.jsonl", { turnId: params["turnId"] });
  if (state.currentScenario === "refusehold") {
    respondError(id, "the turn cannot be interrupted");
    return;
  }
  if (state.currentScenario === "refuseinterrupt") {
    // The rejection the driver must survive: the interrupt did not
    // happen, and the turn's own completion is the truth of it.
    respondError(id, "the turn cannot be interrupted");
    if (state.currentTurn !== null) {
      const turnId = state.currentTurn;
      state.pendingApproval = null;
      agentMessageCompleted(turnId, "msg-refuse", "Refused and finished.");
      completeTurn(turnId, "completed");
    }
    return;
  }
  if (state.currentScenario === "deaf" || state.currentScenario === "usagewait") {
    // Accepted and ignored: the turn stays open (review live17).
    respond(id, {});
    return;
  }
  if (state.currentScenario === "failoninterrupt") {
    // The interrupt is accepted, and the turn completes FAILED with
    // an error message: the harness's own failure must outrank the
    // driver's interrupt label (review live11).
    respond(id, {});
    if (state.currentTurn !== null) {
      const turnId = state.currentTurn;
      state.pendingApproval = null;
      agentMessageCompleted(turnId, "msg-failint", "Failing.", "commentary");
      completeTurn(turnId, "failed", { message: "rate limit exceeded" });
    }
    return;
  }
  if (state.currentScenario === "latecomplete") {
    // Hold the response: the turn completes cleanly on its own
    // (the driver sees a "completed" wire status while its own
    // interrupt is still in flight — a --turn-timeout's or a
    // caller's), and the interrupt is only then rejected, too late
    // to change what the turn already said (review live14).
    const heldId = id;
    setTimeout(() => {
      if (state.currentTurn !== null) {
        const turnId = state.currentTurn;
        state.pendingApproval = null;
        agentMessageCompleted(turnId, "msg-late", "Finished anyway.");
        completeTurn(turnId, "completed");
      }
      respondError(heldId, "the turn is no longer running");
    }, 150);
    return;
  }
  if (state.currentScenario === "staleinterrupt") {
    // Hold the response: the turn completes on its own (the driver
    // sees its own interrupted completion with the interrupt still
    // pending), and the rejection is flushed only by the NEXT
    // interrupt request — the stale rejection the driver must not
    // let clear that next turn's interrupt state (review live11).
    state.staleInterruptId = typeof id === "string" || typeof id === "number" ? id : undefined;
    setTimeout(() => {
      if (state.currentTurn !== null) {
        const turnId = state.currentTurn;
        state.pendingApproval = null;
        completeTurn(turnId, "interrupted");
      }
    }, 150);
    return;
  }
  if (state.staleInterruptId !== undefined) {
    // A later interrupt arrived: flush the stale rejection first,
    // then answer this one normally.
    respondError(state.staleInterruptId, "the turn cannot be interrupted");
    state.staleInterruptId = undefined;
  }
  if (process.env.FAKE_SIGTERM_PERSIST === "ask" && state.currentTurn !== null) {
    // The end-interrupt arrives after codemux's finish() began
    // (the driver writes it inside the end path), so an approval
    // the app-server still had in flight surfaces HERE — inside
    // the shutdown drain, after finish() declined everything it
    // found pending. Ask it and hold the interrupt response plus
    // the turn completion until the decision comes back; the
    // live8 regression pins that the driver declines this one
    // rather than leaving it pending forever. The turn must stay
    // open while the approval is out (the classifier requires the
    // turn id to match the driver's open harness turn).
    state.drainApprovalPending = true;
    state.heldInterruptId = typeof id === "string" || typeof id === "number" ? id : undefined;
    const turnId = state.currentTurn;
    askApproval(turnId, "appr-drain", "cmd-drain", "echo drain");
    return;
  }
  if (
    process.env.FAKE_SIGTERM_PERSIST === "exit42" ||
    process.env.FAKE_SIGTERM_PERSIST === "exit143"
  ) {
    // The app-server dies without ever answering the end-interrupt:
    // the turn stays open and the process exits nonzero inside the
    // grace window. 42 is the live9 shape the driver must report as
    // a failure; 143 is the wrapper answering the SIGTERM with an
    // exit code (the scode spelling), which must NOT be read as one.
    // The interrupt above is recorded either way, so the test can
    // pin that it was received and left unanswered.
    return;
  }
  respond(id, {});
  if (state.currentTurn !== null) {
    const turnId = state.currentTurn;
    state.pendingApproval = null;
    // Under FAKE_SIGTERM_PERSIST the interrupt lands inside the
    // shutdown grace window; a last usage update rides the
    // completion so the drain tests can pin that it is folded.
    if (process.env.FAKE_SIGTERM_PERSIST === "1") {
      notify("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId,
        tokenUsage: { total: usage(14, 0, 0, 2), last: usage(14, 0, 0, 2), modelContextWindow: 258400 },
      });
    }
    completeTurn(turnId, "interrupted");
    if (process.env.FAKE_HOLD_TURNSTART === "1") {
      // The held turn/start was released by the shutdown SIGTERM
      // and the buffered end-interrupt completed the turn inside
      // the drain; exit cleanly once the completion is on the
      // wire (the grace window's SIGKILL is the backstop).
      setTimeout(() => process.exit(0), 50);
    }
  }
};

/** Resume the turn an approval froze, once its decision landed. */
export const resumeAfterApproval = (decision: string): void => {
  const approval = state.pendingApproval;
  state.pendingApproval = null;
  if (approval === null || state.currentTurn === null) return;
  if (approval.kind === "command") {
    notify("item/completed", itemParams(approval.turnId, {
      completedAtMs: Date.now(),
      item: {
        type: "commandExecution",
        id: approval.callId,
        command: approval.command,
        cwd: FAKE_CWD,
        status: decision === "accept" ? "completed" : "declined",
        commandActions: [],
        aggregatedOutput: decision === "accept" ? "gone\n" : "",
        exitCode: decision === "accept" ? 0 : null,
        durationMs: 5,
      },
    }));
  } else if (approval.kind === "patch") {
    notify("item/completed", itemParams(approval.turnId, {
      completedAtMs: Date.now(),
      item: {
        type: "fileChange",
        id: "fc-ask",
        status: decision === "accept" ? "completed" : "declined",
        changes: [{ diff: "-a\n+b\n", kind: { type: "update" }, path: join(FAKE_CWD, "file.txt") }],
      },
    }));
  }
  // Permissions answers have no item to complete; the answer ends the turn.
  agentMessageCompleted(approval.turnId, "msg-ask", decision === "accept" ? "Allowed." : "Denied.");
  completeTurn(approval.turnId, "completed");
};

/** A response to one of the fake's server requests: the approval
 * decision (or the -32601 error answer to an unimplemented request). */
export const handleDecisionResponse = (frame: Record<string, unknown>): void => {
  const id = frame["id"];
  const result = (typeof frame["result"] === "object" && frame["result"] !== null
    ? frame["result"]
    : {}) as Record<string, unknown>;
  const error = frame["error"];
  record("decisions.jsonl", { id, result, error: error ?? null });
  if (state.drainApprovalPending && String(id) === "appr-drain") {
    // The decline the drain-window approval owed: the command never
    // runs, and the held interrupt is answered and the turn completed
    // exactly as the plain persist path does.
    state.drainApprovalPending = false;
    state.pendingApproval = null;
    const turnId = state.currentTurn;
    respond(state.heldInterruptId, {});
    if (turnId !== null) completeTurn(turnId, "interrupted");
    return;
  }
  if (state.mixedApprovals.length > 0) {
    // Typed matching (review round 73): numeric 1 and string "1" are two
    // different approvals. Each decision completes its own command item;
    // the turn ends only once every approval was answered.
    const mixed = state.mixedApprovals.find(
      (entry) => !entry.decided && JSON.stringify(id) === JSON.stringify(entry.approval.id)
    );
    if (mixed === undefined) return;
    mixed.decided = true;
    const decision = typeof result["decision"] === "string" ? result["decision"] : "decline";
    notify("item/completed", itemParams(mixed.approval.turnId, {
      completedAtMs: Date.now(),
      item: {
        type: "commandExecution",
        id: mixed.approval.callId,
        command: mixed.approval.command,
        cwd: FAKE_CWD,
        status: decision === "accept" ? "completed" : "declined",
        commandActions: [],
        aggregatedOutput: decision === "accept" ? "gone\n" : "",
        exitCode: decision === "accept" ? 0 : null,
        durationMs: 5,
      },
    }));
    if (state.mixedApprovals.every((entry) => entry.decided)) {
      state.mixedApprovals = [];
      agentMessageCompleted(mixed.approval.turnId, "msg-mix", "Both answered.");
      completeTurn(mixed.approval.turnId, "completed");
    }
    return;
  }
  if (state.pendingApproval !== null && String(id) === String(state.pendingApproval.id)) {
    // A permissions reply carries the echoed grant instead of a decision
    // string: an empty echo is a decline, a non-empty one an accept.
    const granted = result["permissions"];
    const decision =
      typeof result["decision"] === "string"
        ? result["decision"]
        : typeof granted === "object" && granted !== null && Object.keys(granted).length > 0
          ? "accept"
          : "decline";
    resumeAfterApproval(decision);
  }
};
