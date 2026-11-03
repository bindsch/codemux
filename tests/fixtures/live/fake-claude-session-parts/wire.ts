/**
 * Wire writer, session-id resolution, the cost counter, and the shared
 * mutable state for the claude-family fake;
 * tests/fixtures/live/fake-claude-session.ts owns the lifecycle.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-claude-session";
mkdirSync(stateDir, { recursive: true });
export const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
const sessionIdIndex =
  args.indexOf("--session-id") !== -1 ? args.indexOf("--session-id") : args.indexOf("--resume");
export const sessionId = sessionIdIndex !== -1 ? args[sessionIdIndex + 1] : "fake-session-id";

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
export const write = (value: unknown): void => {
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
export const spend = (micro: number): number => {
  sessionCostMicro += micro;
  return sessionCostMicro / 1_000_000;
};

/** A can_use_tool request the fake has out, awaiting its decision. */
export interface ClaudePendingAsk {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

/** The fake's session-spanning mutable state, shared by the entry's
 * dispatch and the part modules. */
export interface ClaudeFakeState {
  pendingAsk: ClaudePendingAsk | null;
  // FAKE_SIGTERM_PERSIST=ask state: the drain-window ask is deliberately
  // NOT tracked in pendingAsk — setting it would make the deny branch emit
  // a second result for a turn the interrupt is about to complete.
  drainAskPending: boolean;
  drainInterruptId: string;
  // A user line arriving while a turn is still emitting waits for that
  // turn's result and then runs as its own turn: the recorded text-only
  // case (review live21). The real wire folds the line into the running
  // turn instead when that turn makes another model request (fixture
  // zai-session-a.ndjson); the fake does not model the fold, because the
  // driver never forwards a mid-turn line (`user_during_turn: false`) and
  // only the drain-window and pre-init paths can reach this queue.
  turnActive: boolean;
  inputQueue: string[];
  // The scenario of the running turn (set in runUserText), so the
  // interrupt handler can race the race scenario's result (below).
  currentScenario: string;
}

export const state: ClaudeFakeState = {
  pendingAsk: null,
  drainAskPending: false,
  drainInterruptId: "",
  turnActive: false,
  inputQueue: [],
  currentScenario: "basic",
};
