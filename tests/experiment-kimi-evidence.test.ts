import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentKimiEvidence, kimiToolName, type KimiEvidenceRelay } from "../src/experiment-kimi.js";
import { kimiContentParts } from "../src/experiment-kimi-content.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
const INPUT = { query: "hello", nested: { answer: 42 } };
const RESULT = { content: [{ type: "text", text: "answer\n" }] };
const USAGE = { inputOther: 21, output: 3, inputCacheRead: 5, inputCacheCreation: 2 };
const TIME = 1793235723125;
const QUALIFIED = "mcp__experiment__lookup";
function loop(type: string, event: Entry = {}, time = TIME): Entry {
  return { type: "context.append_loop_event", agentId: "main", time, event: { type, ...event } };
}
function inventory(names = [QUALIFIED]): Entry {
  return { type: "llm.tools_snapshot", agentId: "main", tools: names.map((name) => ({ name, description: "test", parameters: {} })), time: TIME };
}
function call(extra: Entry = {}): Entry {
  return loop("tool.call", { uuid: "tool-uuid", turnId: "0", step: 1, stepUuid: "step-1", toolCallId: "call-1", name: QUALIFIED, args: INPUT, ...extra });
}
function end(uuid = "step-1", extra: Entry = {}): Entry { return loop("step.end", { uuid, usage: USAGE, ...extra }, TIME + 50); }
function delivered(output: unknown = "answer\n", extra: Entry = {}): Entry {
  return loop("tool.result", { parentUuid: "tool-uuid", toolCallId: "call-1", result: { output, durationMs: 25, ...extra } }, TIME + 25);
}
function message(role: string, extra: Entry = {}, meta: Entry = {}): Entry {
  return { type: "agent.message.appended", time: TIME + 1000, message: { message: { role, content: [], ...extra }, meta } };
}
function assistant(extra: Entry = {}, meta: Entry = {}): Entry {
  return message("assistant", { toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: JSON.stringify(INPUT) }], ...extra }, { source: "llm", usage: USAGE, ...meta });
}
function model(content: unknown = [{ type: "text", text: "answer\n" }]): Entry {
  return message("tool", { content, toolCallId: "call-1" }, { source: "tool" });
}
function wire(lines: Entry[] = [], options: { workspace?: string; session?: string } = {}): { home: string; path: string } {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-evidence-fixtures");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions", options.workspace ?? "workspace", options.session ?? KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : ""));
  return { home, path };
}
function complete(): Entry[] { return [inventory(), call(), delivered(), end(), assistant(), model()]; }
function fixture(lines = complete(), result: Entry = RESULT, options: { workspace?: string; session?: string; callIdTimeoutMs?: number } = {}) {
  const { home, path } = wire(lines, options);
  const records: Entry[] = [], failures: Error[] = [];
  const relay: KimiEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] }, toolNames: new Set(["lookup"]),
    get toolDefinitions() { return [...this.toolNames].map((name) => ({ name, description: "test", inputSchema: {} })); },
    calls: [{ relay_index: 0, name: "lookup", input: INPUT, result }],
    record(kind, fields) { records.push({ kind, ...fields }); } };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: home, callIdTimeoutMs: options.callIdTimeoutMs, onFailure: (error) => failures.push(error) });
  const calls = new Map(lines.filter((line) => line.event?.type === "tool.call" && line.event.name === QUALIFIED)
    .map((line) => [line.event.toolCallId, line.event]));
  for (const entry of calls.values()) evidence.accept(kimiAssistantCall(entry.toolCallId, entry.name, entry.args));
  return { home, path, relay, records, failures, evidence };
}
const kinds = (records: Entry[], kind: string): Entry[] => records.filter((record) => record.kind === kind);
function failure(f: () => unknown, code: Code): void {
  let caught: unknown; try { f(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code });
}

