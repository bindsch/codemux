import { CodexPlainFold, OpenCodePlainFold } from "../../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../../src/process-runner.js";
import type { RunResult } from "../../src/types.js";

// The plain-run unwrap's contract: a harness launched in its structured
// mode prints its final message on stdout byte for byte as plain mode
// would have, while usage and the served model ride the RunResult for
// the call ledger. Stdout that is not the structured wire passes through
// verbatim (the escape hatch), and a recognized wire obeys the envelope
// path's verdict rules — the one lift is codex's completed messageless
// turn, which succeeds with empty stdout as human mode exited 0 for it
// (round al10, the CodexPlainFold tests).
//
// Shared fixtures of the plain-unwrap suite, split from the former
// tests/plain-unwrap.test.ts: the RunResult builders every topic file
// uses, and the opencode/codex wire-line builders the fold describes
// used to declare inline. Each fold file aliases its foldStream so the
// test bodies stay byte-identical to the original.

export function finished(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0, success: true };
}

/** The runner's capture-limit result for a latched fold, modeled exactly
 * as runCapturedCommand answers an OutputLimitError (round al37): exit
 * 125, success false, the partial output (the fold's finish()) on
 * stdout, and the Error line on stderr — the fold's own verdict never
 * runs on that path, so its break notes are not in this stderr. */
export function captureLimitResult(partial: string, stderr = ""): RunResult {
  const separator = stderr.length > 0 && !stderr.endsWith("\n") ? "\n" : "";
  return {
    stdout: partial,
    stderr: `${stderr}${separator}Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
    exitCode: 125,
    success: false,
  };
}

// --- opencode wire builders (the opencode describes) ---

export const part = (text: string): string =>
  JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text } });

export const stepFinish = (tokens: Record<string, unknown>, cost: number | null = null): string =>
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_0123456789abcdef",
    part: { tokens, cost },
  });

export const toolUse = (output: string): string =>
  JSON.stringify({
    type: "tool_use",
    sessionID: "ses_0123456789abcdef",
    part: { id: "cal_1", tool: "read", state: { status: "completed", input: {}, output } },
  });

/** Feeds `stream` through the fold in chunks of `size` UTF-16 code units
 * — the slice bounds are code units, not bytes (round al17; a multibyte
 * character makes a chunk more bytes than units, and any grouping is
 * legal) — the way the runner's decoded chunks arrive, awkward
 * boundaries included. */
export const codexFoldStream = (stream: string, size = 7): CodexPlainFold => {
  const fold = new CodexPlainFold();
  for (let i = 0; i < stream.length; i += size) fold.push(stream.slice(i, i + size));
  return fold;
};

/** The same feed for the opencode fold. */
export const opencodeFoldStream = (stream: string, size = 7): OpenCodePlainFold => {
  const fold = new OpenCodePlainFold();
  for (let i = 0; i < stream.length; i += size) fold.push(stream.slice(i, i + size));
  return fold;
};

// --- codex wire builders (the CodexPlainFold describes) ---

export const THREAD = JSON.stringify({
  type: "thread.started",
  thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e",
});

export const turnStarted = (): string => JSON.stringify({ type: "turn.started" });

export const agentMessage = (text: string): string =>
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text },
  });

export const toolItem = (data: string): string =>
  JSON.stringify({
    type: "item.updated",
    item: { id: "i0", type: "other", data },
  });

export const rerouteItem = (from: string, to: string, reason: string): string =>
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "error", message: `model rerouted: ${from} -> ${to} (${reason})` },
  });

export const WARNING_TEXT =
  "ignored config key 'model_reasoning_effort' (not supported by this provider)";

export const warningItem = (): string =>
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "error", message: WARNING_TEXT },
  });

export const turnFailed = (message: string): string =>
  JSON.stringify({ type: "turn.failed", error: { message } });

export const turnCompleted = (usage: Record<string, number>): string =>
  JSON.stringify({ type: "turn.completed", usage });

export const USAGE_FULL = {
  input_tokens: 10,
  cached_input_tokens: 4,
  cache_write_input_tokens: 0,
  output_tokens: 6,
  reasoning_output_tokens: 0,
};

export const FULL_BLOCK = {
  input_tokens: 6,
  output_tokens: 6,
  cached_input_tokens: 4,
  total_tokens: 16,
  cost_usd: null,
};

export const completeStream = (text: string): string =>
  [THREAD, turnStarted(), agentMessage(text), turnCompleted(USAGE_FULL)].join("\n") + "\n";
