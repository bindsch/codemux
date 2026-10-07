/**
 * A scenario-driven fake of the codex app-server, built from the shapes
 * pinned by the step-0 fixture (tests/fixtures/live/codex-app-server.ndjson,
 * codex 0.159.3) and the approval schemas of the openclaw client. The
 * e2e tests drive the real driver against this script instead of a
 * recorded transcript, so every round-trip — the handshake, turn
 * requests, steers, interrupts, approval decisions — is live.
 *
 * Protocol: NDJSON JSON-RPC 2.0 on both stdio ends. Requests codemux
 * sends carry `jsonrpc`; responses and notifications omit it, exactly as
 * the fixture recorded. The scenario for a turn is selected by the turn
 * text's `scenario:<name>` prefix:
 *
 *   basic      — deltas, a final agentMessage, usage, a completed turn
 *   lateusage  — a completed turn whose tokenUsage update arrives AFTER
 *                its turn/completed (review live18)
 *   laggard    — a completed turn whose last delta and tokenUsage update
 *                arrive only after the NEXT turn's turn/start response
 *                (queued input drained at once, review live20)
 *   laggard2   — the same stragglers, held until the turn AFTER the next
 *                one is named (review live23: only the last closed turn
 *                was remembered)
 *   refusesteer — holds like wait; every turn/steer is answered with a
 *                JSON-RPC error (review live23)
 *   refusehold — holds like wait; every interrupt is answered with a
 *                JSON-RPC error and the turn stays open (review live23:
 *                the end path's wait must stop on the rejection)
 *   tools      — a commandExecution, a three-change fileChange, usage ×2
 *   ask        — a commandExecution approval; the turn continues only
 *                after the decision response (records it)
 *   dupask     — two approvals under one JSON-RPC id (tier 2, review
 *                live21)
 *   asknumeric — the same approval under a numeric JSON-RPC id: the
 *                reply must echo the id numerically to correlate
 *   askpatch   — a fileChange approval; same continuation rule
 *   wait       — one commentary message, then nothing until steered or
 *                interrupted
 *   steer      — waits for the steer request, then answers with the
 *                steered text
 *   refuseinterrupt — one commentary message, then holds; the interrupt
 *                request is answered with a JSON-RPC error and the turn
 *                completes on its own (the rejected-interrupt path)
 *   failoninterrupt — holds like wait; the interrupt is accepted and the
 *                turn completes FAILED with an error message, which must
 *                outrank the interrupt label (review live11)
 *   staleinterrupt — holds like wait; the interrupt's response is held
 *                while the turn completes interrupted on its own, and the
 *                rejection is flushed only by the NEXT interrupt (review
 *                live11)
 *   deaf       — holds like wait; every interrupt is accepted and
 *                ignored, so the turn never completes (the --turn-timeout
 *                cap's shape, review live17)
 *   latecomplete — holds like wait; the interrupt's response is held
 *                while the turn completes "completed" on its own, then
 *                rejected — the wire's verdict must stand (review
 *                live14)
 *   asklose    — a commandExecution approval, then the turn completes
 *                by itself while the decision is still out (review
 *                live11)
 *   fragment   — writes half a delta frame with no newline, then exits:
 *                the stream ends inside a fragment (review live25)
 *   failstart  — answers turn/start with a JSON-RPC error
 *   usagefailstart — one tokenUsage update naming the turn, then the
 *                turn/start error (review live22: the update's usage
 *                must reach the session total)
 *   usagewait  — one tokenUsage update, then holds like deaf: the
 *                interrupt is accepted and ignored (review live22: an
 *                end mid-turn keeps the usage already reported)
 *   noturnid   — answers turn/start with a success that names no turn,
 *                then holds (review live22)
 *   crash      — one agentMessage, then exit 1
 *   garbage    — a non-JSON line, then nothing (tier-3 fatal)
 *   rawnewline — one JSON frame split by a raw newline inside a string
 *                value (openclaw's rejoin quirk), then a completed turn
 *   badthread  — an item notification referencing a foreign thread
 *   secondthread — a second thread/started notification
 *   unknownreq — an unimplemented server request (fs/readFileText), then
 *                a normal completion
 *   badapproval — an approval request with unparsable params (no
 *                threadId), then a normal completion
 *   acceptless — a commandExecution approval whose availableDecisions
 *                omit plain "accept" (["acceptForSession","decline"]):
 *                an allow is undeliverable and must be answered deny
 *                (review live15)
 *   refusalless — a commandExecution approval whose availableDecisions
 *                carry neither "decline" nor "cancel"
 *                (["accept","acceptForSession"]): codemux has no refusal
 *                to send, so it must not forward it (review live17)
 *   badstatus  — turn/completed with an unrecognized status ("expired");
 *                the turn must complete failed, not stay open (review
 *                live15)
 *
 * Everything received (requests, approval decisions, interrupts) is
 * recorded as JSONL under $FAKE_STATE_DIR for the assertions.
 *
 * With FAKE_STALL_INIT=1 the initialize request is recorded but never
 * answered: a handshake that stalls forever, for the shutdown-during-
 * startup path. With FAKE_STALL_INIT=release it is held the same way but
 * answered on the shutdown SIGTERM, so the response lands inside the
 * drain window where the handshake chain must stop; =rejectrelease
 * answers it with a JSON-RPC error there instead (review live15). With
 * FAKE_STRING_ID_RESPONSE=1 the initialize response echoes the request id
 * as a string — a reply no numbered request ever made (review live15).
 * With FAKE_ANNOUNCE_OTHER_THREAD=1 a fresh thread/started names a
 * different id than the thread/start response that follows it (review
 * live15). With FAKE_RESUME_WRONG_THREAD=1 a thread/resume is
 * answered with a different thread id than requested (review live12).
 * With FAKE_TURNSTART_DELAY=<ms> the turn/start response is delayed by a
 * timer, so steers sent right behind the user line buffer in codemux
 * until it lands (review live14).
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-codex-app-server";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_VERSION ?? "0.159.3"}\n`);
  process.exit(0);
}

record("argv.jsonl", { args, pid: process.pid });

// FAKE_THREAD_ID bends the id the fake starts (review live16: an id
// `--resume` would refuse must never reach the registry).
const THREAD_ID = process.env.FAKE_THREAD_ID ?? "0123456789abcdef";
const FAKE_CWD = process.env.FAKE_CWD ?? process.cwd();

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const respond = (id: unknown, result: unknown): void => {
  write({ id, result });
};
const respondError = (id: unknown, message: string): void => {
  write({ id, error: { code: -1, message } });
};
const notify = (method: string, params: Record<string, unknown>): void => {
  write({ method, params });
};
const serverRequest = (
  method: string,
  id: string | number,
  params: Record<string, unknown>
): void => {
  write({ method, id, params });
};

let turnCounter = 0;
let currentTurn: string | null = null;
let currentScenario = "";
/** The approval waiting on a decision response, and the turn it froze.
 * The id keeps its wire type: numeric ids must be answered numerically. */
