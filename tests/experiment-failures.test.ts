import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import * as runtime from "../src/cli-runtime.js";
import * as callLog from "../src/call-log.js";
import * as records from "../src/experiment-records.js";
import { launchRunRequest } from "../src/launch.js";
import { CapturedRunFailure } from "../src/process-runner.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import type { RunContext } from "../src/run-context.js";
import { agyResult, claudeFamilyResult, codexResult } from "../src/result-envelope.js";
import { experimentFailedResult } from "../src/result-envelope/experiment.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { AGY_SUCCESS_ENVELOPE, CLAUDE_ENVELOPE, CODEX_EVENTS, finished } from "./helpers/result-envelope.js";
import { cleanupPeers, peer } from "./helpers/experiment-peer.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

afterEach(cleanupPeers);
test.each([false, true])("Claude synchronous exit records one failure before run_end; priorFailure=%s", async (priorFailure) => {
  const p = peer();
  await p.ready();
  const code = priorFailure ? records.ExperimentFailureCode.ResultChanged : records.ExperimentFailureCode.Protocol;
  const message = priorFailure ? "synthetic changed result" : "process exited before asynchronous experiment cleanup completed";
  if (priorFailure) p.bridge.fail(new records.ExperimentFailure(code, message));
  p.bridge.closeSync(); p.bridge.closeSync();
  const log = p.records();
  expect(log.filter((entry) => entry.kind === "failure")).toEqual([
    expect.objectContaining({ code, message }),
  ]);
  expect(log.at(-1)).toMatchObject({ kind: "run_end", code, error: message });
  expect(log.findIndex((entry) => entry.kind === "failure")).toBeLessThan(log.length - 1);
});

test.each([undefined, null, [], "missing", {}, { input_tokens: 5 }, { output_tokens: 2 }].map((usage) => ({ usage })))("Claude refuses unknown first-frame usage instead of recording zeros: %j", async ({ usage }) => {
  const p = peer();
  await p.ready();
  expect(() => p.push({ type: "assistant", message: { id: "native-message", role: "assistant", content: [], usage } }))
    .toThrow(expect.objectContaining({ code: records.ExperimentFailureCode.HarnessLogMissing }));
  expect(p.records().filter((record) => record.kind === "turn_usage")).toHaveLength(0);
});

test("Codex refuses repeated native turn IDs instead of emitting ambiguous usage", () => {
  const parser = new CodexRolloutParser("thread-test", "experiment", () => new Set(["bash"]), () => {}, () => []);
  const line = (type: string, payload: object) => ({ timestamp: "2026-10-29T01:58:00.000Z", type, payload });
  const message = line("response_item", { type: "message", role: "assistant", id: "same", content: [] });
  parser.accept(message);
  parser.accept(line("event_msg", { type: "token_count", info: { last_token_usage: {
    input_tokens: 10, output_tokens: 2, cached_input_tokens: 0,
  } } }));
  expect(() => parser.accept(message)).toThrow(expect.objectContaining({ code: records.ExperimentFailureCode.HarnessLogMissing }));
});

const api = records as unknown as {
  ExperimentFailureCode: Record<string, string>;
  ExperimentFailure: new (code: string, message: string) => Error & { code: string };
  experimentFailure: (error: unknown) => Error & { code: string };
};

test.each([
  { type: "function_call", name: "tool_search_tool", namespace: "tool_search" },
  { type: "function_call", name: "tool_search", namespace: "tool_search" },
  { type: "tool_search_call", name: undefined, namespace: undefined },
])("Codex search call %j reports an exposure policy change with unknown_tool", ({ type, name, namespace }) => {
  const observed: Record<string, unknown>[] = [];
  const parser = new CodexRolloutParser("thread-test", "experiment", () => new Set(["bash"]),
    (kind, fields) => { observed.push({ kind, ...fields }); }, () => codexDefinitions(["bash"]));
  parser.accept(codexCatalog(["bash"]));
  observed.length = 0;
  const qualified = namespace ? `${namespace}.${name}` : type;
  expect(() => parser.accept({ timestamp: "2026-10-29T01:41:00.000Z", type: "response_item",
    payload: { type, id: "fc_1", call_id: "call_1", namespace, name,
      ...(type === "tool_search_call" ? { execution: "client", arguments: { query: "+experiment bash", limit: 1 } } :
        { arguments: '{"query":"+experiment bash","limit":1}' }) } })).toThrow(expect.objectContaining({
    code: "unknown_tool", message: "Codex offered its tool search instead of the experiment tools; " +
      "the experiment server table omits the deferred surface, so this means the exposure policy changed: " + qualified,
  }));
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ kind: "tool_call", name, namespace, allowed: false });
  expect(parser.calls).toHaveLength(0);
});

