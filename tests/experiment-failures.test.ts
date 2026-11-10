import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import * as runtime from "../src/cli-runtime.js";
import * as callLog from "../src/call-log.js";
import * as records from "../src/experiment-records.js";
import { launchRunRequest } from "../src/launch.js";
import { CapturedRunFailure, MAX_CAPTURE_BYTES } from "../src/process-runner.js";
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
      // F48 m1: an exit-0 run with an empty answer (docs/experiment-mcp.md).
      EmptyAnswer: "empty_answer",
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
    spyOn(adapter, "cleanupRun").mockImplementation(async () => {
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
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "first message\n\nfinal message", codemux: {
    failure_code: "server_error", usage: { input_tokens: 200 }, final_message: "final message" } });
});

test("the failure result keeps the prefix's deliberate null served model over a stale raw value (round 361, item 15)", () => {
  // A truncated codex stream whose valid prefix carries no reroute item
  // is the prefix reducer's considered "no attribution" verdict: null.
  // The attribution chain used `??`, which read that null as absent and
  // fell through to an earlier raw value — unreachable with current
  // callers (a raw result carries no servedModel), a first-vs-last-wins
  // trap for a caller that passes one. The null must survive: the block
  // reports the selection as `model` and no served model, and the
  // returned result does not resurrect the stale value.
  const request: RunRequest = { agent: "codex", model: "requested-model", prompt: "fixture", resultJson: true };
  const truncated = CODEX_EVENTS + '{"type":"turn.compl';
  const raw: RunResult = { stdout: truncated, stderr: "", exitCode: 0, success: true, servedModel: "stale-model" };
  const result = experimentFailedResult(raw, request, "/synthetic/recording.jsonl",
    new records.ExperimentFailure(records.ExperimentFailureCode.ServerError, "server exited"));
  const block = JSON.parse(result.stdout).codemux;
  expect(block.model).toBe("requested-model");
  expect(block.served_model).toBeNull();
  expect(result.servedModel).toBeNull();
});

test("an oversized non-codex failure envelope is refused at the capture bound; one at the bound still goes out (round 127)", () => {
  // The non-codex arm of experimentFailedResult re-serializes the whole
  // processed envelope with its block rewritten, so a reply that fit before
  // can pass the bound after. The final serialization is measured in bytes
  // with its newline; past the bound the envelope is dropped, and the reply
  // text is sized from a probe so both cases are exact.
  const request: RunRequest = { agent: "claude", prompt: "fixture", resultJson: true };
  const failure = new records.ExperimentFailure(records.ExperimentFailureCode.ServerError, "server exited");
  const usage = { input_tokens: 24114, output_tokens: 98, cached_input_tokens: 320,
    total_tokens: 24532, cost_usd: 0.12735 };
  // A processed claude envelope that already carries its codemux block: the
  // shape a later cleanup failure reports over (the guard at the top of
  // experimentFailedResult requires a normalized result).
  const normalized = (text: string): RunResult => ({
    stdout: JSON.stringify({ type: "result", subtype: "success", result: text,
      codemux: { agent: "claude", labels: null, model: "claude-opus-5", served_model: "claude-opus-5",
        usage, session_id: null, recording: null, failure_code: null } }),
    stderr: "", exitCode: 0, success: true, usage, servedModel: "claude-opus-5",
  });
  const probe = experimentFailedResult(normalized("OK"), request, "/synthetic/recording.jsonl", failure);
  const replyLength = MAX_CAPTURE_BYTES - Buffer.byteLength(probe.stdout) + "OK".length;
  const oversized = "a".repeat(replyLength + 1);
  const atBound = experimentFailedResult(normalized(oversized.slice(0, -1)), request,
    "/synthetic/recording.jsonl", failure);
  expect(Buffer.byteLength(atBound.stdout)).toBe(MAX_CAPTURE_BYTES);
  // A failure result either way; at the bound the envelope goes out and the
  // exit is the failure's own, not the refusal's.
  expect(atBound.success).toBe(false);
  expect(atBound.exitCode).toBe(1);
  expect(atBound.stderr).not.toContain("capture bound");
  const past = experimentFailedResult(normalized(oversized), request, "/synthetic/recording.jsonl", failure);
  expect(past.stdout).toBe("");
  expect(past.success).toBe(false);
  expect(past.exitCode).toBe(125);
  expect(past.stderr).toContain(
    `claude result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`
  );
  expect(past.stderr).toContain("codemux: experiment failure [server_error]: server exited");
  // The tokens were spent: the refusal keeps the usage.
  expect(past.usage).toEqual(usage);
});