let pendingApproval: {
  id: string | number;
  kind: "command" | "patch";
  callId: string;
  command: string;
  turnId: string;
} | null = null;
// FAKE_SIGTERM_PERSIST=ask state: the drain-window approval is NOT
// tracked in pendingApproval — resumeAfterApproval would complete the
// turn "completed", while the held end-interrupt must complete it
// "interrupted" once the decline lands.
let drainApprovalPending = false;
let heldInterruptId: string | number | undefined;
// FAKE_HOLD_TURNSTART=1 state: the turn/start request held until the
// shutdown SIGTERM releases it inside the drain window.
let heldTurnStart: { id: unknown; params: Record<string, unknown> } | null = null;
// staleinterrupt state: the interrupt whose response is held until a
// later interrupt flushes the rejection first.
let staleInterruptId: string | number | undefined;
// FAKE_STALL_INIT=release/rejectrelease state: the initialize held until
// the shutdown SIGTERM answers it inside codemux's drain window.
let heldInitId: unknown = undefined;
// laggard state: the completed turn whose stragglers the next
// turn/start releases.
let laggardTurnId: string | null = null;
// Turn starts to let pass before the laggard's stragglers go out.
let laggardSkip = 0;
/** Steer texts the current wait/steer turn has absorbed. */
const steeredTexts: string[] = [];

const usage = (input: number, cached: number, cacheWrite: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: cacheWrite,
  outputTokens: output,
  reasoningOutputTokens: 0,
});

const itemParams = (turnId: string, item: Record<string, unknown>) => ({
  threadId: THREAD_ID,
  turnId,
  ...item,
});

