// Lane AN1 (run.answer-complete) for droid, goose, opencode, and pi: the
// answer is every assistant message after the last user turn, a blank line
// between two; the --result-json answer field carries it, codemux.final_message
// keeps the last message alone, and a length stop sets codemux.truncated.
import { describe, expect, test } from "bun:test";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter } from "../src/adapters/goose.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { OpenCodePlainFold, openCodeResultData, opencodePlainResult } from "../src/plain-unwrap.js";
import { opencodeResult } from "../src/result-envelope/opencode.js";
import { droidStreamFold } from "../src/result-envelope/droid.js";
import { gooseStreamFold } from "../src/goose-answer.js";
import { piStreamFold } from "../src/result-envelope/pi.js";
import { truncationLine } from "../src/answer-complete.js";
import type { RunRequest, RunResult } from "../src/types.js";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });
const lines = (events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const FULL = "Findings 1 to 19.\n\nFinding 20.";

describe("droid: the stream-json wire", () => {
  // text, tool call, text, tool call, empty final message: droid omits an
  // empty text block, so the run ends on a tool call and the final message
  // is "" (the tool call opens an empty message, the cursor rule).
  const stream = lines([
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "message", role: "user", id: "u1", text: "audit this" },
    { type: "message", role: "assistant", id: "a1", text: "Findings 1 to 19." },
    { type: "tool_call", id: "t1", messageId: "a1", toolName: "Read", parameters: { path: "x" } },
    { type: "tool_result", id: "t1", value: "file text" },
    { type: "message", role: "assistant", id: "a2", text: "Finding 20." },
    { type: "tool_call", id: "t2", messageId: "a2", toolName: "Read", parameters: { path: "y" } },
    { type: "tool_result", id: "t2", value: "more text" },
    { type: "completion", finalText: "Finding 20.", numTurns: 3, session_id: "s1",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  ]);
  const adapter = new DroidAdapter({});

  test("a plain run prints every assistant message", () => {
    const out = adapter.processRunResult(ok(stream), { agent: "droid", prompt: "p" });
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(`${FULL}\n`);
    expect(out.usage?.output_tokens).toBe(5);
  });

  test("--result-json carries the whole answer; final_message is empty after a closing tool call", () => {
    const out = adapter.processRunResult(ok(stream), { agent: "droid", prompt: "p", resultJson: true });
    const envelope = JSON.parse(out.stdout);
    expect(envelope.result).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
    expect(envelope.codemux.session_id).toBe("s1");
  });

  test("text after the last tool call is the final message", () => {
    const closing = stream.replace(/\{"type":"completion"/u,
      `${JSON.stringify({ type: "message", role: "assistant", id: "a3", text: "Done." })}\n{"type":"completion"`);
    const envelope = JSON.parse(adapter.processRunResult(ok(closing), { agent: "droid", prompt: "p", resultJson: true }).stdout);
    expect(envelope.result).toBe(`${FULL}\n\nDone.`);
    expect(envelope.codemux.final_message).toBe("Done.");
  });

  test("through the fold, a run that ends on a tool call reports an empty final_message", () => {
    const fold = droidStreamFold();
    // A long tool call is shed mid-line; short ones are shed whole.
    const longCall = lines([{ type: "tool_call", id: "t0", toolName: "Write", parameters: { text: "z".repeat(5000) } }]);
    for (let at = 0; at < longCall.length; at += 700) fold.push(longCall.slice(at, at + 700));
    fold.push(stream);
    const kept = fold.finish();
    expect(kept).not.toContain("parameters");
    const envelope = JSON.parse(adapter.processRunResult(ok(kept), { agent: "droid", prompt: "p", resultJson: true },
      { stdoutSink: fold }).stdout);
    expect(envelope.result).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
  });

  test("the fold keeps every marker of one shed line, not only the first", () => {
    const fold = droidStreamFold();
    const first = "CODEMUX-CANARY-0123ABCD";
    const second = "CODEMUX-CANARY-4567CDEF";
    fold.push(lines([{ type: "tool_result", id: "t1", value: `${first} ${"y".repeat(300)} ${second}` }]));
    fold.finish();
    expect(fold.droppedMarkerEvidence()).toContain(first);
    expect(fold.droppedMarkerEvidence()).toContain(second);
  });

  test("an error event fails the run", () => {
    const failed = lines([{ type: "message", role: "assistant", id: "a1", text: "partial" },
      { type: "error", source: "cli", message: "boom" }]);
    const out = adapter.processRunResult({ ...ok(failed), exitCode: 1, success: false }, { agent: "droid", prompt: "p" });
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("boom");
  });

  test("the fold sheds tool payloads but keeps their canary markers for the scan", () => {
    const fold = droidStreamFold();
    const marker = "CODEMUX-CANARY-0123ABCD";
    const big = lines([{ type: "tool_result", id: "t1", value: `${"x".repeat(200_000)} ${marker}` }]);
    for (let at = 0; at < big.length; at += 4096) fold.push(big.slice(at, at + 4096));
    fold.push(stream);
    const kept = fold.finish();
    expect(kept).not.toContain("tool_result");
    expect(fold.keptBytes()).toBeLessThan(4096);
    expect(fold.droppedMarkerEvidence()).toContain(marker);
    const out = adapter.processRunResult(ok(kept), { agent: "droid", prompt: "p" }, { stdoutSink: fold });
    expect(out.stdout).toBe(`${FULL}\n`);
    expect(out.scanSurface).toContain(marker);
  });
});

describe("goose: the stream-json wire", () => {
  const assistant = (id: string, content: unknown[], metadata: Record<string, unknown> = {}) =>
    ({ type: "message", message: { id, role: "assistant", created: 1, content, metadata } });
  const tool = (id: string) => ({ type: "message", message: { id, role: "user", created: 1,
    content: [{ type: "toolResponse", id: "t", toolResult: { status: "success", value: [] } }] } });
  const stream = (finalMeta: Record<string, unknown> = {}) => lines([
    { type: "message", message: { id: "u0", role: "user", created: 0, content: [{ type: "text", text: "audit" }] } },
    assistant("a1", [{ type: "text", text: "Findings 1 " }]),
    assistant("a1", [{ type: "text", text: "to 19." }, { type: "toolRequest", id: "t1", toolCall: {} }]),
    tool("r1"),
    assistant("a2", [{ type: "text", text: "Finding 20." }, { type: "toolRequest", id: "t2", toolCall: {} }]),
    tool("r2"),
    assistant("a3", [], finalMeta),
    { type: "complete", total_tokens: 42 },
  ]);
  const adapter = new GooseAdapter({});

  test("a plain run prints every assistant message; streamed chunks of one id join", () => {
    const out = adapter.processRunResult(ok(stream()), { agent: "goose", prompt: "p" });
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(`${FULL}\n`);
  });

  test("--result-json carries the whole answer; the empty final message stays the final message", () => {
    const out = adapter.processRunResult(ok(stream()), { agent: "goose", prompt: "p", resultJson: true });
    const envelope = JSON.parse(out.stdout);
    expect(out.success).toBe(true);
    expect(envelope.content).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("outputTokenLimitReached on the last message sets truncated and prints one stderr line", () => {
    const out = adapter.processRunResult(ok(stream({ outputTokenLimitReached: true })),
      { agent: "goose", prompt: "p", resultJson: true });
    expect(JSON.parse(out.stdout).codemux.truncated).toBe(true);
    expect(out.stderr).toBe(`${truncationLine("goose")}\n`);
  });

  test("the fold sheds user-role tool responses and notifications", () => {
    const fold = gooseStreamFold();
    fold.push(lines([{ type: "notification", extension_id: "dev", log: { message: "x".repeat(5000) } }]));
    fold.push(stream());
    const kept = fold.finish();
    expect(kept).not.toContain("toolResponse");
    expect(kept).not.toContain("notification");
    expect(adapter.processRunResult(ok(kept), { agent: "goose", prompt: "p" }).stdout).toBe(`${FULL}\n`);
  });

  test("the single-message json object still parses (sessions, older captures)", () => {
    const out = adapter.processRunResult(ok(JSON.stringify({ content: "done", session_id: "20250921_143022" })),
      { agent: "goose", prompt: "p", resultJson: true });
    const envelope = JSON.parse(out.stdout);
    expect(envelope.content).toBe("done");
    expect(envelope.codemux.final_message).toBe("done");
  });
});

describe("opencode: the --format json wire", () => {
  const SESSION = "ses_0123456789abcdefABCDEFGHIJ";
  const event = (type: string, part: Record<string, unknown>) =>
    ({ type, timestamp: 1, sessionID: SESSION, part: { sessionID: SESSION, ...part } });
  const finish = (reason: string) => event("step_finish", { type: "step-finish", reason, tokens: { input: 1, output: 1, total: 2 } });
  const call = (id: string) => event("tool_use", { id, tool: "read", state: { status: "completed", input: {}, output: "file" } });
  const stream = (lastReason = "stop") => lines([
    event("step_start", { type: "step-start" }),
    event("text", { type: "text", text: "Findings 1 to 19." }),
    call("c1"), finish("tool-calls"),
    event("step_start", { type: "step-start" }),
    event("text", { type: "text", text: "Finding 20." }),
    call("c2"), finish("tool-calls"),
    event("step_start", { type: "step-start" }),
    finish(lastReason),
  ]);
  const request: RunRequest = { agent: "opencode", prompt: "p", resultJson: true };

  test("a plain run prints every step's text, a blank line between steps", () => {
    const out = opencodePlainResult(ok(stream()));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(`${FULL}\n`);
  });

  test("the streamed fold and the captured parse agree on the split", () => {
    const fold = new OpenCodePlainFold();
    for (const piece of stream().match(/[\s\S]{1,7}/gu)!) fold.push(piece);
    expect(fold.resultData()).toEqual(openCodeResultData(stream()));
    expect(fold.resultData().finalMessage).toBe("");
  });

  test("--result-json: reply is the whole answer; final_message is the last step's text", () => {
    const envelope = JSON.parse(opencodeResult(ok(""), request, openCodeResultData(stream())).stdout);
    expect(envelope.reply).toBe(`${FULL}\n`);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("a length finish on the last step sets truncated and prints one stderr line", () => {
    const out = opencodeResult(ok(""), request, openCodeResultData(stream("length")));
    expect(JSON.parse(out.stdout).codemux.truncated).toBe(true);
    expect(out.stderr).toBe(`${truncationLine("opencode")}\n`);
    expect(opencodePlainResult(ok(stream("length"))).stderr).toBe(`${truncationLine("opencode")}\n`);
  });
});

describe("pi: the --mode json wire", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
  const end = (role: string, content: unknown[], stopReason = "toolUse") =>
    ({ type: "message_end", message: { role, content, model: "m", usage, stopReason } });
  const stream = (lastStop = "stop") => lines([
    { type: "agent_start" },
    end("user", [{ type: "text", text: "audit" }]),
    end("assistant", [{ type: "text", text: "Findings 1 to 19." }, { type: "toolCall", id: "t1", name: "read" }]),
    { type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "file" }] } },
    end("toolResult", [{ type: "text", text: "file" }]),
    end("assistant", [{ type: "text", text: "Finding 20." }, { type: "toolCall", id: "t2", name: "read" }]),
    end("toolResult", [{ type: "text", text: "file" }]),
    end("assistant", [], lastStop),
    { type: "agent_end", messages: [] },
  ]);
  const adapter = new PiAdapter({});

  test("every run launches on the json wire, plain runs included", () => {
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p" })).toContain("json");
  });

  test("a plain run prints every assistant message", () => {
    const out = adapter.processRunResult(ok(stream()), { agent: "pi", prompt: "p" });
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(`${FULL}\n`);
  });

  test("--result-json carries the whole answer; final_message keeps the empty last message", () => {
    const envelope = JSON.parse(adapter.processRunResult(ok(stream()), { agent: "pi", prompt: "p", resultJson: true }).stdout);
    expect(envelope.reply).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("a failed plain run names a plain run on stderr, not --result-json", () => {
    const plain = adapter.processRunResult(ok(stream("error")), { agent: "pi", prompt: "p" });
    expect(plain.success).toBe(false);
    expect(plain.stderr).toContain("so this run fails");
    expect(plain.stderr).not.toContain("--result-json");
    const json = adapter.processRunResult(ok(stream("error")), { agent: "pi", prompt: "p", resultJson: true });
    expect(json.stderr).toContain("so this --result-json run fails");
  });

  test("a length stop on the last message sets truncated and prints one stderr line", () => {
    const out = adapter.processRunResult(ok(stream("length")), { agent: "pi", prompt: "p", resultJson: true });
    expect(JSON.parse(out.stdout).codemux.truncated).toBe(true);
    expect(out.stderr).toBe(`${truncationLine("pi")}\n`);
  });

  test("the fold sheds deltas, tool execution, tool results, and the agent summary", () => {
    const fold = piStreamFold();
    fold.push(lines([{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "F" } }]));
    fold.push(stream());
    const kept = fold.finish();
    expect(kept).not.toContain("toolResult");
    expect(kept).not.toContain("tool_execution_end");
    expect(kept).not.toContain("agent_end");
    expect(kept).not.toContain("message_update");
    expect(adapter.processRunResult(ok(kept), { agent: "pi", prompt: "p" }).stdout).toBe(`${FULL}\n`);
  });
});
