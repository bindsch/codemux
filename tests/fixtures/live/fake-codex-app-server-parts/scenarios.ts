/**
 * The per-scenario turn bodies of the codex app-server fake, one function
 * per switch arm; tests/fixtures/live/fake-codex-app-server.ts owns the
 * scenario switch that dispatches into them.
 */
import { join } from "node:path";
import { FAKE_CWD, THREAD_ID, notify, serverRequest, state } from "./wire.js";
import { agentMessageCompleted, askApproval, completeTurn, itemParams, usage } from "./items.js";

export const basic = (turnId: string): void => {
  const itemId = "msg-basic";
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
  }));
  notify("item/agentMessage/delta", itemParams(turnId, { itemId, delta: "Hel" }));
  notify("item/agentMessage/delta", itemParams(turnId, { itemId, delta: "lo." }));
  agentMessageCompleted(turnId, itemId, "Hello.");
  notify("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId,
    tokenUsage: { total: usage(18974, 12288, 0, 5), last: usage(18974, 12288, 0, 5), modelContextWindow: 258400 },
  });
  completeTurn(turnId, "completed");
};

export const lateusage = (turnId: string): void => {
  agentMessageCompleted(turnId, "msg-late", "Late.");
  completeTurn(turnId, "completed");
  notify("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId,
    tokenUsage: { total: usage(1000, 0, 0, 7), last: usage(1000, 0, 0, 7), modelContextWindow: 258400 },
  });
};

export const laggard = (turnId: string, scenario: string): void => {
  agentMessageCompleted(turnId, "msg-laggard", "Laggard.");
  completeTurn(turnId, "completed");
  state.laggardTurnId = turnId;
  state.laggardSkip = scenario === "laggard2" ? 1 : 0;
};

export const tools = (turnId: string): void => {
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "commandExecution", id: "cmd-1", command: "echo hi", cwd: FAKE_CWD, status: "inProgress", commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null },
  }));
  notify("item/completed", itemParams(turnId, {
    completedAtMs: Date.now(),
    item: { type: "commandExecution", id: "cmd-1", command: "echo hi", cwd: FAKE_CWD, status: "completed", commandActions: [], aggregatedOutput: "hi\n", exitCode: 0, durationMs: 12 },
  }));
  notify("item/completed", itemParams(turnId, {
    completedAtMs: Date.now(),
    item: {
      type: "fileChange",
      id: "fc-1",
      status: "completed",
      changes: [
        { diff: "+new\n", kind: { type: "add" }, path: join(FAKE_CWD, "new.txt") },
        { diff: "-a\n+b\n", kind: { type: "update" }, path: join(FAKE_CWD, "file.txt") },
        { diff: "", kind: { type: "delete" }, path: join(FAKE_CWD, "old.txt") },
      ],
    },
  }));
  agentMessageCompleted(turnId, "msg-tools", "Edited.");
  notify("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId,
    tokenUsage: { total: usage(100, 0, 0, 10), last: usage(100, 0, 0, 10), modelContextWindow: 258400 },
  });
  notify("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId,
    tokenUsage: { total: usage(150, 20, 5, 15), last: usage(50, 20, 5, 5), modelContextWindow: 258400 },
  });
  completeTurn(turnId, "completed");
};

export const ask = (turnId: string): void => {
  askApproval(turnId, "appr-1", "cmd-ask", "rm -rf /");
};

export const asknumeric = (turnId: string): void => {
  askApproval(turnId, 42, "cmd-num", "echo numeric");
};

export const dupask = (turnId: string): void => {
  // Two approvals under one JSON-RPC id: a grammar violation whose
  // second line must still go out raw (review live21).
  askApproval(turnId, "appr-dup", "cmd-dup-1", "echo one");
  askApproval(turnId, "appr-dup", "cmd-dup-2", "echo two");
};

export const askpatch = (turnId: string): void => {
  state.pendingApproval = { id: "appr-2", kind: "patch", callId: "fc-ask", command: "", turnId };
  serverRequest("item/fileChange/requestApproval", "appr-2", {
    threadId: THREAD_ID,
    turnId,
    callId: "fc-ask",
    changes: [{ diff: "-a\n+b\n", kind: { type: "update" }, path: join(FAKE_CWD, "file.txt") }],
    cwd: FAKE_CWD,
  });
};

export const askperms = (turnId: string): void => {
  // A turn-scoped permission grant request: the reply echoes the grant
  // subset (or an empty object when declined), never a decision string.
  state.pendingApproval = { id: "appr-perm", kind: "permissions", callId: "perm-ask", command: "", turnId };
  serverRequest("item/permissions/requestApproval", "appr-perm", {
    threadId: THREAD_ID,
    turnId,
    callId: "perm-ask",
    permissions: { network: true },
  });
};

export const wait = (turnId: string): void => {
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-wait", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  }));
  agentMessageCompleted(turnId, "msg-wait", "Working...", "commentary");
};

export const deaf = (turnId: string): void => {
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-deaf", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  }));
  agentMessageCompleted(turnId, "msg-deaf", "Working...", "commentary");
};

export const refuseinterrupt = (turnId: string): void => {
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-refuse", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  }));
  agentMessageCompleted(turnId, "msg-refuse", "Uninterruptible...", "commentary");
};

