import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentCodexEvidence, type CodexEvidenceRelay } from "../src/experiment-codex.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

const THREAD = "12345678-1234-4234-8234-123456789abc";
const timestamp = "2026-10-29T01:02:03.125Z";
const usage = { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2 };
type Entry = Record<string, any>;
const line = (type: string, payload: Entry) => ({ timestamp, type, payload });
const token = () => line("event_msg", { type: "token_count", info: { last_token_usage: usage } });
const unknown = (extra: Entry = {}) => line("response_item", { type: "function_call", id: "fc_bad", call_id: "bad",
  namespace: "weather", name: "forecast", arguments: '{"seconds":1}', ...extra });
const output = (value: unknown, extra: Entry = {}) => line("response_item", {
  type: "function_call_output", call_id: "bad", output: value, ...extra });

function fixture(entries: Entry[], builtins: Entry[] = []) {
  const parent = resolve("scratch/session-14c66a93/exp/codex-task-t");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const dir = join(home, "sessions", "2026", "10", "29");
  mkdirSync(dir, { recursive: true });
  const catalog = codexCatalog(["clock__wait"]);
  catalog.payload.tools.push(...builtins);
  writeFileSync(join(dir, `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`),
    [line("session_meta", { id: THREAD }), catalog, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const records: Entry[] = [];
  const relay: CodexEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["codex-wall-time"] },
    toolNames: new Set(["clock__wait"]), toolDefinitions: codexDefinitions(["clock__wait"]), calls: [],
    record(kind, fields) { records.push({ kind, ...fields }); } };
  const evidence = new ExperimentCodexEvidence(relay);
  evidence.accept({ type: "thread.started", thread_id: THREAD });
  return { home, records, evidence, relay };
}

