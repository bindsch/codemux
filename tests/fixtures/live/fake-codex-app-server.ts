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
 *   askmixed   — two approvals at once under ids 1 and "1": distinct
 *                JSON types, separately answerable (review round 73)
 *   asknumeric — the same approval under a numeric JSON-RPC id: the
 *                reply must echo the id numerically to correlate
 *   askpatch   — a fileChange approval; same continuation rule
 *   askperms   — a permissions approval; the reply echoes the granted
 *                subset, or an empty object when declined
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
 *   otherturnid — a delta naming another turn before the turn/start
 *                response names the real one (review round 67)
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
 *
 * The scenario bodies live in fake-codex-app-server-parts/scenarios.ts,
 * the wire writers and shared state in ...-parts/wire.ts, the item and
 * approval emitters in ...-parts/items.ts, and the request handlers in
 * ...-parts/requests.ts; this file owns the scenario switch and the
 * process lifecycle.
 */

import * as scenarios from "./fake-codex-app-server-parts/scenarios.js";
import { THREAD_ID, notify, record, respond, respondError, state, stateDir } from "./fake-codex-app-server-parts/wire.js";
import { usage } from "./fake-codex-app-server-parts/items.js";
import {
  handleDecisionResponse,
  handleInitialize,
  handleInterrupt,
  handleSteer,
  startThread,
} from "./fake-codex-app-server-parts/requests.js";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_VERSION ?? "0.159.3"}\n`);
  process.exit(0);
}

record("argv.jsonl", { args, pid: process.pid });
// The provider-override launch: CODEX_HOME is delivered through env(1),
// so the assignment lands in this process's environment (recorded; an
// un-overridden spawn has none).
record("env.jsonl", { codexHome: process.env.CODEX_HOME ?? null, pid: process.pid });

const runScenario = (turnId: string, scenario: string): void => {
  switch (scenario) {
    case "basic":
      scenarios.basic(turnId);
      return;
    case "lateusage":
      scenarios.lateusage(turnId);
      return;
    case "laggard":
    case "laggard2":
      scenarios.laggard(turnId, scenario);
      return;
    case "tools":
      scenarios.tools(turnId);
      return;
    case "ask":
      scenarios.ask(turnId);
      return;
    case "asknumeric":
      scenarios.asknumeric(turnId);
      return;
    case "dupask":
      scenarios.dupask(turnId);
      return;
    case "askmixed":
      scenarios.askmixed(turnId);
      return;
    case "askpatch":
      scenarios.askpatch(turnId);
      return;
    case "askperms":
      scenarios.askperms(turnId);
      return;
    case "wait":
    case "refusesteer":
    case "refusehold":
      scenarios.wait(turnId);
      return;
    case "deaf":
      scenarios.deaf(turnId);
      return;
    case "refuseinterrupt":
      scenarios.refuseinterrupt(turnId);
      return;
    case "failoninterrupt":
      scenarios.failoninterrupt(turnId);
      return;
    case "staleinterrupt":
      scenarios.staleinterrupt(turnId);
      return;
    case "latecomplete":
      scenarios.latecomplete(turnId);
      return;
    case "asklose":
      scenarios.asklose(turnId);
      return;
    case "steer":
      scenarios.steer();
      return;
    case "usagewait":
      scenarios.usagewait(turnId);
      return;
    case "failstart":
      scenarios.failstart();
      return;
    case "crash":
      scenarios.crash(turnId);
      return;
    case "garbage":
      scenarios.garbage();
      return;
    case "rawnewline":
      scenarios.rawnewline(turnId);
      return;
    case "fragment":
      scenarios.fragment(turnId);
      return;
    case "badthread":
      scenarios.badthread(turnId);
      return;
    case "secondthread":
      scenarios.secondthread();
      return;
    case "unknownreq":
      scenarios.unknownreq(turnId);
      return;
    case "badapproval":
      scenarios.badapproval(turnId);
      return;
    case "acceptless":
      scenarios.acceptless(turnId);
      return;
    case "refusalless":
      scenarios.refusalless(turnId);
      return;
    case "badstatus":
      scenarios.badstatus(turnId);
      return;
    default:
      scenarios.defaultArm(turnId);
  }
};

const handleTurnStart = (id: unknown, params: Record<string, unknown>): void => {
  const input = Array.isArray(params["input"]) ? (params["input"] as Record<string, unknown>[]) : [];
  const text = typeof input[0]?.["text"] === "string" ? (input[0]["text"] as string) : "";
  const scenario = /^scenario:([a-z0-9-]+)/.exec(text)?.[1] ?? "basic";
  state.turnCounter += 1;
  const turnId = `turn-fake-${state.turnCounter}`;
  state.currentTurn = turnId;
  state.currentScenario = scenario;
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
  if (scenario === "otherturnid") {
    // Early output names one turn, then the response names another
    // (review round 67): the window's provisional id is contradicted.
    notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: `${turnId}-early`, itemId: "m-early", delta: "early" });
    releaseTurnStart(id, "wait", turnId);
    return;
  }
  if (process.env.FAKE_HOLD_TURNSTART === "1") {
    // The turn/start response (and notification) is held until the
    // shutdown SIGTERM arrives: codemux's end path begins while the
    // harness turn id is still unknown — the response lands inside the
    // drain, which is where the buffered end-interrupt must ride it
    // (review live11, major 1's window).
    state.heldTurnStart = { id, params };
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
  if (state.laggardTurnId !== null && state.laggardSkip > 0) {
    state.laggardSkip -= 1;
  } else if (state.laggardTurnId !== null) {
    // The laggard turn's stragglers, after this turn is named.
    const late = state.laggardTurnId;
    state.laggardTurnId = null;
    notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId: late, itemId: "msg-laggard", delta: "straggler" });
    notify("thread/tokenUsage/updated", {
      threadId: THREAD_ID,
      turnId: late,
      tokenUsage: { total: usage(2000, 0, 0, 9), last: usage(2000, 0, 0, 9), modelContextWindow: 258400 },
    });
  }
  runScenario(turnId, scenario);
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
        handleInitialize(id);
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
      case "turn/steer":
        handleSteer(id, params);
        return;
      case "turn/interrupt":
        handleInterrupt(id, params);
        return;
      default:
        // A method the fake does not know: nothing codemux should send.
        respondError(id, `the fake does not implement ${method}`);
    }
    return;
  }
  // A response to one of the fake's server requests: the approval
  // decision (or the -32601 error answer to an unimplemented request).
  if (id !== undefined) {
    handleDecisionResponse(frame);
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
  // The persistence scenarios also run on a protocol shutdown.
  if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM");
  else process.exit(0);
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
    if (state.heldInitId !== undefined) {
      const id = state.heldInitId;
      state.heldInitId = undefined;
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
    if (state.heldTurnStart !== null) {
      const held = state.heldTurnStart;
      state.heldTurnStart = null;
      releaseTurnStart(held.id, state.currentScenario, state.currentTurn ?? "turn-fake-held");
    }
    setTimeout(() => process.exit(0), 1900);
  });
}
