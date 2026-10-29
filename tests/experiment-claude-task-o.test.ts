import { afterEach, expect, spyOn, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import * as runtime from "../src/cli-runtime.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunRequest } from "../src/types.js";
import { cleanupPeers, peer } from "./helpers/experiment-peer.js";

afterEach(cleanupPeers);
const placeholder = { input_tokens: 0, output_tokens: 0 };
function assistant(p: ReturnType<typeof peer>, id: string, usage: object = placeholder) {
  p.push({ type: "assistant", message: { id, role: "assistant", content: [], usage } });
}
function stream(p: ReturnType<typeof peer>, type: string, fields: object = {}) {
  p.push({ type: "stream_event", event: { type, ...fields } });
}

test.each(["claude", "zai"] as const)("%s requests partial stream events only for experiment launches", (agent) => {
  const p = peer();
  const adapter = agent === "claude" ? new ClaudeAdapter({}) : new ZaiAdapter({});
  const request: RunRequest = { agent, prompt: "fixture", experimentMcp: "synthetic.json", tools: "none" };
  expect(adapter.buildRunCommand(request, { experimentBridge: p.bridge })).toContain("--include-partial-messages");
  expect(adapter.buildRunCommand({ ...request, experimentMcp: undefined })).not.toContain("--include-partial-messages");
});

test.each(["result", "message_stop", "next-message"])("Claude rejects placeholder-only usage at %s", async (ending) => {
  const p = peer();
  await p.ready();
  stream(p, "message_start", { message: { id: "missing-usage", usage: placeholder } });
  assistant(p, "missing-usage");
  const end = () => ending === "result" ? p.result() : ending === "message_stop"
    ? stream(p, "message_stop") : assistant(p, "next", { input_tokens: 2, output_tokens: 1 });
  expect(end).toThrow(expect.objectContaining({ code: Code.HarnessLogMissing }));
  expect(p.bridge.failureCode).toBe(Code.HarnessLogMissing);
  expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(0);
});

test.each(["assistant", "message_delta"])("Claude ignores later zero %s placeholders after real counters", async (source) => {
  const p = peer();
  await p.ready();
  stream(p, "message_start", { message: { id: "retained", usage: placeholder } });
  assistant(p, "retained");
  stream(p, "message_delta", { usage: { input_tokens: 25266, output_tokens: 3 } });
  if (source === "assistant") assistant(p, "retained");
  else stream(p, "message_delta", { usage: placeholder });
  stream(p, "message_stop");
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([
    { message_id: "retained", usage: { input: 25266, output: 3, cache_read: 0, cache_write: 0 } },
  ]);
  p.result();
  expect(p.bridge.finish()).toContain('"result":"OK"');
  expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(1);
});

test("Claude joins input counters from message_start with output counters from message_delta", async () => {
  const p = peer();
  await p.ready();
  stream(p, "message_start", { message: { id: "joined", usage: {
    input_tokens: 19, output_tokens: 0, cache_read_input_tokens: 7,
  } } });
  assistant(p, "joined");
  stream(p, "message_delta", { usage: { output_tokens: 4 } });
  stream(p, "message_stop");
  expect(p.records().filter((record) => record.kind === "turn")).toMatchObject([{ usage: null }]);
  expect(p.records().filter((record) => record.kind === "turn_usage")).toMatchObject([
    { message_id: "joined", usage: { input: 19, output: 4, cache_read: 7, cache_write: 0 } },
  ]);
});

test.each(["identity-change", "message_stop"])("Claude classifies a repeated completed message ID as missing usage evidence after %s", async (ending) => {
  const p = peer();
  await p.ready();
  stream(p, "message_start", { message: { id: "repeated", usage: placeholder } });
  assistant(p, "repeated", { input_tokens: 7, output_tokens: 1 });
  if (ending === "message_stop") stream(p, "message_stop");
  else assistant(p, "other", { input_tokens: 8, output_tokens: 2 });
  expect(() => assistant(p, "repeated", { input_tokens: 7, output_tokens: 1 }))
    .toThrow(expect.objectContaining({ code: Code.HarnessLogMissing }));
  expect(p.bridge.failureCode).toBe(Code.HarnessLogMissing);
});

test.each([placeholder, { input_tokens: 7, output_tokens: 1 }])("Claude timeout after assistant output skips final usage verification: %j", async (usage) => {
  const p = peer();
  await p.ready();
  assistant(p, "interrupted", usage);
  expect(p.bridge.finish({ timedOut: true })).toBe("");
  expect(p.bridge.failureCode).toBeNull();
  expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(0);
  await expect(p.bridge.closeProtocol()).resolves.toBeUndefined();
});

test.each([false, true])("Claude launch retains timeout exit 124 after an assistant frame; JSON=%s", async (resultJson) => {
  const p = peer();
  await p.ready();
  const adapter = new ClaudeAdapter({});
  const request: RunRequest = { agent: "claude", prompt: "fixture", resultJson, experimentMcp: "synthetic.json",
    hermetic: true, sandboxed: true, tools: "none" };
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue({ experimentBridge: p.bridge, stdoutSink: p.bridge,
      experimentRecording: p.bridge.recordingPath }),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("2.1.300"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => {
      assistant(p, "timed-out");
      return { stdout: p.bridge.finish({ timedOut: true }), stderr: "timeout", exitCode: 124, success: false };
    }),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    expect(result).toMatchObject({ exitCode: 124, success: false });
    expect(result.stderr).not.toContain("harness_log_missing");
    expect(p.bridge.failureCode).toBeNull();
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});
