// Lane AN1 (run.answer-complete) for kimi, openhands, agy, cline, and aider:
// a run's answer is every assistant text message after the last user turn,
// joined by a blank line, never only the final message. Each fake stream
// has the shape text, tool call, text, tool call, empty final message.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { AiderAdapter } from "../src/adapters/aider.js";
import { KimiPlainFold } from "../src/plain-unwrap/kimi-fold.js";
import { openhandsResult } from "../src/result-envelope/openhands.js";
import { clineResult } from "../src/result-envelope/cline.js";
import { agyResult } from "../src/result-envelope/agy.js";
import { aiderReportedLengthStop } from "../src/result-envelope/aider.js";
import { truncationLine } from "../src/answer-complete.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./fixtures/kimi-stream.js";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });
const lines = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const FULL = "Findings 1 to 19.\n\nFinding 20.";

describe("kimi", () => {
  const events = [
    { role: "meta", type: "system.version", version: "2.3.2" },
    { role: "assistant", content: "Findings 1 to 19.\n", tool_calls: [{ type: "function", id: "c1", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "file" },
    { role: "assistant", content: "Finding 20.", tool_calls: [{ type: "function", id: "c2", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c2", content: "file" },
    { role: "assistant", tool_calls: [{ type: "function", id: "c3", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c3", content: "file" },
    kimiResumeHint(),
  ];

  function fixture(resultJson: boolean) {
    const scratch = join(import.meta.dir, "../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(join(scratch, "kimi-answer-"));
    const brand = join(home, ".kimi-code");
    mkdirSync(brand);
    const adapter = new KimiAdapter({ HOME: home }, home);
    const request: RunRequest = { agent: "kimi", prompt: "p", model: "m", resultJson };
    const context = adapter.prepareRun(request);
    const wire = join(brand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl");
    mkdirSync(dirname(wire), { recursive: true });
    writeFileSync(wire, lines([{ type: "usage.record", usageScope: "turn", usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }]));
    return { adapter, request, context, cleanup: () => { adapter.cleanupRunSync(context); rmSync(home, { recursive: true, force: true }); } };
  }

  test("--result-json carries every assistant message; final_message is the empty last one", () => {
    const f = fixture(true);
    try {
      const result = f.adapter.processRunResult(ok(lines(events)), f.request, f.context);
      expect(result.success).toBe(true);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.reply).toBe(`${FULL}\n`);
      expect(envelope.codemux.final_message).toBe("");
      expect(envelope.codemux.truncated).toBe(false);
    } finally { f.cleanup(); }
  });

  test("a plain run through the fold prints the whole answer", () => {
    const f = fixture(false);
    try {
      const fold = new KimiPlainFold();
      fold.push(lines(events));
      const result = f.adapter.processRunResult(ok(fold.finish()), f.request, { ...f.context, stdoutSink: fold });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe(`${FULL}\n`);
    } finally { f.cleanup(); }
  });
});

describe("openhands", () => {
  const thought = (text: string, id: string) => ({ kind: "ActionEvent", source: "agent", llm_response_id: id,
    thought: text === "" ? [] : [{ type: "text", text }], tool_name: "terminal", action: { kind: "ExecuteBashAction", command: "ls" } });
  const wire = lines([
    { kind: "MessageEvent", source: "user", llm_message: { content: [{ type: "text", text: "the prompt" }] } },
    thought("Findings 1 to 19.", "r1"),
    { kind: "ObservationEvent", source: "environment", observation: { content: "ok" } },
    thought("Finding 20.", "r2"),
    { kind: "ObservationEvent", source: "environment", observation: { content: "ok" } },
    thought("", "r3"),
    { kind: "ObservationEvent", source: "environment", observation: { content: "ok" } },
    { kind: "MessageEvent", source: "agent", llm_message: { content: [] } },
  ]);
  const request: RunRequest = { agent: "openhands", prompt: "p", resultJson: true };

  test("--result-json carries every thought and message; final_message is the empty last one", () => {
    const envelope = JSON.parse(openhandsResult(ok(wire), request).stdout);
    expect(envelope.llm_message).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("a plain run launches on the --json wire and prints the whole answer", () => {
    const adapter = new OpenHandsAdapter({});
    expect(adapter.buildRunCommand({ agent: "openhands", prompt: "p" })).toContain("--json");
    const result = adapter.processRunResult(ok(wire), { agent: "openhands", prompt: "p" });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe(`${FULL}\n`);
  });

  test("a finish-tool message is part of the answer and the final message", () => {
    const finish = lines([
      thought("Findings 1 to 19.", "r1"),
      { kind: "ActionEvent", source: "agent", llm_response_id: "r2", thought: [], tool_name: "finish",
        action: { kind: "FinishAction", message: "Finding 20." } },
    ]);
    const envelope = JSON.parse(openhandsResult(ok(finish), request).stdout);
    expect(envelope.llm_message).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("Finding 20.");
  });

  test("a plain run with no wire keeps the startup verdict", () => {
    const adapter = new OpenHandsAdapter({});
    const result = adapter.processRunResult(ok("plain text\n"), { agent: "openhands", prompt: "p" });
    expect(result.stdout).toBe("plain text\n");
  });
});

describe("cline", () => {
  const agent = (event: unknown) => ({ type: "agent_event", event });
  const wire = (finishReason = "completed") => lines([
    { type: "run_start", sessionId: "s1" },
    agent({ type: "iteration_start", iteration: 1 }),
    agent({ type: "content_start", contentType: "text", text: "Findings 1 to 19." }),
    agent({ type: "content_end", contentType: "text", text: "Findings 1 to 19." }),
    agent({ type: "content_start", contentType: "tool", toolName: "read_files" }),
    agent({ type: "iteration_end", iteration: 1, hadToolCalls: true }),
    agent({ type: "iteration_start", iteration: 2 }),
    agent({ type: "content_end", contentType: "text", text: "Finding 20." }),
    agent({ type: "iteration_end", iteration: 2, hadToolCalls: true }),
    agent({ type: "iteration_start", iteration: 3 }),
    agent({ type: "content_start", contentType: "tool", toolName: "read_files" }),
    agent({ type: "iteration_end", iteration: 3, hadToolCalls: true }),
    { type: "run_result", finishReason, text: "", usage: {}, model: { id: "m" } },
  ]);

  test("--result-json carries every message; final_message is the empty last one", () => {
    const result = clineResult(ok(wire()), { agent: "cline", prompt: "p", resultJson: true });
    expect(result.success).toBe(true);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.text).toBe(FULL);
    expect(envelope.codemux.final_message).toBe("");
    expect(envelope.codemux.truncated).toBe(false);
  });

  test("a plain run prints the whole answer where run_result.text was empty", () => {
    const result = clineResult(ok(wire()), { agent: "cline", prompt: "p" });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe(FULL);
  });

  test("a stream without agent events falls back to run_result.text", () => {
    const stdout = lines([{ type: "run_result", finishReason: "completed", text: "only", usage: {} }]);
    const envelope = JSON.parse(clineResult(ok(stdout), { agent: "cline", prompt: "p", resultJson: true }).stdout);
    expect(envelope.text).toBe("only");
    expect(envelope.codemux.final_message).toBe("only");
  });
});

describe("agy (declared limitation)", () => {
  test("the response is both the answer and the final message", () => {
    const stdout = JSON.stringify({ status: "SUCCESS", response: "Finding 20.", usage: {} });
    const envelope = JSON.parse(agyResult(ok(stdout), { agent: "agy", prompt: "p", resultJson: true }).stdout);
    expect(envelope.response).toBe("Finding 20.");
    expect(envelope.codemux).toMatchObject({ final_message: "Finding 20.", truncated: false });
  });
});

describe("aider", () => {
  test("plain stdout is the whole transcript and passes through with every response", () => {
    const transcript = "Findings 1 to 19.\n\nApplied edit to a.py\n\nFinding 20.\n";
    const result = new AiderAdapter({}).processRunResult(ok(transcript), { agent: "aider", prompt: "p" });
    expect(result.stdout).toBe(transcript);
    expect(result.stderr).toBe("");
  });

  test("a token-limit report sets the truncation line", () => {
    const stdout = "partial answer\n\nModel openai/m has hit a token limit!\nToken counts below are approximate.\n";
    expect(aiderReportedLengthStop(stdout)).toBe(true);
    expect(aiderReportedLengthStop("the model has hit a token limit! in prose")).toBe(false);
    const result = new AiderAdapter({}).processRunResult(ok(stdout), { agent: "aider", prompt: "p" });
    expect(result.stderr).toBe(`${truncationLine("aider")}\n`);
  });
});
