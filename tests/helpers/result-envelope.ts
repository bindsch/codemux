import type { RunResult } from "../../src/types.js";

export const CLAUDE_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",
  result: "OK",
  usage: {
    input_tokens: 24114,
    output_tokens: 98,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 20,
  },
  total_cost_usd: 0.12735,
  modelUsage: { "claude-opus-5": {} },
});

export function finished(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0, success: true };
}

// Envelope shapes pinned against the official headless documentation
// (https://antigravity.google/docs/cli/headless) and agy 1.2.14's own JSON
// tags. agy is not logged in on this machine, so these are the docs'
// example envelopes verbatim -- a documented-schema pin, not a live capture
// (scratch/agy-headless-docs.txt).
export const AGY_SUCCESS_ENVELOPE = JSON.stringify({
  conversation_id: "055a398f-db14-4c5f-abbb-1bf03f8120a7",
  status: "SUCCESS",
  response:
    "A git rebase rewrites the commit history by transplanting a sequence of " +
    "commits onto a new base commit, imposing a strictly linear progression " +
    "of changes that eliminates arbitrary merge artifacts.\n",
  duration_seconds: 7.16,
  num_turns: 1,
  usage: {
    input_tokens: 10415,
    output_tokens: 657,
    thinking_tokens: 616,
    cache_read_tokens: 8113,
    total_tokens: 11072,
  },
});

// The docs' structured-output example: extra envelope fields are ordinary
// passthrough, and its usage counts give a second check of the arithmetic.
export const AGY_STRUCTURED_ENVELOPE = JSON.stringify({
  conversation_id: "4e502687-290c-4030-b908-5ed6c68fa5dc",
  status: "SUCCESS",
  response: '{"major":2,"minor":14,"patch":3}\n',
  duration_seconds: 4.45,
  num_turns: 1,
  structured_output: { major: 2, minor: 14, patch: 3 },
  json_schema: {
    type: "object",
    properties: {
      major: { type: "integer" },
      minor: { type: "integer" },
      patch: { type: "integer" },
    },
    required: ["major", "minor", "patch"],
  },
  usage: {
    input_tokens: 10522,
    output_tokens: 354,
    thinking_tokens: 329,
    cache_read_tokens: 8112,
    total_tokens: 10876,
  },
});

// The docs' unknown-model example: agy exits 1 and prints this envelope.
export const AGY_ERROR_ENVELOPE = JSON.stringify({
  conversation_id: "",
  status: "ERROR",
  response: "",
  error:
    'invalid model selection (--model "does-not-exist-model" --effort ""): ' +
    "model does-not-exist-model is not recognized as a known model or custom " +
    "model in settings\nAvailable models:\n  Gemini 3.6 Flash (High)\n  ...",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
});

// The docs' streaming examples wrap the same envelope one level down
// ({event: "result", result: {...}}); print mode does not, so the wrapper is
// not the envelope this parser owes -- a negative pin.
export const AGY_STREAM_WRAPPER = JSON.stringify({
  event: "result",
  result: {
    conversation_id: "4fae3a70-409d-42a4-86ea-9de206a49ff4",
    status: "ERROR",
    response: "",
    error:
      "/model is answered by the CLI itself and is unavailable with " +
      "--input-format stream-json; run it as its own --print /model invocation",
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
  },
});

// Event shapes pinned against codex-rs/exec/src/exec_events.rs at
// rust-v0.159.3 (the installed codex-cli).
export function codexStream(lines: object[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export const CODEX_EVENTS = codexStream([
  { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "item_0", type: "reasoning", text: "thinking..." },
  },
  {
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: "first message" },
  },
  {
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "final message" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 200,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    },
  },
]);
