import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence, type KimiEvidenceRelay } from "../src/experiment-kimi.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
const NAME = "mcp__experiment__lookup";
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
const loop = (event: Entry) => ({ type: "context.append_loop_event", time: 1000, event });
const encode = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-task-u");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions/workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encode([{ type: "llm.tools_snapshot", tools: [{ name: NAME, description: "", parameters: {} }] }]));
  const records: Entry[] = [];
  const relay: KimiEvidenceRelay = {
    spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] }, toolNames: new Set(["lookup"]),
    toolDefinitions: [{ name: "lookup", description: "", inputSchema: {} }], calls: [],
    record(kind, fields) { records.push({ kind, ...fields }); },
  };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: home });
  let batch = 0;
  async function completeBatch(results: string[], delivered: string[]) {
    const stepUuid = `step-${++batch}`, offset = relay.calls.length;
    const calls = results.map((_, index) => ({ id: `call-${offset + index + 1}`, name: NAME, input: {} }));
    relay.calls.push(...calls.map((c, index) => ({ relay_index: offset + index, name: "lookup", input: c.input })));
    appendFileSync(path, encode(calls.map((c) => loop({ type: "tool.call", uuid: `uuid-${c.id}`, stepUuid,
      toolCallId: c.id, name: c.name, args: c.input }))));
    evidence.refresh();
    await Promise.all(calls.map(async (c, index) => {
      const relayCall = relay.calls[offset + index]!;
      relayCall.call_id = await evidence.resolveCallId(relayCall);
      expect(relayCall.call_id).toBe(c.id);
    }));
    results.forEach((text, index) => { relay.calls[offset + index]!.result = { content: [{ type: "text", text }] }; });
    appendFileSync(path, encode([
      loop({ type: "step.end", uuid: stepUuid, usage: USAGE }),
      { type: "agent.message.appended", message: { message: { role: "assistant", content: [], toolCalls: calls.map((c) =>
        ({ type: "function", id: c.id, name: c.name, arguments: JSON.stringify(c.input) })) }, meta: { usage: USAGE } } },
      ...calls.flatMap((c, index) => [loop({ type: "tool.result", parentUuid: `uuid-${c.id}`, toolCallId: c.id,
        result: { output: delivered[index], isError: false, durationMs: 5 } }),
      { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: c.id,
        content: [{ type: "text", text: delivered[index] }] } } }]),
    ]));
    evidence.refresh();
    evidence.accept({ role: "assistant", tool_calls: calls.flatMap((c) => kimiAssistantCall(c.id, c.name, c.input).tool_calls) });
    calls.forEach((c, index) => evidence.accept({ role: "tool", tool_call_id: c.id, content: delivered[index] }));
  }
  function finish() { evidence.accept(kimiResumeHint()); evidence.finish(); }
  return { relay, records, evidence, completeBatch, finish };
}

test("Kimi rejects borrowing a later exact result to complete an earlier FIFO group", async () => {
  const f = fixture();
  try {
    await f.completeBatch(["A", "B"], ["A", "C"]);
    await f.completeBatch(["C"], ["B"]);
    expect(f.relay.calls.map((call) => call.correlation)).toEqual(["fifo", "fifo", "exact"]);
    expect(f.finish).toThrow(expect.objectContaining({ code: Code.ResultChanged }));
    expect(f.records.filter((r) => r.kind === "result_comparison")).toMatchObject([
      { equal: true, server_relay_index: 0 }, { equal: false, server_relay_index: 1 }, { equal: false },
    ]);
  } finally { f.evidence.stop(); }
});

test("Kimi keeps completed FIFO groups separate when later results could hide changed content", async () => {
  const f = fixture();
  try {
    await f.completeBatch(["A", "B"], ["C", "D"]);
    await f.completeBatch(["C", "D"], ["A", "B"]);
    expect(f.relay.calls.map((call) => call.correlation)).toEqual(["fifo", "fifo", "fifo", "fifo"]);
    expect(f.finish).toThrow(expect.objectContaining({ code: Code.ResultChanged }));
    expect(f.records.filter((r) => r.kind === "result_comparison").map((r) => r.equal)).toEqual([false, false, false, false]);
  } finally { f.evidence.stop(); }
});

test("Kimi accepts result permutations within each concurrent FIFO group", async () => {
  const f = fixture();
  try {
    await f.completeBatch(["A", "B"], ["B", "A"]);
    await f.completeBatch(["C", "D"], ["D", "C"]);
    f.finish();
    expect(f.records.filter((r) => r.kind === "result_comparison")).toMatchObject([
      { equal: true, server_relay_index: 1 }, { equal: true, server_relay_index: 0 },
      { equal: true, server_relay_index: 3 }, { equal: true, server_relay_index: 2 },
    ]);
  } finally { f.evidence.stop(); }
});

test("Kimi compares a later exact call directly after a valid FIFO group", async () => {
  const f = fixture();
  try {
    await f.completeBatch(["A", "B"], ["B", "A"]);
    await f.completeBatch(["C"], ["C"]);
    f.finish();
    const exact = f.records.filter((r) => r.kind === "result_comparison").at(-1)!;
    expect(exact).toMatchObject({ call_id: "call-3", relay_index: 2, equal: true });
    expect(exact).not.toHaveProperty("server_relay_index");
  } finally { f.evidence.stop(); }
});