const agentMessageCompleted = (turnId: string, id: string, text: string, phase = "final_answer"): void => {
  notify("item/completed", itemParams(turnId, {
    completedAtMs: Date.now(),
    item: { type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null },
  }));
};

const completeTurn = (turnId: string, status: string, error: { message: string } | null = null): void => {
  currentTurn = null;
  currentScenario = "";
  notify("turn/completed", {
    threadId: THREAD_ID,
    turn: { id: turnId, items: [], itemsView: "notLoaded", status, error },
  });
};

/** A commandExecution approval request under any JSON-RPC id type. The
 * decision list is a parameter: the acceptless scenario sends one without
 * a plain "accept" (review live15). */
const askApproval = (
  turnId: string,
  id: string | number,
  callId: string,
  command: string,
  availableDecisions: string[] = ["accept", "decline", "cancel"]
): void => {
  notify("item/started", itemParams(turnId, {
    startedAtMs: Date.now(),
    item: { type: "commandExecution", id: callId, command, cwd: FAKE_CWD, status: "inProgress", commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null },
  }));
  pendingApproval = { id, kind: "command", callId, command, turnId };
  serverRequest("item/commandExecution/requestApproval", id, {
    threadId: THREAD_ID,
    turnId,
    callId,
    command,
    cwd: FAKE_CWD,
    availableDecisions,
  });
};