describe("experiment failure API", () => {
  test("exports the stable failure categories", () => {
    expect(api.ExperimentFailureCode).toEqual({
      CallIdUnresolved: "call_id_unresolved", ResultChanged: "result_changed", UnknownTool: "unknown_tool", CodeMode: "code_mode",
      ModelRequired: "model_required", ModelUnavailable: "model_unavailable",
      InventoryMismatch: "inventory_mismatch", HarnessLogMissing: "harness_log_missing",
      MessageIdMissing: "message_id_missing", ServerError: "server_error",
      UnsupportedResult: "unsupported_result", Protocol: "protocol",
    });
  });

  test("keeps typed failures and normalizes ordinary errors and thrown values", () => {
    expect(api.ExperimentFailure).toBeFunction();
    const error = new api.ExperimentFailure("result_changed", "changed output");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ExperimentFailure");
    expect(error.code).toBe("result_changed");
    expect(error.message).toBe("changed output");
    expect(api.experimentFailure(error)).toBe(error);
    for (const value of [new Error("plain error"), "plain error"]) {
      const normalized = api.experimentFailure(value);
      expect(normalized).toBeInstanceOf(api.ExperimentFailure);
      expect(normalized.code).toBe("protocol");
      expect(normalized.message).toBe("plain error");
    }
  });
});

test.each([
  ["claude", (raw: RunResult) => claudeFamilyResult(raw, { agent: "claude", prompt: "p" }, "claude"), CLAUDE_ENVELOPE],
  ["zai", (raw: RunResult) => claudeFamilyResult(raw, { agent: "zai", prompt: "p" }, "zai"), CLAUDE_ENVELOPE],
  ["codex", (raw: RunResult) => codexResult(raw, { agent: "codex", prompt: "p" }), CODEX_EVENTS],
  ["agy", (raw: RunResult) => agyResult(raw, { agent: "agy", prompt: "p" }), AGY_SUCCESS_ENVELOPE],
] as const)("%s result blocks default failure_code to null", (_agent, build, stdout) => {
  expect(JSON.parse(build(finished(stdout)).stdout).codemux.failure_code).toBeNull();
  const failed = build({ ...finished(stdout), exitCode: 1, success: false });
  expect(JSON.parse(failed.stdout).codemux.failure_code).toBeNull();
});

function syntheticLaunch(options: { captureFailure?: unknown; processFailure?: unknown; cleanupFailure?: unknown;
  latchedFailure?: Error; resultJson?: boolean; stdout?: string; gateFailure?: unknown;
  onFailure?: (failure: unknown) => void; exitCode?: number }) {
  const adapter = new ClaudeAdapter({});
  const request: RunRequest = { agent: "claude", prompt: "fixture", sandboxed: true,
    autonomy: "read-only", hermetic: true, tools: "none", experimentMcp: "synthetic.json",
    resultJson: options.resultJson ?? true, model: "selected-model", labels: { wf: "failure-test" } };
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue({ experimentRecording: "/synthetic/recording.jsonl",
      ...(options.latchedFailure || options.onFailure ? { experimentBridge: {
        failureError: options.latchedFailure, fail: options.onFailure ?? (() => {}),
      } as RunContext["experimentBridge"] } : {}) }),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic-harness"]),
    spyOn(runtime, "assertHarnessSupported").mockImplementation(async () => {
      if (options.gateFailure) throw options.gateFailure;
      return "2.1.280";
    }),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => {
      if (options.captureFailure) throw options.captureFailure;
      return { ...finished(options.stdout ?? CLAUDE_ENVELOPE), stderr: "harness diagnostic",
        exitCode: options.exitCode ?? 0, success: !options.exitCode };
    }),
    spyOn(adapter, "processRunResult").mockImplementation((raw, effective) => {
      if (options.processFailure) throw options.processFailure;
      return claudeFamilyResult(raw, effective, "claude", "/synthetic/recording.jsonl");
    }),
    spyOn(adapter, "cleanupRun").mockImplementation(() => {
      if (options.cleanupFailure) throw options.cleanupFailure;
    }),
  ];
  return { run: () => launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" }),
    restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

test("launch returns a typed failure envelope when capture wraps an experiment failure", async () => {
  expect(api.ExperimentFailure).toBeFunction();
  const fixture = syntheticLaunch({ captureFailure: new CapturedRunFailure(
    new api.ExperimentFailure("message_id_missing", "assistant message has no id")) });
  try {
    const result = await fixture.run();
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("codemux: experiment failure [message_id_missing]: assistant message has no id\n");
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result).toBeNull();
    expect(envelope.codemux).toMatchObject({ agent: "claude", model: "selected-model",
      labels: { wf: "failure-test" }, recording: "/synthetic/recording.jsonl", failure_code: "message_id_missing" });
    expect(envelope.codemux.usage.input_tokens).toBeNull();
  } finally { fixture.restore(); }
});

test("launch preserves a captured harness envelope when experiment processing fails", async () => {
  const fixture = syntheticLaunch({ processFailure: new Error("invalid protocol") });
  try {
    const result = await fixture.run();
    expect(result.success).toBe(false);
    expect(result.stderr).toBe("harness diagnostic\ncodemux: experiment failure [protocol]: invalid protocol\n");
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", result: "OK", codemux: {
      recording: "/synthetic/recording.jsonl", failure_code: "protocol" } });
  } finally { fixture.restore(); }
});