describe("Kimi experiment evidence", () => {
  test("discovers a wire log, correlates all outputs, and never duplicates normalized records", async () => {
    const { evidence, relay, records, path } = fixture();
    try {
      expect(await evidence.resolveCallId(relay.calls[0]!)).toBe("call-1");
      evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      evidence.accept(kimiResumeHint());
      evidence.finish(); evidence.finish();
      expect(evidence.wireLogPath).toBe(path);
      expect(kinds(records, "turn")).toEqual([{ kind: "turn", message_id: "step-1", t: TIME / 1000,
        usage: null, tool_calls: [{ call_id: "call-1", name: "lookup" }] }]);
      expect(kinds(records, "turn_call")).toEqual([{ kind: "turn_call", message_id: "step-1", call_id: "call-1", name: "lookup", t: TIME / 1000 }]);
      expect(kinds(records, "turn_usage")).toEqual([{ kind: "turn_usage", message_id: "step-1", t: (TIME + 50) / 1000,
        usage: { input: 21, output: 3, cache_read: 5, cache_write: 2 } }]);
      expect(kinds(records, "tool_result_delivered")).toEqual([{ kind: "tool_result_delivered", call_id: "call-1", t: (TIME + 25) / 1000 }]);
      expect(kinds(records, "model_tool_result")[0]).toMatchObject({
        content: [{ type: "text", text: "Wall time: 0.025 seconds\nanswer\n" }],
        wire_content: [{ type: "text", text: "answer\n" }],
      });
      expect(kinds(records, "result_comparison")).toEqual([{ kind: "result_comparison", call_id: "call-1", relay_index: 0,
        equal: true, harness_prefix: "kimi-wall-time", header: "Wall time: 0.025 seconds\n" }]);
      expect(kinds(records, "tool_call")).toHaveLength(0);
      expect(kinds(records, "tool_inventory")[0]?.tools).toEqual(inventory().tools);
      expect(kinds(records, "tool_call_identified")).toEqual([{ kind: "tool_call_identified", relay_index: 0, call_id: "call-1", name: "lookup", input: INPUT }]);
      expect(kinds(records, "harness_tool_result")[0]).toMatchObject({ tool_call_id: "call-1", content: "answer\n" });
      expect(kinds(records, "harness_loop_tool_result")).toHaveLength(1);
    } finally { evidence.stop(); }
  });
  test("keeps the native step UUID when the provider message ID arrives at step.end", () => {
    const run = fixture([inventory(), call(), delivered(), end("step-1", { messageId: "provider-1" }), assistant({}, { messageId: "provider-1" }), model()]);
    try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" }); run.evidence.finish();
      expect(kinds(run.records, "turn")[0]?.message_id).toBe("step-1");
      expect(kinds(run.records, "turn_usage")[0]?.message_id).toBe("step-1"); }
    finally { run.evidence.stop(); }
  });
  test("resolves a native ID before step.end and emits delivery and turns while the run is active", async () => {
    const run = fixture([inventory()]);
    const append = (...entries: Entry[]) => appendFileSync(run.path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const timer = setTimeout(() => {
      const raw = JSON.stringify(call()); appendFileSync(run.path, raw.slice(0, 31));
      setTimeout(() => appendFileSync(run.path, raw.slice(31) + "\n"), 60);
    }, 10);
    try {
      expect(await run.evidence.resolveCallId(run.relay.calls[0]!)).toBe("call-1");
      expect(kinds(run.records, "turn")).toEqual([{ kind: "turn", message_id: "step-1", t: TIME / 1000,
        usage: null, tool_calls: [{ call_id: "call-1", name: "lookup" }] }]);
      expect(kinds(run.records, "turn_usage")).toHaveLength(0);
      expect(kinds(run.records, "turn_call")).toHaveLength(1);
      append(delivered(), end());
      await Bun.sleep(300);
      expect(kinds(run.records, "tool_result_delivered")).toHaveLength(1);
      expect(kinds(run.records, "turn")).toHaveLength(1);
      expect(kinds(run.records, "turn_usage")).toHaveLength(1);
      append(assistant(), model());
      run.evidence.accept(kimiAssistantCall("call-1", QUALIFIED, INPUT));
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      run.evidence.finish();
      expect(kinds(run.records, "turn")).toHaveLength(1);
      expect(kinds(run.records, "turn_usage")).toHaveLength(1);
    } finally { clearTimeout(timer); run.evidence.stop(); }
  });
  test("discovers the session before the late stdout resume hint exists", async () => {
    const run = fixture([]);
    writeFileSync(run.path, "");
    const timer = setTimeout(() => appendFileSync(run.path, [inventory(), call()].map((entry) => JSON.stringify(entry)).join("\n") + "\n"), 10);
    try { expect(await run.evidence.resolveCallId(run.relay.calls[0]!)).toBe("call-1"); }
    finally { clearTimeout(timer); run.evidence.stop(); }
  });
  test("requires exactly the exposed experiment inventory", () => {
    for (const names of [[], [QUALIFIED, "Bash"], [QUALIFIED, QUALIFIED]]) {
      const run = fixture([inventory(names)]);
      try { failure(() => run.evidence.finish(), Code.InventoryMismatch); }
      finally { run.evidence.stop(); }
    }
  });
  test("refuses bare tool names that collide after Kimi sanitization", () => {
    const run = fixture([]);
    run.relay.toolNames = new Set(["a__b", "a_b"]);
    writeFileSync(run.path, JSON.stringify(inventory(["mcp__experiment__a_b"])) + "\n");
    try { failure(() => run.evidence.finish(), Code.InventoryMismatch); }
    finally { run.evidence.stop(); }
  });
  test("records and rejects a native call outside the experiment inventory", () => {
    const run = fixture([inventory(), call({ name: "Bash" })]);
    try { failure(() => run.evidence.finish(), Code.UnknownTool); expect(kinds(run.records, "tool_call")[0]?.allowed).toBe(false); }
    finally { run.evidence.stop(); }
  });
  test("requires matching names and deeply equal arguments before resolving", async () => {
    const run = fixture([inventory(), call({ args: { query: "different" } })], RESULT, { callIdTimeoutMs: 25 });
    try { await expect(run.evidence.resolveCallId(run.relay.calls[0]!)).rejects.toMatchObject({ code: Code.CallIdUnresolved }); }
    finally { run.evidence.stop(); }
  });
  test("matches reversed HTTP arrivals by native name and arguments through final verification", async () => {
    const run = fixture([]);
    run.relay.toolNames = new Set(["lookup", "another"]);
    const input = { query: "second", nested: { answer: 7 } }, output = "second answer\n", qualified = "mcp__experiment__another";
    run.relay.calls = [{ relay_index: 0, name: "another", input, result: { content: [{ type: "text", text: output }] } },
      { relay_index: 1, name: "lookup", input: { nested: { answer: 42 }, query: "hello" }, result: RESULT }];
    writeFileSync(run.path, [inventory([QUALIFIED, qualified]), call(),
      call({ uuid: "tool-2", toolCallId: "call-2", name: qualified, args: input }), delivered(),
      loop("tool.result", { parentUuid: "tool-2", toolCallId: "call-2", result: { output, durationMs: 25 } }), end(),
      assistant({ toolCalls: [{ type: "function", id: "call-1", name: QUALIFIED, arguments: JSON.stringify(INPUT) },
        { type: "function", id: "call-2", name: qualified, arguments: JSON.stringify(input) }] }), model(),
      message("tool", { content: [{ type: "text", text: output }], toolCallId: "call-2" }, { source: "tool" })]
      .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    try {
      const ids = await Promise.all(run.relay.calls.map((entry) => run.evidence.resolveCallId(entry)));
      expect(ids).toEqual(["call-2", "call-1"]);
      run.relay.calls.forEach((entry, index) => { entry.call_id = ids[index]; });
      run.evidence.accept(kimiAssistantCall("call-1", QUALIFIED, INPUT));
      run.evidence.accept(kimiAssistantCall("call-2", qualified, input));
      run.evidence.accept({ role: "tool", tool_call_id: "call-2", content: output });
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      run.evidence.finish();
      expect(kinds(run.records, "result_comparison")).toEqual([
        { kind: "result_comparison", call_id: "call-2", relay_index: 0, equal: true, harness_prefix: "kimi-wall-time", header: "Wall time: 0.025 seconds\n" },
        { kind: "result_comparison", call_id: "call-1", relay_index: 1, equal: true, harness_prefix: "kimi-wall-time", header: "Wall time: 0.025 seconds\n" },
      ]);
    }
    finally { run.evidence.stop(); }
  });
  test("waits for a matching native call when an unrelated native call arrives first", async () => {
    const run = fixture([inventory(), call({ args: { query: "different" } })]);
    const timer = setTimeout(() => appendFileSync(run.path, JSON.stringify(call({ uuid: "tool-2", toolCallId: "call-2" })) + "\n"), 10);
    try { expect(await run.evidence.resolveCallId(run.relay.calls[0]!)).toBe("call-2"); }
    finally { clearTimeout(timer); run.evidence.stop(); }
  });
  test("refuses identical concurrent native calls before assigning stateful results", async () => {
    const run = fixture([inventory(), call(), call({ uuid: "tool-2", toolCallId: "call-2" })]);
    run.relay.calls[0]!.result = { content: [{ type: "text", text: "state-1" }] };
    run.relay.calls.push({ relay_index: 1, name: "lookup", input: { nested: { answer: 42 }, query: "hello" },
      result: { content: [{ type: "text", text: "state-2" }] } });
    try {
      for (const entry of run.relay.calls) await expect(run.evidence.resolveCallId(entry)).rejects.toMatchObject({
        code: Code.CallIdUnresolved, message: expect.stringContaining("Kimi cannot carry identical concurrent calls"),
      });
      expect(kinds(run.records, "tool_call_identified")).toHaveLength(0);
      expect(kinds(run.records, "result_comparison")).toHaveLength(0);
    } finally { run.evidence.stop(); }
  });
  test("records content-only responses from content.part and their completed step", () => {
    const parts = [{ type: "think", think: "consider" }, { type: "text", text: "finished" }];
    const run = fixture([]); run.relay.calls = [];
    writeFileSync(run.path, [inventory(), ...parts.map((part) => loop("content.part", { stepUuid: "step-final", part })),
      end("step-final"), assistant({ content: parts, toolCalls: [] })].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    try { run.evidence.finish(); expect(kinds(run.records, "turn")[0]).toMatchObject({ message_id: "step-final", tool_calls: [] }); }
    finally { run.evidence.stop(); }
  });
  test("resolving the same call again emits one native identification", async () => {
    const run = fixture();
    try { await run.evidence.resolveCallId(run.relay.calls[0]!); await run.evidence.resolveCallId(run.relay.calls[0]!);
      expect(kinds(run.records, "tool_call_identified")).toHaveLength(1); }
    finally { run.evidence.stop(); }
  });
  test("bounds native ID waiting and cancels it at shutdown", async () => {
    const run = fixture([]);
    const evidence = new ExperimentKimiEvidence(run.relay, { kimiHome: run.home, callIdTimeoutMs: 25 });
    try {
      await expect(evidence.resolveCallId(run.relay.calls[0]!)).rejects.toMatchObject({ code: Code.CallIdUnresolved });
      const pending = run.evidence.resolveCallId(run.relay.calls[0]!); run.evidence.stop();
      await expect(pending).rejects.toMatchObject({ code: Code.Protocol });
    } finally { evidence.stop(); run.evidence.stop(); }
  });
  test("rejects changed model, loop, and stdout tool results", () => {
    for (const source of ["model", "loop", "stdout"]) {
      const lines = [inventory(), call(), delivered(source === "loop" ? "changed" : "answer\n"), end(), assistant(), model(source === "model" ? [{ type: "text", text: "changed" }] : undefined)];
      const run = fixture(lines);
      try {
        run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: source === "stdout" ? "changed" : "answer\n" });
        failure(() => run.evidence.finish(), Code.ResultChanged);
        expect(kinds(run.records, "result_comparison")[0]?.equal).toBe(false);
      } finally { run.evidence.stop(); }
    }
  });
  test("compares image-only framing and refuses added image preservation notices", () => {
    const result = { content: [{ type: "image", data: "YWJj", mimeType: "image/png" }] };
    const content = [{ type: "text", text: `<mcp_tool_result name="${QUALIFIED}">` },
      { type: "image_url", imageUrl: { url: "data:image/png;base64,YWJj" } }, { type: "text", text: "</mcp_tool_result>" }];
    for (const notices of [false, true]) {
      const output = notices ? [...content, { type: "text", text: "Original attachment saved at: fixture" }] : content;
      const run = fixture([inventory(), call(), delivered(output), end(), assistant(), model(output)], result);
      try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: JSON.stringify(output) });
        if (notices) failure(() => run.evidence.finish(), Code.ResultChanged); else run.evidence.finish(); }
      finally { run.evidence.stop(); }
    }
  });
  test("refuses structured result extras even when native content copies them", () => {
    for (const result of [{ ...RESULT, structuredContent: {} }, { ...RESULT, _meta: {} }]) {
      const run = fixture(complete(), result);
      try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" }); failure(() => run.evidence.finish(), Code.UnsupportedResult); }
      finally { run.evidence.stop(); }
    }
  });
  test("requires every relay call, loop delivery, stdout result, and model message", () => {
    for (const absent of ["call", "delivery", "stdout", "model", "assistant"]) {
      const lines = complete().filter((line) => absent === "call" ? line.event?.type !== "tool.call" :
        absent === "delivery" ? line.event?.type !== "tool.result" : absent === "model" ? line.message?.message.role !== "tool" :
          absent === "assistant" ? line.message?.message.role !== "assistant" : true);
      const run = fixture(lines);
      try {
        if (absent !== "stdout") run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
        expect(() => run.evidence.finish()).toThrow();
      } finally { run.evidence.stop(); }
    }
  });
  test("preserves valid MCP error results and verifies the error flag", () => {
    for (const nativeError of [true, false]) {
      const run = fixture([inventory(), call(), delivered("answer\n", { isError: nativeError }), end(), assistant(), model()], { ...RESULT, isError: true });
      try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
        if (nativeError) { run.evidence.finish();
          expect(kinds(run.records, "model_tool_result")[0]?.content).toEqual([{ type: "text",
            text: "Wall time: 0.025 seconds\n<system>ERROR: Tool execution failed.</system>\nanswer\n" }]);
        } else failure(() => run.evidence.finish(), Code.ResultChanged); }
      finally { run.evidence.stop(); }
    }
  });
  test("preserves the empty-output sentinel when an MCP error reports it as text", () => {
    const content = [{ type: "text", text: "Tool output is empty." }];
    const run = fixture([inventory(), call(), delivered(content[0]!.text, { isError: true }), end(), assistant(), model(content)], { content, isError: true });
    try {
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: content[0]!.text });
      run.evidence.finish();
      expect(kinds(run.records, "model_tool_result")[0]?.content).toEqual([{ type: "text",
        text: "Wall time: 0.025 seconds\n<system>ERROR: Tool execution failed.</system>\nTool output is empty." }]);
      expect(kinds(run.records, "result_comparison")[0]?.equal).toBe(true);
    } finally { run.evidence.stop(); }
  });
  test("reconstructs a separate timing part when the wire content starts with media", () => {
    const result = { content: [{ type: "image", data: "YWJj", mimeType: "image/png" }, { type: "text", text: "caption" }] };
    const content = [{ type: "image_url", imageUrl: { url: "data:image/png;base64,YWJj" } }, { type: "text", text: "caption" }];
    const run = fixture([inventory(), call(), delivered(content, { durationMs: 1234.5 }), end(), assistant(), model(content)], result);
    try {
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: JSON.stringify(content) });
      run.evidence.finish();
      expect(kinds(run.records, "model_tool_result")[0]?.content).toEqual([{ type: "text", text: "Wall time: 1.234 seconds" }, ...content]);
      expect(kinds(run.records, "result_comparison")[0]).toMatchObject({ equal: true, header: "Wall time: 1.234 seconds" });
    } finally { run.evidence.stop(); }
  });
  test("reconstructs loop notes and refuses their added provider text", () => {
    for (const note of ["extra notice", "\n"]) {
      const run = fixture([inventory(), call(), delivered("answer\n", { note }), end(), assistant(), model()]);
      try {
        run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
        failure(() => run.evidence.finish(), Code.ResultChanged);
        expect(kinds(run.records, "model_tool_result")[0]?.content).toEqual([{ type: "text", text: `Wall time: 0.025 seconds\nanswer\n\n${note}` }]);
      } finally { run.evidence.stop(); }
    }
  });
  test("records whitespace removal and refuses the resulting server content loss", () => {
    const content = [{ type: "text", text: "answer" }, { type: "text", text: " \n\t" }];
    const run = fixture([inventory(), call(), delivered(content), end(), assistant(), model(content)], { content });
    try {
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: JSON.stringify(content) });
      failure(() => run.evidence.finish(), Code.ResultChanged);
      expect(kinds(run.records, "model_tool_result")[0]).toMatchObject({
        content: [{ type: "text", text: "Wall time: 0.025 seconds\nanswer" }], wire_content: content,
      });
      expect(kinds(run.records, "result_comparison")[0]?.equal).toBe(false);
    } finally { run.evidence.stop(); }
  });
  test("refuses empty server outputs before accepting a substituted status", () => {
    for (const content of [[], [{ type: "text", text: "" }], [{ type: "text", text: " \n" }],
      [{ type: "text", text: "Tool output is empty." }]]) {
      const output = content.length === 1 ? content[0]!.text : content;
      const run = fixture([inventory(), call(), delivered(output), end(), assistant(), model(content)], { content });
      try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: typeof output === "string" ? output : JSON.stringify(output) });
        failure(() => run.evidence.finish(), Code.UnsupportedResult); }
      finally { run.evidence.stop(); }
    }
  });
  test("requires the Kimi prefix opt-in when evidence is used programmatically", () => {
    const run = fixture();
    run.relay.spec.accept_harness_prefix = ["codex-wall-time"];
    try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      failure(() => run.evidence.finish(), Code.Protocol); }
    finally { run.evidence.stop(); }
  });
  test("requires valid loop timing and note evidence", () => {
    for (const extra of [{ durationMs: -1 }, { durationMs: "25" }, { note: false }]) {
      const run = fixture([inventory(), call(), delivered("answer\n", extra), end(), assistant(), model()]);
      try { failure(() => run.evidence.finish(), Code.Protocol); }
      finally { run.evidence.stop(); }
    }
  });
  test("reconstructs an absent optional duration without inventing a timing header", () => {
    const run = fixture([inventory(), call(), delivered("answer\n", { durationMs: undefined }), end(), assistant(), model()]);
    try {
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      failure(() => run.evidence.finish(), Code.ResultChanged);
      expect(kinds(run.records, "model_tool_result")[0]?.content).toEqual([{ type: "text", text: "answer\n" }]);
      expect(kinds(run.records, "result_comparison")[0]).toMatchObject({ equal: false, header: null });
    } finally { run.evidence.stop(); }
  });
  test("rejects a malformed native result error flag", () => {
    const run = fixture([inventory(), call(), delivered("answer\n", { isError: "false" }), end(), assistant(), model()]);
    try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" }); failure(() => run.evidence.finish(), Code.Protocol); }
    finally { run.evidence.stop(); }
  });
  test("requires a native step ID and valid usage counters", () => {
    for (const extra of [{ uuid: undefined, messageId: undefined }, { usage: { ...USAGE, output: -1 } }]) {
      const run = fixture([inventory(), call(), delivered(), end("step-1", extra)]);
      try { failure(() => run.evidence.finish(), extra.usage ? Code.Protocol : Code.MessageIdMissing); }
      finally { run.evidence.stop(); }
    }
  });
  test("rejects duplicate call IDs, deliveries, model results, and steps", () => {
    for (const duplicate of [call(), delivered(), model(), end()]) {
      const run = fixture([...complete(), duplicate]);
      try { expect(() => run.evidence.finish()).toThrow(); } finally { run.evidence.stop(); }
    }
  });
  test("checks final wire bytes against live emitted evidence", async () => {
    const run = fixture();
    try {
      await run.evidence.resolveCallId(run.relay.calls[0]!);
      writeFileSync(run.path, complete().map((entry) => JSON.stringify(entry).replaceAll("call-1", "rewritten")).join("\n") + "\n");
      failure(() => run.evidence.finish(), Code.HarnessLogMissing);
    } finally { run.evidence.stop(); }
  });
  test("rejects missing, ambiguous, oversized, malformed, partial, and invalid UTF-8 wire logs", () => {
    for (const mode of ["missing", "ambiguous", "oversized", "malformed", "partial", "utf8"]) {
      const run = fixture([]);
      if (mode === "missing") { const home = join(run.home, "missing");
        const evidence = new ExperimentKimiEvidence(run.relay, { kimiHome: home });
        try { failure(() => evidence.finish(), Code.HarnessLogMissing); } finally { evidence.stop(); run.evidence.stop(); } continue; }
      if (mode === "ambiguous") { const path = join(run.home, "sessions/other/session_other/agents/main/wire.jsonl"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{}\n"); }
      if (mode === "oversized") truncateSync(run.path, 16 * 1024 * 1024 + 1);
      if (mode === "malformed") writeFileSync(run.path, "not-json\n");
      if (mode === "partial") writeFileSync(run.path, JSON.stringify(inventory()));
      if (mode === "utf8") writeFileSync(run.path, Buffer.from([255, 10]));
      try { failure(() => run.evidence.finish(), Code.HarnessLogMissing); } finally { run.evidence.stop(); }
    }
  });
  test("verifies the late stdout session ID against the discovered wire path", () => {
    const run = fixture();
    try { run.evidence.accept(kimiResumeHint("session_87654321-4321-4321-4321-cba987654321"));
      failure(() => run.evidence.finish(), Code.HarnessLogMissing); }
    finally { run.evidence.stop(); }
  });
  test("rejects a resume hint that matches the workspace instead of the native session directory", () => {
    const run = fixture(complete(), RESULT, { workspace: KIMI_STREAM_SESSION, session: "session_actual" });
    try {
      run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      run.evidence.accept(kimiResumeHint());
      failure(() => run.evidence.finish(), Code.HarnessLogMissing);
    } finally { run.evidence.stop(); }
  });
  test("matches the already-prefixed native session ID from the resume hint", () => {
    const run = fixture();
    try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" });
      run.evidence.accept(kimiResumeHint()); run.evidence.finish(); }
    finally { run.evidence.stop(); }
  });
  test("validates native assistant calls and usage against loop evidence", () => {
    for (const entry of [assistant({ toolCalls: [] }), assistant({}, { usage: { ...USAGE, output: 99 } })]) {
      const run = fixture([inventory(), call(), delivered(), end(), entry, model()]);
      try { run.evidence.accept({ role: "tool", tool_call_id: "call-1", content: "answer\n" }); failure(() => run.evidence.finish(), Code.Protocol); }
      finally { run.evidence.stop(); }
    }
  });
});

