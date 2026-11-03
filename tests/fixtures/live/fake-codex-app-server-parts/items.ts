/**
 * Item, turn-completion, and approval emitters for the codex app-server
 * fake; tests/fixtures/live/fake-codex-app-server.ts owns the lifecycle.
 */
import { FAKE_CWD, THREAD_ID, notify, serverRequest, state } from "./wire.js";

export const usage = (input: number, cached: number, cacheWrite: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: cacheWrite,
  outputTokens: output,
  reasoningOutputTokens: 0,
});

export const itemParams = (turnId: string, item: Record<string, unknown>) => ({
  threadId: THREAD_ID,
  turnId,
  ...item,
});

export const agentMessageCompleted = (turnId: string, id: string, text: string, phase = "final_answer"): void => {
  notify("item/completed", itemParams(turnId, {
    completedAtMs: Date.now(),
    item: { type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null },
  }));
};

export const completeTurn = (turnId: string, status: string, error: { message: string } | null = null): void => {
  state.currentTurn = null;
  state.currentScenario = "";
  notify("turn/completed", {
    threadId: THREAD_ID,
    turn: { id: turnId, items: [], itemsView: "notLoaded", status, error },
  });
};

/** A commandExecution approval request under any JSON-RPC id type. The
 * decision list is a parameter: the acceptless scenario sends one without
 * a plain "accept" (review live15). */
export const askApproval = (
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
  state.pendingApproval = { id, kind: "command", callId, command, turnId };
  serverRequest("item/commandExecution/requestApproval", id, {
    threadId: THREAD_ID,
    turnId,
    callId,
    command,
    cwd: FAKE_CWD,
    availableDecisions,
  });
};