test("experiment timeout failure receipt uses the returned exit code", async () => {
  const receipt = spyOn(callLog, "appendCallRecord").mockImplementation(() => {});
  const fixture = syntheticLaunch({ exitCode: 124,
    processFailure: new records.ExperimentFailure(records.ExperimentFailureCode.Protocol, "timed out") });
  try {
    const result = await fixture.run();
    expect(result.exitCode).toBe(124);
    expect(result.success).toBe(false);
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(receipt.mock.calls[0]![0].exit_code).toBe(result.exitCode);
  } finally { fixture.restore(); receipt.mockRestore(); }
});

test("experiment cleanup failure overrides a successful processed envelope", async () => {
  expect(api.ExperimentFailure).toBeFunction();
  const fixture = syntheticLaunch({ cleanupFailure: new api.ExperimentFailure("server_error", "server exited") });
  try {
    const result = await fixture.run();
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("harness diagnostic\ncodemux: experiment failure [server_error]: server exited\n");
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", result: "OK", codemux: {
      model: "claude-opus-5", usage: { input_tokens: 24114 }, failure_code: "server_error" } });
  } finally { fixture.restore(); }
});

test("plain experiment failures have the same diagnostic without a JSON envelope", async () => {
  const fixture = syntheticLaunch({ captureFailure: new Error("invalid protocol"), resultJson: false });
  try {
    const result = await fixture.run();
    expect(result.success).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("codemux: experiment failure [protocol]: invalid protocol\n");
  } finally { fixture.restore(); }
});

test("a generic capture abort retains the bridge's original failure code and message", async () => {
  const fixture = syntheticLaunch({ captureFailure: new CapturedRunFailure("protocol capture aborted"),
    latchedFailure: new api.ExperimentFailure("unknown_tool", "called a built-in tool") });
  try {
    const result = await fixture.run();
    expect(result.stderr).toBe("codemux: experiment failure [unknown_tool]: called a built-in tool\n");
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("unknown_tool");
  } finally { fixture.restore(); }
});

test("a retained cleanup failure cannot leave a completed experiment successful", async () => {
  const fixture = syntheticLaunch({ latchedFailure: new api.ExperimentFailure("server_error", "server exited during cleanup") });
  try {
    const result = await fixture.run();
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("codemux: experiment failure [server_error]: server exited during cleanup\n");
  } finally { fixture.restore(); }
});

test("raw harness fields cannot impersonate the normalized failure block", async () => {
  const stdout = JSON.stringify({ ...JSON.parse(CLAUDE_ENVELOPE), codemux: { agent: "wrong", usage: { input_tokens: -1 } } });
  const fixture = syntheticLaunch({ stdout, processFailure: new Error("invalid protocol") });
  try {
    const result = await fixture.run();
    expect(JSON.parse(result.stdout).codemux).toMatchObject({ agent: "claude", model: "claude-opus-5",
      usage: { input_tokens: 24114 }, failure_code: "protocol" });
  } finally { fixture.restore(); }
});

test("setup errors are latched in the existing recording before cleanup", async () => {
  const observed: unknown[] = [];
  const fixture = syntheticLaunch({ gateFailure: new Error("version rejected"), onFailure: (error) => observed.push(error) });
  try {
    const result = await fixture.run();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ code: "protocol", message: "version rejected" });
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("protocol");
    expect(result.stderr).toBe("codemux: experiment failure [protocol]: version rejected\n");
  } finally { fixture.restore(); }
});

test("malformed harness output with a codemux property produces a minimal failure envelope", async () => {
  const fixture = syntheticLaunch({ stdout: JSON.stringify({ codemux: { agent: "wrong" } }), processFailure: new Error("invalid protocol") });
  try {
    const result = await fixture.run();
    expect(JSON.parse(result.stdout)).toMatchObject({ result: null, codemux: { agent: "claude", model: "selected-model",
      failure_code: "protocol", usage: { input_tokens: null } } });
  } finally { fixture.restore(); }
});

test("a raw Codex stream with failed verification follows Codex's failed-envelope convention", () => {
  const request: RunRequest = { agent: "codex", prompt: "fixture", resultJson: true };
  const result = experimentFailedResult(finished(CODEX_EVENTS), request, "/synthetic/recording.jsonl",
    new records.ExperimentFailure(records.ExperimentFailureCode.ResultChanged, "changed output"));
  const envelope = JSON.parse(result.stdout);
  expect(result.success).toBe(false);
  expect(envelope.result).toBeNull();
  expect(envelope.codemux).toMatchObject({ failure_code: "result_changed", recording: "/synthetic/recording.jsonl",
    usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null } });
});

test("a processed Codex envelope survives a later experiment cleanup failure", () => {
  const request: RunRequest = { agent: "codex", prompt: "fixture", resultJson: true };
  const processed = codexResult(finished(CODEX_EVENTS), request);
  const result = experimentFailedResult(processed, request, "/synthetic/recording.jsonl",
    new records.ExperimentFailure(records.ExperimentFailureCode.ServerError, "server exited"));
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "final message", codemux: {
    failure_code: "server_error", usage: { input_tokens: 200 } } });
});
