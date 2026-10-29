import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentCodexEvidence, type CodexEvidenceRelay } from "../src/experiment-codex.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { ExperimentFailureCode } from "../src/experiment-records.js";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { MARKER } from "./fixtures/experiment-mcp.js";
import { codexCatalog } from "./fixtures/experiment-codex.js";
const THREAD = "12345678-1234-4234-8234-123456789abc";
const HEADER = "Wall time: 0.0123 seconds\nOutput:";
const TIME = "2026-10-29T01:02:03.125Z";
const INPUT = { nested: { answer: 42 }, query: "hello" };
const RESULT = { content: [{ type: "text", text: "answer\n" }] };
const USAGE = { input_tokens: 21, cached_input_tokens: 5, cache_write_input_tokens: 2,
  output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 24 };
type Entry = Record<string, any>; function line(type: string, payload: Entry, timestamp = TIME): Entry { return { timestamp, type, payload }; }
function call(extra: Entry = {}): Entry {
  return line("response_item", { type: "function_call", id: "fc_1", call_id: "call_1",
    namespace: "mcp__experiment", name: "lookup", arguments: JSON.stringify(INPUT), ...extra });
}
function output(value: unknown = [{ type: "input_text", text: HEADER }, { type: "input_text", text: "answer\n" }], id = "call_1"): Entry {
  return line("response_item", { type: "function_call_output", call_id: id, output: value }, "2026-10-29T01:02:04.500Z");
}
function token(usage: Entry = USAGE): Entry { return line("event_msg", { type: "token_count", info: { last_token_usage: usage } }); }
function responseUsage(responseId: string, usage: Entry = USAGE): Entry {
  return line("token_usage_record", { thread_id: THREAD, turn_id: "turn_1", session_id: THREAD,
    root_turn_id: "turn_1", response_id: responseId, usage, turn_token_usage: usage, thread_token_usage: usage });
}
function message(id: string | undefined = "msg_1"): Entry {
  return line("response_item", { type: "message", role: "assistant", ...(id ? { id } : {}),
    content: [{ type: "output_text", text: "finished" }] });
}
function fixture(result: Entry = RESULT) {
  const records: Entry[] = [];
  const relay: CodexEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["codex-wall-time"] },
    toolNames: new Set(["lookup", "another"]), calls: [{ relay_index: 0, name: "lookup", input: INPUT, result }],
    record(kind, fields) { records.push({ kind, ...fields }); } };
  const evidence = new ExperimentCodexEvidence(relay);
  evidence.accept({ type: "thread.started", thread_id: THREAD });
  evidence.accept({ type: "item.completed", item: { id: "item_0", type: "mcp_tool_call", server: "experiment",
    tool: "lookup", arguments: INPUT, result: { ...result, structured_content: null }, error: null, status: "completed" } });
  evidence.accept({ type: "turn.completed", usage: USAGE });
  return { records, relay, evidence };
}
function rollout(lines: Entry[], catalog = codexCatalog(["lookup", "another"])): string {
  const parent = resolve("scratch/session-14c66a93/exp/codex-evidence-fixtures");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const dir = join(home, "sessions", "2026", "10", "29");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`),
    [line("session_meta", { id: THREAD }), catalog, ...lines].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return home;
}
function kinds(records: Entry[], kind: string): Entry[] { return records.filter((record) => record.kind === kind); }
describe("Codex experiment evidence", () => {
  test("preserves MCP error results when exec status matches the server error flag", () => {
    const { relay, records } = fixture({ ...RESULT, isError: true });
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    evidence.accept({ type: "item.completed", item: { id: "item_error", type: "mcp_tool_call",
      server: "experiment", tool: "lookup", arguments: INPUT,
      result: { content: RESULT.content, structured_content: null }, error: null, status: "failed" } });
    evidence.finish(rollout([call(), token(), output()]));
    expect(kinds(records, "harness_tool_result").at(-1)?.status).toBe("failed");
    expect(kinds(records, "result_comparison")[0]?.equal).toBe(true);
  });
  test("correlates scoped calls, exact model output, normalized turns, and raw exec evidence", () => {
    const { relay, evidence, records } = fixture();
    const home = rollout([message(), call(), token(), output(), message("msg_2"), token()]);
    evidence.finish(home);
    evidence.finish(home);
    expect(evidence.hasThread).toBe(true);
    expect(kinds(records, "harness_tool_result")[0]?.item.result.content).toEqual(RESULT.content);
    expect(kinds(records, "harness_usage")[0]?.usage).toEqual(USAGE);
    expect(kinds(records, "tool_call_identified")).toHaveLength(0);
    expect(kinds(records, "harness_tool_call")[0]).toMatchObject({ call_id: "call_1", name: "lookup", namespace: "mcp__experiment", allowed: true });
    expect(kinds(records, "tool_call")).toHaveLength(0);
    expect(kinds(records, "model_tool_result")[0]?.output).toEqual(output().payload.output);
    expect(kinds(records, "result_comparison")).toEqual([{ kind: "result_comparison", call_id: "call_1", relay_index: 0,
      equal: true, harness_prefix: "codex-wall-time", header: HEADER }]);
    expect(kinds(records, "turn")).toEqual([
      { kind: "turn", message_id: "msg_1", t: Date.parse(TIME) / 1000,
        usage: null, tool_calls: [] },
      { kind: "turn", message_id: "msg_2", t: Date.parse(TIME) / 1000,
        usage: null, tool_calls: [] },
    ]);
    expect(kinds(records, "turn_usage").map((entry) => entry.message_id)).toEqual(["msg_1", "msg_2"]);
    expect(kinds(records, "turn_call")).toEqual([{ kind: "turn_call", message_id: "msg_1", call_id: "call_1",
      name: "lookup", t: Date.parse(TIME) / 1000 }]);
    expect(kinds(records, "tool_result_delivered")).toEqual([{ kind: "tool_result_delivered", call_id: "call_1",
      t: Date.parse("2026-10-29T01:02:04.500Z") / 1000 }]);
    expect(relay.calls.length).toBe(1);
  });
  test("uses function item IDs and rejects reasoning-only responses without native message IDs", () => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([call(), token(), output(),
      line("response_item", { type: "reasoning", summary: [] }), token()]))).toThrow("message");
    expect(kinds(records, "turn").map((turn) => turn.message_id)).toEqual(["fc_1"]);
  });
  test("rejects a completed empty response without a native turn ID", () => {
    const { relay, records } = fixture();
    relay.calls = [];
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    expect(() => evidence.finish(rollout([responseUsage("resp_empty"), token()]))).toThrow("message");
    expect(kinds(records, "turn")).toHaveLength(0);
  });
  test("groups distinct response usage with existing calls and later messages", () => {
    const { evidence, records } = fixture();
    evidence.finish(rollout([call(), responseUsage("resp_call"), output(), token(),
      message("msg_3"), responseUsage("resp_message", { ...USAGE, output_tokens: 4 }), token({ ...USAGE, output_tokens: 4 })]));
    const turns = kinds(records, "turn");
    expect(turns.map((turn) => turn.message_id)).toEqual(["fc_1", "msg_3"]);
    expect(turns.map((turn) => turn.tool_calls)).toEqual([[{ call_id: "call_1", name: "lookup" }], []]);
  });
  test("supports legacy flattened names and ignores user messages and rate-limit-only events", () => {
    const { evidence, records } = fixture();
    const legacy = call({ namespace: undefined, name: "mcp__experiment__lookup" });
    evidence.finish(rollout([line("response_item", { type: "message", role: "user", content: [] }),
      line("event_msg", { type: "token_count", info: null }), legacy, token(), output()]));
    expect(kinds(records, "turn")).toHaveLength(1);
    expect(kinds(records, "harness_tool_call")[0]?.name).toBe("mcp__experiment__lookup");
  });
  test("uses the function-call ID when the response has no message item ID", () => {
    const { evidence, records } = fixture();
    evidence.finish(rollout([message(""), message("later_message"), call(), token(), output()]));
    expect(kinds(records, "turn")[0]?.message_id).toBe("fc_1");
  });
  test("accepts a text-only run and defaults absent cache writes to zero", () => {
    const { relay, records } = fixture();
    relay.calls = [];
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept(null);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    evidence.accept({ type: "item.started", item: { type: "mcp_tool_call" } });
    const usage = { ...USAGE, cache_write_input_tokens: undefined };
    evidence.finish(rollout([message(), token(usage)]));
    expect(kinds(records, "turn_usage")[0]?.usage.cache_write).toBe(0);
    expect(() => evidence.accept({})).toThrow("finalized");
  });
  test("correlates parallel outputs and exec completions independently of completion order", () => {
    const { relay, records } = fixture();
    const secondResult = { content: [{ type: "text", text: "second result" }] };
    relay.calls.push({ relay_index: 1, name: "lookup", input: INPUT, result: secondResult });
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    for (const result of [secondResult, RESULT]) evidence.accept({ type: "item.completed", item: {
      type: "mcp_tool_call", server: "experiment", tool: "lookup", arguments: INPUT,
      result: { ...result, structured_content: null }, error: null, status: "completed" } });
    evidence.finish(rollout([call(), call({ id: "fc_2", call_id: "call_2" }),
      output(`${HEADER}\nsecond result`, "call_2"), output(), token()]));
    expect(kinds(records, "turn")[0]?.tool_calls).toEqual([{ call_id: "call_1", name: "lookup" }]);
    expect(kinds(records, "turn_call").map((entry) => entry.call_id)).toEqual(["call_1", "call_2"]);
    expect(kinds(records, "tool_result_delivered").map((entry) => entry.call_id)).toEqual(["call_2", "call_1"]);
  });
  test("matches arguments deeply regardless of object key order", () => {
    const { evidence } = fixture();
    evidence.finish(rollout([call({ arguments: '{"query":"hello","nested":{"answer":42}}' }), token(), output()]));
  });
  test("sanitizes hyphens according to the Codex model namespace rules", () => {
    const { relay, evidence, records } = fixture();
    relay.spec.name = "my-experiment";
    relay.toolNames = new Set(["look-up"]);
    relay.calls[0]!.name = "look-up";
    // The completed exec item reports the server's bare names.
    const next = new ExperimentCodexEvidence(relay);
    next.accept({ type: "thread.started", thread_id: THREAD });
    next.accept({ type: "item.completed", item: { type: "mcp_tool_call", server: "my-experiment", tool: "look-up",
      arguments: INPUT, result: { content: RESULT.content, structured_content: null }, error: null, status: "completed" } });
    next.finish(rollout([call({ namespace: "mcp__my_experiment", name: "look_up" }), token(), output()], codexCatalog(["look-up"], "my-experiment")));
    expect(kinds(records, "turn")[0]?.tool_calls[0].name).toBe("look-up");
    expect(evidence.hasThread).toBe(true);
  });
  test("supports the exact header plus a newline in string outputs", () => {
    const { evidence } = fixture();
    evidence.finish(rollout([call(), token(), output(`${HEADER}\nanswer\n`)]));
  });
  test("supports an empty result with a header-only output", () => {
    const { evidence } = fixture({ content: [] });
    evidence.finish(rollout([call(), token(), output(HEADER)]));
  });
  test.each(["Wall time: 0.123 seconds\nOutput:", "Wall time: 0.12345 seconds\nOutput:",
    "Wall time: 0.1234 seconds\r\nOutput:", "Wall time: 0.1234 seconds\nOutput:\n"])("rejects a malformed header %j", (header) => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([call(), token(), output([{ type: "input_text", text: header },
      { type: "input_text", text: "answer\n" }])]))).toThrow("header");
    expect(kinds(records, "result_comparison")[0]?.equal).toBe(false);
  });
  test("refuses an unaccepted prefix even when model output matches", () => {
    const { evidence, relay } = fixture();
    relay.spec.accept_harness_prefix = [];
    expect(() => evidence.finish(rollout([call(), token(), output()]))).toThrow("accept_harness_prefix");
  });
  test.each(["changed", "Warning: truncated output (original token count: 99999)"])("rejects modified or truncated model output %j", (text) => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([call(), token(), output([{ type: "input_text", text: HEADER },
      { type: "input_text", text }])]))).toThrow("changed or truncated");
    expect(kinds(records, "result_comparison")[0]?.equal).toBe(false);
    expect(kinds(records, "tool_result_delivered")).toEqual([{ kind: "tool_result_delivered", call_id: "call_1",
      t: Date.parse("2026-10-29T01:02:04.500Z") / 1000 }]);
  });
  test("records the following normalized turn even when an earlier appended result changed", () => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([call(), output(`${HEADER}\nchanged`), token()]))).toThrow("changed or truncated");
    expect(kinds(records, "turn")).toHaveLength(1);
    expect(kinds(records, "tool_result_delivered")).toHaveLength(1);
  });
  test.each(["structuredContent", "_meta"])("refuses server result %s before comparing", (key) => {
    const { evidence } = fixture({ ...RESULT, [key]: {} });
    expect(() => evidence.finish(rollout([call(), token(), output()]))).toThrow(key);
  });
  test.each(["update_plan", "exec_command", "apply_patch", "mcp__other__lookup"])("records and refuses an outside tool %s", (name) => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([call({ namespace: undefined, name }), token(), output()]))).toThrow("outside");
    expect(kinds(records, "tool_call")[0]).toMatchObject({ name, allowed: false });
  });
  test("refuses calls through an outside namespace", () => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([call({ namespace: "functions" }), token(), output()]))).toThrow("outside");
    expect(kinds(records, "tool_call")[0]?.allowed).toBe(false);
  });
  test.each(["custom_tool_call", "local_shell_call", "web_search_call"])("refuses other tool-call item %s", (type) => {
    const { evidence, records } = fixture();
    expect(() => evidence.finish(rollout([line("response_item", { type, id: "outside", name: "built_in" })]))).toThrow("outside");
    expect(kinds(records, "tool_call")[0]?.allowed).toBe(false);
  });
  test("refuses argument or ordinal mismatches", () => {
    for (const extra of [{ arguments: '{"query":"different"}' }, { name: "another" }]) {
      const { evidence } = fixture();
      expect(() => evidence.finish(rollout([call(extra), token(), output()]))).toThrow("relay call 0");
    }
  });
  test("refuses malformed call arguments", () => {
    const { evidence } = fixture();
    expect(() => evidence.finish(rollout([call({ arguments: "not json" }), token(), output()]))).toThrow("arguments");
  });
  test("requires exactly one call and output for every relay request", () => {
    for (const entries of [[message(), token()], [call(), token()], [call(), call(), token(), output()],
      [call(), token(), output(), output()], [call(), token(), output(undefined, "other")]]) {
      const { evidence } = fixture();
      expect(() => evidence.finish(rollout(entries))).toThrow();
    }
  });
  test("requires one completed exec MCP result per relay call", () => {
    const { relay } = fixture();
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    expect(() => evidence.finish(rollout([call(), token(), output()]))).toThrow("exec MCP");
  });
  test("requires exec result arguments and content to match the relay", () => {
    for (const patch of [{ arguments: {} }, { result: { content: [{ type: "text", text: "changed" }] } },
      { server: "other" }, { status: "failed", error: { message: "failed" } }]) {
      const { relay } = fixture();
      const evidence = new ExperimentCodexEvidence(relay);
      evidence.accept({ type: "thread.started", thread_id: THREAD });
      evidence.accept({ type: "item.completed", item: { type: "mcp_tool_call", server: "experiment", tool: "lookup",
        arguments: INPUT, result: { ...RESULT, structured_content: null }, error: null, status: "completed", ...patch } });
      expect(() => evidence.finish(rollout([call(), token(), output()]))).toThrow("exec MCP");
    }
  });
  test.each(["structured_content", "structuredContent", "_meta"])("refuses exec result extras %s", (key) => {
    const { relay } = fixture();
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    evidence.accept({ type: "item.completed", item: { type: "mcp_tool_call", server: "experiment", tool: "lookup",
      arguments: INPUT, result: { ...RESULT, [key]: {} }, error: null, status: "completed" } });
    expect(() => evidence.finish(rollout([call(), token(), output()]))).toThrow(key);
  });
  test("rejects sanitizer collisions in the allowed inventory", () => {
    const { relay, evidence } = fixture();
    relay.toolNames = new Set(["look-up", "look_up"]);
    expect(() => evidence.finish(rollout([call(), token(), output()]))).toThrow("collision");
  });
  test("uses each following token event and rejects a missing final usage event", () => {
    const { evidence } = fixture();
    expect(() => evidence.finish(rollout([call(), output()]))).toThrow("token_count");
  });
  test("rejects invalid usage and timestamps at the evidence boundary", () => {
    for (const entries of [[call(), token({ ...USAGE, cached_input_tokens: 22 }), output()],
      [call(), token({ ...USAGE, output_tokens: -1 }), output()],
      [{ ...call(), timestamp: "bad timestamp" }, token(), output()]]) {
      const { evidence } = fixture();
      expect(() => evidence.finish(rollout(entries))).toThrow();
    }
  });
  test("names missing rollout paths and refuses missing or conflicting thread IDs", () => {
    const { evidence, relay } = fixture();
    const missing = resolve("scratch/session-14c66a93/exp/nonexistent-evidence-home");
    expect(() => evidence.finish(missing)).toThrow(join(missing, "sessions"));
    expect(() => evidence.finish(missing)).toThrow(join(missing, "sessions"));
    const empty = new ExperimentCodexEvidence(relay);
    expect(empty.hasThread).toBe(false);
    expect(() => empty.finish(missing)).toThrow("thread.started");
    expect(() => new ExperimentCodexEvidence(relay).accept({ type: "thread.started", thread_id: "../elsewhere" })).toThrow("thread id");
    const conflicting = new ExperimentCodexEvidence(relay);
    conflicting.accept({ type: "thread.started", thread_id: THREAD });
    expect(() => conflicting.accept({ type: "thread.started", thread_id: "87654321-1234-4234-8234-123456789abc" })).toThrow("thread");
  });
  test("refuses malformed, partial, mismatched-session, or ambiguous rollout files", () => {
    for (const content of ["not json\n", JSON.stringify(call()),
      JSON.stringify(line("session_meta", { id: "another-thread" })) + "\n"]) {
      const { evidence } = fixture();
      const home = rollout([]);
      const path = join(home, "sessions/2026/10/29", `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
      writeFileSync(path, content);
      expect(() => evidence.finish(home)).toThrow(path);
    }
    const { evidence } = fixture();
    const home = rollout([call(), token(), output()]);
    writeFileSync(join(home, "sessions/2026/10/29", `rollout-2026-10-29T02-02-03-${THREAD}.jsonl`), "{}\n");
    expect(() => evidence.finish(home)).toThrow("multiple");
  });
  test("bounds rollout reads and refuses invalid UTF-8", () => {
    for (const tooLarge of [true, false]) {
      const { evidence } = fixture();
      const home = rollout([]);
      const path = join(home, "sessions/2026/10/29", `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
      if (tooLarge) truncateSync(path, 256 * 1024 * 1024 + 1);
      else writeFileSync(path, Buffer.from([255, 10]));
      expect(() => evidence.finish(home)).toThrow(tooLarge ? "268435456 bytes" : "valid UTF-8");
    }
  });
});
describe("live Codex rollout evidence", () => {
  test("uses request metadata immediately without a rollout", async () => {
    const { relay } = fixture();
    const evidence = new ExperimentCodexEvidence(relay, { callIdTimeoutMs: 30 });
    const call = relay.calls[0]!;
    expect(await evidence.resolveCallId(call, { params: { _meta: { callId: "native_request" } } })).toBe("native_request");
    expect(call.native_call_id_source).toBe("request_meta");
    evidence.stop();
  });
  test("rejects unobserved request IDs after the final rollout read", async () => {
    for (const live of [true, false]) {
      const { relay } = fixture();
      const home = rollout([call(), token(), output()]);
      const failures: Error[] = [];
      const evidence = new ExperimentCodexEvidence(relay, { ...(live ? { codexHome: home } : {}),
        callIdTimeoutMs: 30, onFailure: (error) => failures.push(error) });
      expect(await evidence.resolveCallId(relay.calls[0]!, { params: { _meta: { callId: "request_other" } } })).toBe("request_other");
      evidence.accept({ type: "thread.started", thread_id: THREAD });
      expect(failures).toHaveLength(0);
      try { evidence.finish(home); throw new Error("accepted different native IDs"); }
      catch (error) {
        expect(error).toMatchObject({ code: ExperimentFailureCode.CallIdUnresolved });
        expect(String(error)).toContain("request_other"); expect(String(error)).toContain("call_1");
      } finally { evidence.stop(); }
    }
  });
  test("emits the first native turn before outputs and usage and keeps its ID", () => {
    const records: Entry[] = [];
    const parser = new CodexRolloutParser(THREAD, "experiment", () => new Set(["lookup"]),
      (kind, fields) => records.push({ kind, ...fields }));
    for (const entry of [codexCatalog(["lookup"]), call(), message("later_message"), output()]) parser.accept(entry);
    expect(kinds(records, "turn")).toEqual([{ kind: "turn", message_id: "fc_1", t: Date.parse(TIME) / 1000,
      usage: null, tool_calls: [{ call_id: "call_1", name: "lookup" }] }]);
    expect(kinds(records, "turn_call")).toHaveLength(1); expect(kinds(records, "turn_usage")).toHaveLength(0);
    parser.accept(token()); parser.finish();
    expect(kinds(records, "turn_usage")).toEqual([{ kind: "turn_usage", message_id: "fc_1",
      usage: { input: 14, output: 3, cache_read: 5, cache_write: 2 }, t: Date.parse(TIME) / 1000 }]);
    expect(records.filter((entry) => ["turn", "tool_result_delivered", "turn_usage"].includes(entry.kind))
      .map((entry) => entry.kind)).toEqual(["turn", "tool_result_delivered", "turn_usage"]);
  });
  test("records a growing rollout before synthetic exec exits and before relay dispatch", async () => {
    const home = rollout([], codexCatalog(["bash"]));
    const path = join(home, "sessions/2026/10/29", `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
    const run = new ExperimentCodexRun({ name: "experiment", command: process.execPath, env: [],
      args: [resolve("tests/fixtures/experiment-mcp.ts")], recording: join(home, "recordings"),
      accept_harness_prefix: ["codex-wall-time"] }, home, home, true, {});
    const records = (): Entry[] => readFileSync(run.recordingPath, "utf8").trim().split("\n").map((raw) => JSON.parse(raw));
    const post = (id: number, method: string, params = {}) => fetch(run.relay.url, { method: "POST",
      headers: { Authorization: `Bearer ${run.relay.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const append = (...entries: Entry[]) => appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const timers: ReturnType<typeof setTimeout>[] = [];
    let exited = false;
    try {
      await run.prepare();
      await post(1, "initialize"); await post(2, "tools/list");
      const started = JSON.stringify({ type: "thread.started", thread_id: THREAD }) + "\n";
      run.push(started.slice(0, 19)); run.push(started.slice(19));
      timers.push(setTimeout(() => append(call({ name: "bash", arguments: '{"command":"marker"}' })), 10));
      expect((await post(3, "tools/call", { name: "bash", arguments: { command: "marker" } })).status).toBe(200);
      const dispatched = records();
      const request = dispatched.find((entry) => entry.kind === "mcp_request" && entry.message.method === "tools/call")!;
      expect(request.message.params._meta["codemux/callId"]).toBe("call_1");
      expect(dispatched.find((entry) => entry.kind === "turn")!.seq).toBeLessThan(request.seq);
      expect(dispatched.find((entry) => entry.kind === "turn")!.usage).toBeNull();
      expect(dispatched.filter((entry) => entry.kind === "turn_usage")).toHaveLength(0);
      timers.push(setTimeout(() => append(output([{ type: "input_text", text: HEADER }, { type: "input_text", text: MARKER }]),
        token(), message("msg_2"), token()), 10));
      await Bun.sleep(300);
      expect(exited).toBe(false);
      expect(records().filter((entry) => ["turn", "tool_result_delivered"].includes(entry.kind)).map((entry) => entry.kind))
        .toEqual(["turn", "tool_result_delivered", "turn"]);
      run.push(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "experiment", tool: "bash",
        arguments: { command: "marker" }, result: { content: [{ type: "text", text: MARKER }] }, status: "completed" } }) + "\n");
      run.push(JSON.stringify({ type: "turn.completed", usage: USAGE }) + "\n");
      exited = true;
      await run.complete();
      await run.close();
      expect(records().filter((entry) => entry.kind === "turn")).toHaveLength(2);
      expect(records().at(-1)!.code).toBeNull();
    } finally { timers.forEach(clearTimeout); await run.close().catch(() => {}); }
  });
  test("tails a delayed growing rollout, preserves partial lines, and resolves IDs before dispatch", async () => {
    const { relay, records } = fixture();
    const home = rollout([]);
    const path = join(home, "sessions/2026/10/29", `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: home });
    let processEnded = false;
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    const wire = JSON.stringify(call());
    const timers = [
      setTimeout(() => appendFileSync(path, wire.slice(0, 45)), 10),
      setTimeout(() => appendFileSync(path, wire.slice(45) + "\n" + JSON.stringify(token()) + "\n"), 280),
    ];
    try {
      const id = await evidence.resolveCallId(relay.calls[0]!);
      expect(id).toBe("call_1");
      expect(processEnded).toBe(false);
      expect(kinds(records, "turn")).toHaveLength(1);
      const delivered = new Promise<void>((resolve) => {
        const record = relay.record;
        relay.record = (kind, fields) => { record(kind, fields); if (kind === "turn" && fields.message_id === "msg_2") resolve(); };
      });
      appendFileSync(path, [output(), message("msg_2"), token()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      await Promise.race([delivered, Bun.sleep(1500).then(() => { throw new Error("live records timed out"); })]);
      expect(processEnded).toBe(false);
      expect(records.filter((entry) => ["turn", "tool_result_delivered"].includes(entry.kind)).map((entry) => entry.kind))
        .toEqual(["turn", "tool_result_delivered", "turn"]);
      evidence.accept({ type: "item.completed", item: { type: "mcp_tool_call", server: "experiment", tool: "lookup",
        arguments: INPUT, result: RESULT, status: "completed" } });
      processEnded = true;
      evidence.finish(home);
      expect(kinds(records, "turn")).toHaveLength(2);
      expect(kinds(records, "tool_result_delivered")).toHaveLength(1);
    } finally { timers.forEach(clearTimeout); evidence.stop(); }
  });
  test("waits for a rollout file to appear after thread.started", async () => {
    const { relay, records } = fixture();
    const home = rollout([]);
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: home });
    evidence.accept({ type: "thread.started", thread_id: "delayed-thread" });
    const path = join(home, "sessions/2026/10/29/rollout-2026-10-29T01-02-03-delayed-thread.jsonl");
    const timer = setTimeout(() => writeFileSync(path, [line("session_meta", { id: "delayed-thread" }), codexCatalog(["lookup", "another"]), call(), token()]
      .map((entry) => JSON.stringify(entry)).join("\n") + "\n"), 30);
    try { expect(await evidence.resolveCallId(relay.calls[0]!)).toBe("call_1"); expect(kinds(records, "turn")).toHaveLength(1); }
    finally { clearTimeout(timer); evidence.stop(); }
  });
  test("times out native ID resolution with an injected short deadline", async () => {
    const { relay } = fixture();
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: rollout([]), callIdTimeoutMs: 30 });
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    try { await expect(evidence.resolveCallId(relay.calls[0]!)).rejects.toMatchObject({ code: ExperimentFailureCode.CallIdUnresolved }); }
    finally { evidence.stop(); }
  });
  test("resolves a rollout call without waiting for its following token event", async () => {
    const { relay } = fixture();
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: rollout([call()]), callIdTimeoutMs: 30 });
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    try { expect(await evidence.resolveCallId(relay.calls[0]!)).toBe("call_1"); }
    finally { evidence.stop(); }
  });
  test("shutdown cancels unresolved native IDs", async () => {
    const { relay } = fixture();
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: rollout([]) });
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    const pending = evidence.resolveCallId(relay.calls[0]!);
    evidence.stop();
    await expect(pending).rejects.toThrow("closed");
  });
  test("fails responses without native message or function item IDs", () => {
    for (const entry of [message(""), call({ id: undefined })]) {
      const { evidence } = fixture();
      try { evidence.finish(rollout([entry, token()])); throw new Error("accepted missing ID"); }
      catch (error) { expect(error).toMatchObject({ code: ExperimentFailureCode.MessageIdMissing }); }
    }
  });
  test("rejects a completed exec turn with no rollout response evidence", () => {
    const { relay } = fixture(); relay.calls = [];
    const evidence = new ExperimentCodexEvidence(relay);
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    evidence.accept({ type: "turn.completed", usage: USAGE });
    expect(() => evidence.finish(rollout([]))).toThrow("response evidence");
  });
  test("the final consistency check rejects rewritten evidence already read live", async () => {
    const { relay } = fixture();
    const home = rollout([call(), token(), output()]);
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: home });
    evidence.accept({ type: "thread.started", thread_id: THREAD });
    await evidence.resolveCallId(relay.calls[0]!);
    const path = join(home, "sessions/2026/10/29", `rollout-2026-10-29T01-02-03-${THREAD}.jsonl`);
    writeFileSync(path, [line("session_meta", { id: THREAD }), call({ call_id: "rewritten" }), token(), output()]
      .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    expect(() => evidence.finish(home)).toThrow("changed");
  });
});