test("a raw Claude envelope refused at the bound during normalization stays refused in the failure result (round 130)", () => {
  // The raw envelope fits the capture bound; adding the codemux block
  // carries it past. Normalization refuses it, and the failure result must
  // not turn that into an ordinary failure with a rebuilt small envelope.
  const request: RunRequest = { agent: "claude", prompt: "fixture", resultJson: true };
  const failure = new records.ExperimentFailure(records.ExperimentFailureCode.ServerError, "server exited");
  const head = JSON.stringify({ ...JSON.parse(CLAUDE_ENVELOPE), result: "" });
  const envelope = JSON.stringify({ ...JSON.parse(CLAUDE_ENVELOPE), result: "a".repeat(MAX_CAPTURE_BYTES - Buffer.byteLength(head)) });
  expect(Buffer.byteLength(envelope)).toBe(MAX_CAPTURE_BYTES);
  const result = experimentFailedResult(finished(envelope), request, "/synthetic/recording.jsonl", failure);
  expect(result.stdout).toBe("");
  expect(result.success).toBe(false);
  expect(result.exitCode).toBe(125);
  expect(result.stderr).toContain(
    `claude result envelope exceeds the ${MAX_CAPTURE_BYTES}-byte capture bound once JSON-escaped; the reply is dropped`
  );
  expect(result.stderr).toContain("codemux: experiment failure [server_error]: server exited");
  // The tokens were spent: the usage the envelope reported is kept.
  expect(result.usage?.input_tokens).toBe(24114);
  // The launch normalizes before cleanup: a cleanup failure then arrives
  // with the result already refused (review round 131). It stays refused,
  // and the bound line is not repeated.
  const processed = claudeFamilyResult(finished(envelope), request, "claude");
  expect(processed.stdout).toBe("");
  expect(processed.exitCode).toBe(125);
  const later = experimentFailedResult(processed, request, "/synthetic/recording.jsonl", failure);
  expect(later.stdout).toBe("");
  expect(later.exitCode).toBe(125);
  expect(later.stderr.split("capture bound once JSON-escaped").length - 1).toBe(1);
  expect(later.stderr).toContain("codemux: experiment failure [server_error]: server exited");
  expect(later.usage?.input_tokens).toBe(24114);
});

test("a Codex failure envelope is bounded by truncation, never refused, whatever the recording is (round 130)", () => {
  // A failed codex run reports a null result, so the only thing that can
  // carry its failure envelope past the bound is oversized metadata: a
  // reroute that names a 9 MiB model lands in both model fields.
  const request: RunRequest = { agent: "codex", prompt: "fixture", resultJson: true };
  const failure = new records.ExperimentFailure(records.ExperimentFailureCode.ServerError, "server exited");
  const huge = "m".repeat(9 * 1024 * 1024);
  const stream = [
    { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: `model rerouted: gpt-5.3 -> ${huge} (Unavailable)` } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } },
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  for (const recording of [null, "/synthetic/recording.jsonl"]) {
    const result = experimentFailedResult(finished(stream), request, recording, failure);
    expect(result.stdout).not.toBe("");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    const parsed = JSON.parse(result.stdout) as { codemux: { failure_code: string; model: string | null; served_model: string | null } };
    expect(parsed.codemux.failure_code).toBe("server_error");
    expect(parsed.codemux.model).toBeNull();
    expect(parsed.codemux.served_model).toBeNull();
    expect(result.servedModel).toBeNull();
    expect(result.stderr).toContain("codemux: result truncated to the 16 MiB capture limit");
    expect(result.stderr).not.toContain("capture bound once JSON-escaped");
  }
});

test("a multi-line failure diagnostic replaces its earlier copy whole, continuation lines included (round 401, item 7)", () => {
  // The de-dup filter used to drop only the first line of the earlier
  // diagnostic; a failure message containing a newline left its
  // continuation lines behind, and appending the full diagnostic again
  // duplicated the tail. The whole block now goes, line by line, and one
  // copy is appended at the end.
  const request: RunRequest = { agent: "codex", prompt: "fixture", resultJson: true };
  const failure = new records.ExperimentFailure(records.ExperimentFailureCode.ServerError, "server exited\nmid-shutdown");
  const diagnostic = "codemux: experiment failure [server_error]: server exited\nmid-shutdown";
  const raw: RunResult = { stdout: CODEX_EVENTS, stderr: `harness diagnostic\n${diagnostic}\n`, exitCode: 0, success: true };
  const result = experimentFailedResult(raw, request, "/synthetic/recording.jsonl", failure);
  expect(result.stderr).toBe(`harness diagnostic\n${diagnostic}\n`);
});