describe("Codex model tool errors", () => {
  test.each([{ harness_output: "unsupported call: weatherforecast" },
    { harness_output: [{ type: "input_text", text: "unsupported call: weatherforecast" }] }])(
    "allows a hallucinated name with the harness's own error %j", ({ harness_output }) => {
      const { home, records, evidence } = fixture([unknown(), output(harness_output), token(),
        line("response_item", { type: "message", role: "assistant", id: "msg_after", content: [] }), token()]);
      expect(() => evidence.finish(home)).not.toThrow();
      expect(records.filter((record) => record.kind === "model_tool_error")).toEqual([
        { kind: "model_tool_error", call_id: "bad", name: "weather.forecast", input: { seconds: 1 }, harness_output },
      ]);
      expect(records.filter((record) => record.kind === "turn")).toHaveLength(2);
    });

  test("does not shift the correlation of the following experiment call", () => {
    const { home, records, evidence, relay } = fixture([unknown(), output("unsupported call: weatherforecast"), token(),
      unknown({ id: "fc_good", call_id: "good", namespace: "mcp__experiment", name: "clock__wait", arguments: "{}" }),
      output("Wall time: 0.0001 seconds\nOutput:\nfinished", { call_id: "good" }), token()]);
    relay.calls.push({ relay_index: 0, call_id: "good", name: "clock__wait", input: {},
      result: { content: [{ type: "text", text: "finished" }] } });
    evidence.accept({ type: "item.completed", item: { type: "mcp_tool_call", call_id: "good", server: "experiment",
      tool: "clock__wait", arguments: {}, status: "completed", error: null,
      result: { content: [{ type: "text", text: "finished" }] } } });
    expect(() => evidence.finish(home)).not.toThrow();
    expect(records.find((record) => record.kind === "result_comparison")).toMatchObject({ call_id: "good", equal: true });
  });

  test.each(["update_plan", "apply_patch", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])(
    "keeps built-in %s blocked even with an error result", (name) => {
      const { home, evidence } = fixture([unknown({ namespace: "functions", name }),
        output(`unsupported call: functions.${name}`), token()]);
      expect(() => evidence.finish(home)).toThrow("outside the experiment set");
    });

  test.each([undefined, "functions"])("accepts a flattened unknown name in namespace %j", (namespace) => {
    const { home, evidence, records } = fixture([unknown({ namespace, name: "weather.forecast" }),
      output("unsupported call: weather.forecast"), token()]);
    expect(() => evidence.finish(home)).not.toThrow();
    expect(records.find((record) => record.kind === "model_tool_error")).toMatchObject({
      name: namespace ? "functions.weather.forecast" : "weather.forecast", harness_output: "unsupported call: weather.forecast" });
  });

  test.each(["functions.apply_patch", "functions.read_mcp_resource", "functions.update_plan"])(
    "blocks a flattened built-in name %s", (name) => {
      const { home, evidence } = fixture([unknown({ namespace: undefined, name }), output(`unsupported call: ${name}`), token()]);
      expect(() => evidence.finish(home)).toThrow("outside the experiment set");
    });

  test("blocks a declared optional built-in", () => {
    const { home, evidence } = fixture([unknown({ namespace: "clock", name: "sleep" }), output("unsupported call: clock.sleep"), token()], [
      { type: "namespace", name: "clock", tools: [{ type: "function", name: "sleep" }] },
    ]);
    expect(() => evidence.finish(home)).toThrow("outside the experiment set");
  });

  test("blocks a flattened built-in even with a declared namespace tool", () => {
    const { home, evidence } = fixture([unknown({ namespace: undefined, name: "clock.sleep" }),
      output("unsupported call: clock.sleep"), token()], [
      { type: "namespace", name: "clock", tools: [{ type: "function", name: "sleep" }] },
    ]);
    expect(() => evidence.finish(home)).toThrow("outside the experiment set");
  });

  test.each([undefined, "a successful result", "unsupported call: clock.other"])(
    "requires the matching native error result %j", (value) => {
      const { home, evidence, records } = fixture([unknown(), ...(value === undefined ? [] : [output(value)]), token()]);
      expect(() => evidence.finish(home)).toThrow("outside the experiment set");
      expect(records.filter((record) => record.kind === "model_tool_error")).toHaveLength(0);
    });

  test("accepts an unknown custom tool with its matching native error", () => {
    const { home, evidence, records } = fixture([unknown({ type: "custom_tool_call", namespace: undefined, name: "invented", input: "raw" }),
      output("unsupported custom tool call: invented", { type: "custom_tool_call_output" }), token()]);
    expect(() => evidence.finish(home)).not.toThrow();
    expect(records.find((record) => record.kind === "model_tool_error")).toMatchObject({ name: "invented", input: "raw" });
  });

  test.each(["function_call", "custom_tool_call"])("rejects the wrong output kind for %s", (type) => {
    const custom = type === "custom_tool_call";
    const { home, evidence } = fixture([unknown({ type, namespace: undefined, name: "invented", input: "raw" }),
      output(custom ? "unsupported custom tool call: invented" : "unsupported call: invented",
        { type: custom ? "function_call_output" : "custom_tool_call_output" }), token()]);
    expect(() => evidence.finish(home)).toThrow("output type");
  });

  test.each([undefined, 12])("rejects malformed custom input %j", (input) => {
    const { home, evidence } = fixture([unknown({ type: "custom_tool_call", namespace: undefined, name: "invented", input }),
      output("unsupported custom tool call: invented", { type: "custom_tool_call_output" }), token()]);
    expect(() => evidence.finish(home)).toThrow("input");
  });

  test.each([undefined, 12, {}])("rejects malformed function arguments %j", (arguments_) => {
    const { home, evidence } = fixture([unknown({ arguments: arguments_ }), output("unsupported call: weatherforecast"), token()]);
    expect(() => evidence.finish(home)).toThrow("arguments");
  });

  test("rejects a malformed namespace", () => {
    const { home, evidence } = fixture([unknown({ namespace: 1 }), output("unsupported call: 1forecast"), token()]);
    expect(() => evidence.finish(home)).toThrow("namespace");
  });

  test("keeps experiment tools out of the unknown custom error path", () => {
    const { home, evidence } = fixture([unknown({ type: "custom_tool_call", namespace: "mcp__experiment", name: "clock__wait", input: "raw" }),
      output("unsupported custom tool call: mcp__experimentclock__wait", { type: "custom_tool_call_output" }), token()]);
    expect(() => evidence.finish(home)).toThrow("outside the experiment set");
  });
});