describe("Kimi MCP result conversion", () => {
  test("keeps text bytes and image URLs with exact media-only framing", () => {
    const image = { type: "image", data: "YWJj", mimeType: "image/png" };
    expect(kimiContentParts([image], QUALIFIED)).toEqual([
      { type: "text", text: `<mcp_tool_result name="${QUALIFIED}">` },
      { type: "image_url", imageUrl: { url: "data:image/png;base64,YWJj" } },
      { type: "text", text: "</mcp_tool_result>" },
    ]);
    expect(kimiContentParts([{ type: "text", text: "first\n" }, { ...image, mimeType: undefined }], QUALIFIED))
      .toEqual([{ type: "text", text: "first\n" }, { type: "image_url", imageUrl: { url: "data:image/png;base64,YWJj" } }]);
  });
  test("refuses unsupported MCP content", () => {
    for (const block of [{ type: "audio", data: "x" }, { type: "resource_link", uri: "x" }, { type: "text", text: 5 }])
      failure(() => kimiContentParts([block], QUALIFIED), Code.UnsupportedResult);
  });
  test("matches the upstream sanitizer and long-name hash", () => {
    expect(kimiToolName("my..server", "a___b")).toBe("mcp__my_server__a_b");
    expect(kimiToolName("experiment", "lookup")).toBe(QUALIFIED);
    expect(kimiToolName("a".repeat(50), "b".repeat(50))).toBe("mcp__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_26db0421");
  });
});
