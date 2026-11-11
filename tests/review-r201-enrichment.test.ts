import { expect, test } from "bun:test";
import { PiAdapter } from "../src/adapters/pi.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { piBudgetResult } from "../src/pi-budget.js";
import { geminiStreamResult } from "../src/result-envelope/gemini.js";
import { qwenExperimentResult } from "../src/qwen-experiment-run.js";
import { emptyUsage } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "../src/process-runner.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunResult } from "../src/types.js";

const raw = (events: unknown[]): RunResult => ({ success: true, exitCode: 0, stderr: "",
  stdout: events.map((event) => JSON.stringify(event)).join("\n") + "\n" });
const pi = (answer: string) => raw([{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }],
  model: "served", stopReason: "stop", usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.2 } } } }]);
const gemini = (answer: string) => raw([{ type: "init", session_id: "synthetic", model: "m" },
  { type: "message", role: "assistant", content: answer, delta: true },
  { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 2 } }]);
const qwen = (answer: string) => raw([{ type: "system", subtype: "init", session_id: "synthetic" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
  { type: "result", subtype: "success", result: answer, session_id: "synthetic", usage: { input_tokens: 1, output_tokens: 2 } }]);

const cases: [string, (recording: string, answer: string) => RunResult][] = [
  ["Pi experiment", (experimentRecording, answer) => new PiAdapter({}).processRunResult(pi(answer),
    { agent: "pi", prompt: "p", resultJson: true, experimentMcp: "synthetic" }, { experimentRecording })],
  ["Pi budget", (experimentRecording, answer) => piBudgetResult(pi(answer),
    { agent: "pi", prompt: "p", resultJson: true }, { experimentRecording })],
  ["Copilot experiment", (recordingPath, answer) => new CopilotAdapter({}).processRunResult(
    raw([{ type: "assistant.message", data: { content: answer } }]),
    { agent: "copilot", prompt: "p", resultJson: true },
    { experimentCopilot: { usage: emptyUsage(), recordingPath, capturedOutput: "wire" } } as unknown as RunContext)],
  ["Gemini experiment", (recording, answer) => geminiStreamResult(gemini(answer), { agent: "gemini", prompt: "p", resultJson: true }, recording)],
  ["Qwen experiment", (recording, answer) => qwenExperimentResult(qwen(answer), { agent: "qwen", prompt: "p", resultJson: true }, recording)],
];

test.each(cases)("%s bounds the final envelope after adding recording metadata", (_name, run) => {
  // Account for repeated answer fields, then leave only 32 bytes free.
  // An ordinary recording path, rather than an oversized path, crosses it.
  const small = run("r", "x").stdout.length;
  const copies = run("r", "xx").stdout.length - small;
  expect(copies).toBeGreaterThan(0);
  const answer = "x".repeat(1 + Math.floor((MAX_CAPTURE_BYTES - small - 32) / copies));
  const within = run("r", answer);
  expect(within.stdout.length).toBeGreaterThan(MAX_CAPTURE_BYTES - 64);
  expect(JSON.parse(within.stdout).codemux.recording).toBe("r");
  const overflow = run(`scratch/${"recording-".repeat(12)}.jsonl`, answer);
  expect(overflow).toMatchObject({ success: false, exitCode: OUTPUT_LIMIT_EXIT_CODE, stdout: "" });
  expect(overflow.stderr).toContain("capture bound");
  expect(overflow.usage).toEqual(within.usage);
});

test.each(["gemini", "qwen"] as const)("%s plain extraction preserves an output-bound refusal", (agent) => {
  const answer = "x".repeat(MAX_CAPTURE_BYTES + 1);
  const request = { agent, prompt: "p" };
  const result = agent === "gemini"
    ? geminiStreamResult(raw([{ type: "init", session_id: "synthetic", model: "m" },
      { type: "message", role: "assistant", content: answer, delta: true },
      { type: "result", status: "success" }]), request)
    : qwenExperimentResult(raw([{ type: "system", subtype: "init", session_id: "synthetic" },
      { type: "result", subtype: "success", result: answer, session_id: "synthetic" }]), request, "recording");
  expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
  expect(result.stdout.length).toBe(0);
});