const runScenario = (turnId: string, scenario: string): void => {
  switch (scenario) {
    case "basic": {
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
      return;
    }
    case "lateusage": {
      agentMessageCompleted(turnId, "msg-late", "Late.");
      completeTurn(turnId, "completed");
      notify("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId,
        tokenUsage: { total: usage(1000, 0, 0, 7), last: usage(1000, 0, 0, 7), modelContextWindow: 258400 },
      });
      return;
    }
    case "laggard":
    case "laggard2": {
      agentMessageCompleted(turnId, "msg-laggard", "Laggard.");
      completeTurn(turnId, "completed");
      laggardTurnId = turnId;
      laggardSkip = scenario === "laggard2" ? 1 : 0;
      return;
    }
    case "tools": {
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
      return;
    }
    case "ask":
      askApproval(turnId, "appr-1", "cmd-ask", "rm -rf /");
      return;
    case "asknumeric":
      askApproval(turnId, 42, "cmd-num", "echo numeric");
      return;
    case "dupask":
      // Two approvals under one JSON-RPC id: a grammar violation whose
      // second line must still go out raw (review live21).
      askApproval(turnId, "appr-dup", "cmd-dup-1", "echo one");
      askApproval(turnId, "appr-dup", "cmd-dup-2", "echo two");
      return;
    case "askpatch": {
      pendingApproval = { id: "appr-2", kind: "patch", callId: "fc-ask", command: "", turnId };
      serverRequest("item/fileChange/requestApproval", "appr-2", {
        threadId: THREAD_ID,
        turnId,
        callId: "fc-ask",
        changes: [{ diff: "-a\n+b\n", kind: { type: "update" }, path: join(FAKE_CWD, "file.txt") }],
        cwd: FAKE_CWD,
      });
      return;
    }
    case "wait":
    case "refusesteer":
    case "refusehold": {
      notify("item/started", itemParams(turnId, {
        startedAtMs: Date.now(),
        item: { type: "agentMessage", id: "msg-wait", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
      }));
      agentMessageCompleted(turnId, "msg-wait", "Working...", "commentary");
      return;
    }
    case "deaf": {
      notify("item/started", itemParams(turnId, {
        startedAtMs: Date.now(),
        item: { type: "agentMessage", id: "msg-deaf", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
      }));
      agentMessageCompleted(turnId, "msg-deaf", "Working...", "commentary");
      return;
    }
    case "refuseinterrupt": {
      notify("item/started", itemParams(turnId, {
        startedAtMs: Date.now(),
        item: { type: "agentMessage", id: "msg-refuse", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
      }));
      agentMessageCompleted(turnId, "msg-refuse", "Uninterruptible...", "commentary");
      return;
    }
    case "failoninterrupt": {
      // Held like wait, but the interrupt completes the turn FAILED with
      // an error message: the harness's own failure must outrank the
      // driver's interrupt label (review live11).
      notify("item/started", itemParams(turnId, {
        startedAtMs: Date.now(),
        item: { type: "agentMessage", id: "msg-failint", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
      }));
      agentMessageCompleted(turnId, "msg-failint", "Failing...", "commentary");
      return;
    }
    case "staleinterrupt": {
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
      return;
    }
    case "latecomplete": {
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
      return;
    }
    case "asklose": {
      // The approval surfaces, then the app-server ends the turn by
      // itself while the decision is still out: the driver must
      // supersede the approval rather than leave it pending (review
      // live11).
      askApproval(turnId, "appr-lose", "cmd-lose", "echo lose");
      setTimeout(() => {
        if (currentTurn !== null) {
          const turnId2 = currentTurn;
          agentMessageCompleted(turnId2, "msg-asklose", "Ended by itself.");
          completeTurn(turnId2, "completed");
        }
      }, 200);
      return;
    }
    case "steer":
      // Nothing until the steer request lands.
      return;
    case "usagewait":
      notify("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId,
        tokenUsage: { total: usage(300, 0, 0, 11), last: usage(300, 0, 0, 11), modelContextWindow: 258400 },
      });
      return;
    case "failstart":
      // The turn/start response itself is an error; the driver fails the
      // open turn. (Handled at the request site, which has the id.)
      return;
    case "crash":
      agentMessageCompleted(turnId, "msg-crash", "About to crash.");
      setTimeout(() => process.exit(1), 100);
      return;
    case "garbage":
      process.stdout.write("this is not json\n");
      return;
    case "rawnewline": {
      // One frame, split by a raw newline inside the delta string: the
      // driver must buffer the first line and rejoin with an escaped
      // newline to parse the whole frame.
      process.stdout.write(
        `{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD_ID}","turnId":"${turnId}","itemId":"msg-raw","delta":"split\n`
      );
      process.stdout.write(`line"} }\n`);
      agentMessageCompleted(turnId, "msg-raw", "split\nline");
      completeTurn(turnId, "completed");
      return;
    }
    case "fragment":
      // The stream ends inside a raw-newline fragment: half a delta frame,
      // no newline, then the process exits (review live25).
      process.stdout.write(
        `{"method":"item/agentMessage/delta","params":{"threadId":"${THREAD_ID}","turnId":"${turnId}","itemId":"msg-cut","delta":"cut off`
      );
      setTimeout(() => process.exit(0), 100);
      return;
    case "badthread":
      notify("item/started", {
        threadId: "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb",
        turnId,
        startedAtMs: Date.now(),
        item: { type: "agentMessage", id: "msg-foreign", text: "", phase: "final_answer" },
      });
      return;
    case "secondthread":
      notify("thread/started", { thread: { id: "99999999-8888-7777-6666-555555555555" } });
      return;
    case "unknownreq":
      serverRequest("fs/readFileText", "req-x", { path: "/etc/hosts" });
      agentMessageCompleted(turnId, "msg-unknown", "Went on.");
      completeTurn(turnId, "completed");
      return;
    case "badapproval":
      // No threadId/turnId: the driver cannot judge it and must decline.
      serverRequest("item/commandExecution/requestApproval", "appr-bad", {
        callId: "cmd-bad",
        command: "true",
        cwd: FAKE_CWD,
      });
      agentMessageCompleted(turnId, "msg-badapproval", "Declined and moved on.");
      completeTurn(turnId, "completed");
      return;
    case "acceptless":
      // Review live15: no plain "accept" in the decision list — codemux
      // never answers acceptForSession, so an allow cannot be delivered
      // and must be answered deny on the wire.
      askApproval(turnId, "appr-nos", "cmd-nos", "echo acceptless", ["acceptForSession", "decline"]);
      return;
    case "refusalless":
      askApproval(turnId, "appr-norefuse", "cmd-norefuse", "echo norefuse", ["accept", "acceptForSession"]);
      return;
    case "badstatus":
      // Review live15: turn/completed with a status the driver does not
      // recognize — the turn must complete failed, not stay open.
      agentMessageCompleted(turnId, "msg-badstatus", "Stalled?");
      completeTurn(turnId, "expired");
      return;
    default:
      agentMessageCompleted(turnId, "msg-default", "Done.");
      completeTurn(turnId, "completed");
  }
};

const startThread = (id: unknown, announce: boolean): void => {
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

const handleTurnStart = (id: unknown, params: Record<string, unknown>): void => {
  const input = Array.isArray(params["input"]) ? (params["input"] as Record<string, unknown>[]) : [];
  const text = typeof input[0]?.["text"] === "string" ? (input[0]["text"] as string) : "";
  const scenario = /^scenario:([a-z0-9-]+)/.exec(text)?.[1] ?? "basic";
  turnCounter += 1;
  const turnId = `turn-fake-${turnCounter}`;
  currentTurn = turnId;
  currentScenario = scenario;
  if (scenario === "failstart") {
    respondError(id, "the turn was refused");
    return;
  }
  if (scenario === "usagefailstart") {
    notify("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      turnId,
      tokenUsage: { total: usage(400, 0, 0, 13), last: usage(400, 0, 0, 13), modelContextWindow: 258400 },
    });
    respondError(id, "the turn was refused");
    return;
  }
  if (scenario === "noturnid") {
    respond(id, { turn: { items: [], status: "inProgress" } });
    return;
  }
  if (process.env.FAKE_HOLD_TURNSTART === "1") {
    // The turn/start response (and notification) is held until the
    // shutdown SIGTERM arrives: codemux's end path begins while the
    // harness turn id is still unknown — the response lands inside the
    // drain, which is where the buffered end-interrupt must ride it
    // (review live11, major 1's window).
    heldTurnStart = { id, params };
    return;
  }
  const turnStartDelayMs = Number(process.env.FAKE_TURNSTART_DELAY ?? "0");
  if (turnStartDelayMs > 0) {
    // The response (and notification) is delayed by a timer: steers and
    // interrupts sent right after the user line buffer in codemux until
    // it lands — the window the bounded steer batching must survive
    // (review live14).
    setTimeout(() => releaseTurnStart(id, scenario, turnId), turnStartDelayMs);
    return;
  }
  releaseTurnStart(id, scenario, turnId);
};

/** Answer a turn/start and run its scenario — the held request's release
 * path too, which must bypass the hold check above or it would re-hold
 * forever. */
const releaseTurnStart = (id: unknown, scenario: string, turnId: string): void => {
  respond(id, { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null } });
  notify("turn/started", {
    threadId: THREAD_ID,
    turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null },
  });
  if (laggardTurnId !== null && laggardSkip > 0) {
    laggardSkip -= 1;
  } else if (laggardTurnId !== null) {
    // The laggard turn's stragglers, after this turn is named.
    const late = laggardTurnId;
    laggardTurnId = null;
    notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: late, itemId: "msg-laggard", delta: "straggler" });
    notify("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      turnId: late,
      tokenUsage: { total: usage(2000, 0, 0, 9), last: usage(2000, 0, 0, 9), modelContextWindow: 258400 },
    });
  }
  runScenario(turnId, scenario);
};

