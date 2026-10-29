import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import * as runtime from "../src/cli-runtime.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { launchRunRequest } from "../src/launch.js";
import { CodexPlainFold } from "../src/plain-unwrap.js";
import { experimentFailedResult } from "../src/result-envelope/experiment.js";
import { kimiResult } from "../src/result-envelope/kimi.js";
import { emptyUsage } from "../src/result-envelope/common.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { kimiResumeHint } from "./fixtures/kimi-stream.js";

const complete = (stdout: string): RunResult => ({ stdout, stderr: "native diagnostic", exitCode: 0, success: true });
const parent = resolve("scratch/session-14c66a93/exp/envelope-task-m");

test.each([false, true])("Codex reads its fallback before failed verification and cleanup; JSON=%s", async (resultJson) => {
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "codex-"));
  const lastMessagePath = join(home, "last-message.txt");
  writeFileSync(lastMessagePath, "CAPTURED_REPLY");
  const stdout = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const fold = new CodexPlainFold();
  fold.push(stdout);
  fold.finish();
  const failure = new ExperimentFailure(Code.Protocol, "Codex rollout is missing a following token_count usage event");
  let retained: ExperimentFailure | null = null;
  let readBeforeVerification = false;
  let cleaned = false;
  const context: RunContext = { lastMessagePath, stdoutSink: fold, experimentRecording: join(home, "recording.jsonl"),
    experimentCodex: {
      fold, prepare: async () => {}, startedRecordingPath: join(home, "recording.jsonl"),
      get failureError() { return retained; },
      relay: { fail(error: ExperimentFailure) { retained ??= error; } },
      verify: async () => { readBeforeVerification = !existsSync(lastMessagePath); throw failure; },
    } as unknown as NonNullable<RunContext["experimentCodex"]> };
  const adapter = new CodexAdapter({});
  const request: RunRequest = { agent: "codex", prompt: "fixture", model: "fixture-model", resultJson,
    experimentMcp: "synthetic.json", hermetic: true, sandboxed: true, tools: "none" };
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(() => { cleaned = true; }),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.165.0"),
    spyOn(runtime, "runSandboxedWithStdin").mockResolvedValue(complete(resultJson ? stdout : "")),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(resultJson ? JSON.parse(result.stdout).result : result.stdout).toBe(resultJson ? "CAPTURED_REPLY" : "CAPTURED_REPLY\n");
    expect(readBeforeVerification).toBe(true);
    expect(cleaned).toBe(true);
    expect(result.stderr).toContain(`experiment failure [protocol]: ${failure.message}`);
    if (resultJson) expect(JSON.parse(result.stdout).codemux).toMatchObject({ failure_code: "protocol", model: "fixture-model" });
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});

test.each([false, true])("Kimi normalization and experiment failure print one diagnostic; JSON=%s", (resultJson) => {
  const request: RunRequest = { agent: "kimi", prompt: "fixture", resultJson, experimentMcp: "synthetic.json" };
  const failure = new ExperimentFailure(Code.InventoryMismatch, "foreign tool");
  const context = { experimentKimi: { foldedUsage: () => undefined,
    evidence: { wireLogPath: resolve("tests/fixtures/live/kimi-session.ndjson") } } } as unknown as RunContext;
  const stdout = '{"role":"assistant","content":"reply"}\n' +
    JSON.stringify(kimiResumeHint()) + "\n";
  const normalized = kimiResult(complete(stdout), request, ".", context, failure);
  const result = experimentFailedResult(normalized, request, "/synthetic/recording.jsonl", failure);
  const line = "codemux: experiment failure [inventory_mismatch]: foreign tool";
  expect(result.stderr).toBe(`native diagnostic\n${line}\n`);
  expect(result).toMatchObject({ success: false, exitCode: 1 });
  expect(resultJson ? JSON.parse(result.stdout).reply : result.stdout).toBe("reply\n");
});

test.each([false, true])("Kimi cleanup updates its existing failure diagnostic once; JSON=%s", (resultJson) => {
  const request: RunRequest = { agent: "kimi", prompt: "fixture", resultJson, experimentMcp: "synthetic.json" };
  const failure = new ExperimentFailure(Code.InventoryMismatch, "foreign tool");
  const diagnostic = `codemux: experiment failure [${failure.code}]: ${failure.message}`;
  const normalized = { ...complete(resultJson ? JSON.stringify({ reply: "reply\n", codemux: { agent: "kimi" } }) : "reply\n"),
    stderr: `native diagnostic\n${diagnostic}\n`, usage: emptyUsage(), reply: "reply\n" };
  const cleanupFailure = new ExperimentFailure(failure.code, `${failure.message}; cleanup failed: private-home cleanup failure`);
  const result = experimentFailedResult(normalized, request, "/synthetic/recording.jsonl", cleanupFailure);
  expect(result.stderr).toBe(`native diagnostic\n${diagnostic}; cleanup failed: private-home cleanup failure\n`);
  expect(result).toMatchObject({ success: false, exitCode: 1 });
});

test.each(["claude", "zai"] as const)("plain %s capture-limit failure extracts the reply", (agent) => {
  const result = experimentFailedResult({ ...complete(JSON.stringify({ type: "result", result: "answer" })),
    exitCode: 125, success: false }, { agent, prompt: "fixture", experimentMcp: "synthetic.json" },
  "/synthetic/recording.jsonl", new ExperimentFailure(Code.Protocol, "experiment output exceeded the capture limit"));
  expect(result).toMatchObject({ stdout: "answer\n", success: false, exitCode: 125 });
  expect(result.stderr).toContain("experiment output exceeded the capture limit");
});

test.each(["claude", "zai"] as const)("plain %s launch preserves the captured reply on exit 125", async (agent) => {
  const adapter = agent === "claude" ? new ClaudeAdapter({}) : new ZaiAdapter({});
  const request: RunRequest = { agent, prompt: "fixture", experimentMcp: "synthetic.json",
    hermetic: true, sandboxed: true, tools: "none" };
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "beforeLaunch").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue({ experimentRecording: "/synthetic/recording.jsonl" }),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(() => {}),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("2.1.280"),
    spyOn(runtime, "runSandboxedWithStdin").mockResolvedValue({
      ...complete(JSON.stringify({ type: "result", result: "answer" })), exitCode: 125, success: false }),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    expect(result).toMatchObject({ stdout: "answer\n", success: false, exitCode: 125 });
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});