export const failoninterrupt = (turnId: string): void => {
  // Held like wait, but the interrupt completes the turn FAILED with
  // an error message: the harness's own failure must outrank the
  // driver's interrupt label (review live11).
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-failint", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  }));
  agentMessageCompleted(turnId, "msg-failint", "Failing...", "commentary");
};

export const staleinterrupt = (turnId: string): void => {
  // Held like wait. The interrupt is never answered here: the turn
  // completes on its own first (the timer in the turn/interrupt
  // branch), and the rejection is flushed only when a LATER
  // interrupt arrives — the stale-rejection shape the driver must
  // not let clear the next turn's interrupt state (review live11).
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-stale", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  }));
  agentMessageCompleted(turnId, "msg-stale", "Working...", "commentary");
};

export const latecomplete = (turnId: string): void => {
  // Held like wait. The interrupt races a turn the server completes
  // cleanly anyway: the interrupt response is held, the turn
  // completes "completed" on its own, and the rejection lands only
  // afterwards — the shape the driver must report by the wire's own
  // verdict, never recast interrupted from its pending interrupt
  // (review live14).
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-late", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
  }));
  agentMessageCompleted(turnId, "msg-late", "Working...", "commentary");
};

export const asklose = (turnId: string): void => {
  // The approval surfaces, then the app-server ends the turn by
  // itself while the decision is still out: the driver must
  // supersede the approval rather than leave it pending (review
  // live11).
  askApproval(turnId, "appr-lose", "cmd-lose", "echo lose");
  setTimeout(() => {
    if (state.currentTurn !== null) {
      const turnId2 = state.currentTurn;
      agentMessageCompleted(turnId2, "msg-asklose", "Ended by itself.");
      completeTurn(turnId2, "completed");
    }
  }, 200);
};

export const steer = (): void => {
  // Nothing until the steer request lands.
};

export const usagewait = (turnId: string): void => {
  notify("thread/tokenUsage/updated", {
    threadId: THREAD_ID,
    turnId,
    tokenUsage: { total: usage(300, 0, 0, 11), last: usage(300, 0, 0, 11), modelContextWindow: 258400 },
  });
};

export const failstart = (): void => {
  // The turn/start response itself is an error; the driver fails the
  // open turn. (Handled at the request site, which has the id.)
};

export const crash = (turnId: string): void => {
  agentMessageCompleted(turnId, "msg-crash", "About to crash.");
  setTimeout(() => process.exit(1), 100);
};

export const garbage = (): void => {
  process.stdout.write("this is not json\n");
};

export const rawnewline = (turnId: string): void => {
  // One frame, split by a raw newline inside the delta string: the
  // driver must buffer the first line and rejoin with an escaped
  // newline to parse the whole frame.
  process.stdout.write(
    `{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD_ID}","turnId":"${turnId}","itemId":"msg-raw","delta":"split\n`
  );
  process.stdout.write(`line"} }\n`);
  agentMessageCompleted(turnId, "msg-raw", "split\nline");
  completeTurn(turnId, "completed");
};

export const fragment = (turnId: string): void => {
  // The stream ends inside a raw-newline fragment: half a delta frame,
  // no newline, then the process exits (review live25).
  process.stdout.write(
    `{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD_ID}","turnId":"${turnId}","itemId":"msg-cut","delta":"cut off`
  );
  setTimeout(() => process.exit(0), 100);
};

export const badthread = (turnId: string): void => {
  notify("item/started", {
    threadId: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb",
    turnId,
    startedAtMs: Date.now(),
    item: { type: "agentMessage", id: "msg-foreign", text: "", phase: "final_answer" },
  });
};

export const secondthread = (): void => {
  notify("thread/started", { thread: { id: "99999999-8888-7777-6666-555555555555" } });
};

export const unknownreq = (turnId: string): void => {
  serverRequest("fs/readFileText", "req-x", { path: "/etc/hosts" });
  agentMessageCompleted(turnId, "msg-unknown", "Went on.");
  completeTurn(turnId, "completed");
};

export const badapproval = (turnId: string): void => {
  // No threadId/turnId: the driver cannot judge it and must decline.
  serverRequest("item/commandExecution/requestApproval", "appr-bad", {
    callId: "cmd-bad",
    command: "true",
    cwd: FAKE_CWD,
  });
  agentMessageCompleted(turnId, "msg-badapproval", "Declined and moved on.");
  completeTurn(turnId, "completed");
};

export const acceptless = (turnId: string): void => {
  // Review live15: no plain "accept" in the decision list — codemux
  // never answers acceptForSession, so an allow cannot be delivered
  // and must be answered deny on the wire.
  askApproval(turnId, "appr-nos", "cmd-nos", "echo acceptless", ["acceptForSession", "decline"]);
};

export const refusalless = (turnId: string): void => {
  askApproval(turnId, "appr-norefuse", "cmd-norefuse", "echo norefuse", ["accept", "acceptForSession"]);
};

export const badstatus = (turnId: string): void => {
  // Review live15: turn/completed with a status the driver does not
  // recognize — the turn must complete failed, not stay open.
  agentMessageCompleted(turnId, "msg-badstatus", "Stalled?");
  completeTurn(turnId, "expired");
};

export const defaultArm = (turnId: string): void => {
  agentMessageCompleted(turnId, "msg-default", "Done.");
  completeTurn(turnId, "completed");
};