/** Resume the turn an approval froze, once its decision landed. */
const resumeAfterApproval = (decision: string): void => {
  const approval = pendingApproval;
  pendingApproval = null;
  if (approval === null || currentTurn === null) return;
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
  } else if (decision === "accept") {
    notify("item/completed", itemParams(approval.turnId, {
      completedAtMs: Date.now(),
      item: {
        type: "fileChange",
        id: "fc-ask",
        status: "completed",
        changes: [{ diff: "-a\n+b\n", kind: { type: "update" }, path: join(FAKE_CWD, "file.txt") }],
      },
    }));
  }
  agentMessageCompleted(approval.turnId, "msg-ask", decision === "accept" ? "Allowed." : "Denied.");
  completeTurn(approval.turnId, "completed");
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
  const frame = parsed as Record<string, unknown>;
  const method = frame["method"];
  const id = frame["id"];
  const params = (typeof frame["params"] === "object" && frame["params"] !== null
    ? frame["params"]
    : {}) as Record<string, unknown>;
  if (typeof method === "string") {
    record("requests.jsonl", { id, method, params });
    switch (method) {
      case "initialize":
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
          heldInitId = id;
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
        return;
      case "notifications/initialized":
        return;
      case "thread/start":
      case "thread/resume":
        startThread(id, method === "thread/start");
        return;
      case "turn/start":
        handleTurnStart(id, params);
        return;
      case "turn/steer": {
        if (currentScenario === "refusesteer") {
          record("steers.jsonl", { expectedTurnId: params["expectedTurnId"], refused: true });
          respondError(id, "the turn already completed");
          return;
        }
        respond(id, {});
        const input = Array.isArray(params["input"]) ? (params["input"] as Record<string, unknown>[]) : [];
        for (const piece of input) {
          if (typeof piece["text"] === "string") steeredTexts.push(piece["text"] as string);
        }
        record("steers.jsonl", { expectedTurnId: params["expectedTurnId"], texts: [...steeredTexts] });
        if (currentTurn !== null && (currentScenario === "steer" || currentScenario === "wait")) {
          agentMessageCompleted(currentTurn, "msg-steer", `Steered: ${steeredTexts.join(" | ")}`);
          completeTurn(currentTurn, "completed");
        }
        return;
      }
      case "turn/interrupt": {
        record("interrupts.jsonl", { turnId: params["turnId"] });
        if (currentScenario === "refusehold") {
          respondError(id, "the turn cannot be interrupted");
          return;
        }
        if (currentScenario === "refuseinterrupt") {
          // The rejection the driver must survive: the interrupt did not
          // happen, and the turn's own completion is the truth of it.
          respondError(id, "the turn cannot be interrupted");
          if (currentTurn !== null) {
            const turnId = currentTurn;
            pendingApproval = null;
            agentMessageCompleted(turnId, "msg-refuse", "Refused and finished.");
            completeTurn(turnId, "completed");
          }
          return;
        }
        if (currentScenario === "deaf" || currentScenario === "usagewait") {
          // Accepted and ignored: the turn stays open (review live17).
          respond(id, {});
          return;
        }
        if (currentScenario === "failoninterrupt") {
          // The interrupt is accepted, and the turn completes FAILED with
          // an error message: the harness's own failure must outrank the
          // driver's interrupt label (review live11).
          respond(id, {});
          if (currentTurn !== null) {
            const turnId = currentTurn;
            pendingApproval = null;
            agentMessageCompleted(turnId, "msg-failint", "Failing.", "commentary");
            completeTurn(turnId, "failed", { message: "rate limit exceeded" });
          }
          return;
        }
        if (currentScenario === "latecomplete") {
          // Hold the response: the turn completes cleanly on its own
          // (the driver sees a "completed" wire status while its own
          // interrupt is still in flight — a --turn-timeout's or a
          // caller's), and the interrupt is only then rejected, too late
          // to change what the turn already said (review live14).
          const heldId = id;
          setTimeout(() => {
            if (currentTurn !== null) {
              const turnId = currentTurn;
              pendingApproval = null;
              agentMessageCompleted(turnId, "msg-late", "Finished anyway.");
              completeTurn(turnId, "completed");
            }
            respondError(heldId, "the turn is no longer running");
          }, 150);
          return;
        }
        if (currentScenario === "staleinterrupt") {
          // Hold the response: the turn completes on its own (the driver
          // sees its own interrupted completion with the interrupt still
          // pending), and the rejection is flushed only by the NEXT
          // interrupt request — the stale rejection the driver must not
          // let clear that next turn's interrupt state (review live11).
          staleInterruptId = typeof id === "string" || typeof id === "number" ? id : undefined;
          setTimeout(() => {
            if (currentTurn !== null) {
              const turnId = currentTurn;
              pendingApproval = null;
              completeTurn(turnId, "interrupted");
            }
          }, 150);
          return;
        }
        if (staleInterruptId !== undefined) {
          // A later interrupt arrived: flush the stale rejection first,
          // then answer this one normally.
          respondError(staleInterruptId, "the turn cannot be interrupted");
          staleInterruptId = undefined;
        }
        if (process.env.FAKE_SIGTERM_PERSIST === "ask" && currentTurn !== null) {
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
          drainApprovalPending = true;
          heldInterruptId = typeof id === "string" || typeof id === "number" ? id : undefined;
          const turnId = currentTurn;
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
        if (currentTurn !== null) {
          const turnId = currentTurn;
          pendingApproval = null;
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
        return;
      }
      default:
        // A method the fake does not know: nothing codemux should send.
        respondError(id, `the fake does not implement ${method}`);
    }
    return;
  }
  // A response to one of the fake's server requests: the approval
  // decision (or the -32601 error answer to an unimplemented request).
  if (id !== undefined) {
    const result = (typeof frame["result"] === "object" && frame["result"] !== null
      ? frame["result"]
      : {}) as Record<string, unknown>;
    const error = frame["error"];
    record("decisions.jsonl", { id, result, error: error ?? null });
    if (drainApprovalPending && String(id) === "appr-drain") {
      // The decline the drain-window approval owed: the command never
      // runs, and the held interrupt is answered and the turn completed
      // exactly as the plain persist path does.
      drainApprovalPending = false;
      pendingApproval = null;
      const turnId = currentTurn;
      respond(heldInterruptId, {});
      if (turnId !== null) completeTurn(turnId, "interrupted");
      return;
    }
    if (pendingApproval !== null && String(id) === String(pendingApproval.id)) {
      const decision = typeof result["decision"] === "string" ? result["decision"] : "decline";
      resumeAfterApproval(decision);
    }
  }
};

let buffer = "";
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
// way the real app-server survives it inside the grace window — the
// end-interrupt request arrives on stdin either just before or just
// after the signal, its response and the interrupted turn/completed (and
// a last tokenUsage update) go back while the pipes are still open, and
// only then does the process exit. =ask survives the same way but, on
// the end-interrupt itself, first surfaces a commandExecution approval
// that lands inside the drain window (see the turn/interrupt branch) and
// answers the interrupt only after the decision — the live8 regression's
// shape. =garbage additionally writes one non-JSON line before dying —
// a harness emitting unusable output inside the grace window, which the
// live7 regression pins as costing success rather than being absorbed by
// the already-running end path. =exit1 answers like =1 and then exits 1:
// a delivered completion no longer excuses a nonzero exit (review
// live18). =exit42 answers nothing: the turn stays
// open and the process exits 42 — an app-server failing while persisting
// during the shutdown, the live9 shape whose cost the driver must report
// (exit 1, not 0). =exit143 is the same silence with exit code 143 — a
// wrapper answering the SIGTERM with an exit code instead of dying by
// signal (the scode spelling), which must NOT be read as the live9
// failure (review live11). Without the env the default SIGTERM
// disposition applies (die at once), the behavior every other test
// relies on.
const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (
  persistMode === "1" ||
  persistMode === "exit1" ||
  persistMode === "garbage" ||
  persistMode === "ask" ||
  persistMode === "exit42" ||
  persistMode === "exit143"
) {
  process.on("SIGTERM", () => {
    if (persistMode === "garbage") {
      process.stdout.write("this line is not json\n");
    }
    const code =
      persistMode === "exit42" ? 42 : persistMode === "exit143" ? 143 : persistMode === "exit1" ? 1 : 0;
    setTimeout(() => process.exit(code), 300);
  });
}
// FAKE_STALL_INIT=release/rejectrelease (review live15): survive the
// shutdown SIGTERM and answer the held initialize on it — success for
// =release, a JSON-RPC error for =rejectrelease — so the response lands
// inside codemux's drain window, after the caller's shutdown was already
// acked, and then exit. The handshake chain must stop there either way.
if (
  process.env.FAKE_STALL_INIT === "release" ||
  process.env.FAKE_STALL_INIT === "rejectrelease"
) {
  process.on("SIGTERM", () => {
    if (heldInitId !== undefined) {
      const id = heldInitId;
      heldInitId = undefined;
      if (process.env.FAKE_STALL_INIT === "rejectrelease") {
        respondError(id, "the server changed its mind");
      } else {
        respond(id, {
          userAgent: `codemux-fake/0.159.3 (${process.platform}; ${process.arch})`,
          codexHome: process.env.FAKE_CODEX_HOME ?? `${stateDir}/codex-home`,
          platformFamily: "unix",
          platformOs: process.platform === "darwin" ? "macos" : "linux",
        });
      }
    }
    setTimeout(() => process.exit(0), 250);
  });
}
// FAKE_HOLD_TURNSTART=1 (review live11, major 1): survive the shutdown
// SIGTERM and, on it, release the held turn/start response — which lands
// inside the drain window, where the driver's buffered end-interrupt
// must ride it. The turn then completes through the interrupt branch
// above (which exits); a safety timer exits at the far edge in case
// anything stalls.
if (process.env.FAKE_HOLD_TURNSTART === "1") {
  process.on("SIGTERM", () => {
    if (heldTurnStart !== null) {
      const held = heldTurnStart;
      heldTurnStart = null;
      releaseTurnStart(held.id, currentScenario, currentTurn ?? "turn-fake-held");
    }
    setTimeout(() => process.exit(0), 1900);
  });
}
