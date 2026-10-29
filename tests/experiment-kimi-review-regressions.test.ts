import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence } from "../src/experiment-kimi.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";

type Entry = Record<string, any>;
const QUALIFIED = "mcp__experiment__lookup";
const TOOL = { name: "lookup", description: "Look up a query", inputSchema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
} };
const SNAPSHOT = { name: QUALIFIED, description: TOOL.description, parameters: TOOL.inputSchema };
const USAGE = { inputOther: 10, output: 2, inputCacheRead: 3, inputCacheCreation: 1 };
const PART = { type: "text", text: "answer" };
const loop = (event: Entry, time = 1000) => ({ type: "context.append_loop_event", agentId: "main", event, time });
const completed = () => [
  loop({ type: "content.part", stepUuid: "success-step", part: PART }, 1200),
  loop({ type: "step.end", uuid: "success-step", finishReason: "stop", usage: USAGE, messageId: "provider-success" }, 1300),
  { type: "agent.message.appended", message: { message: { role: "assistant", content: [PART], toolCalls: [] },
    meta: { usage: USAGE, messageId: "provider-success" } } },
];

function fixture(events: Entry[], snapshot = SNAPSHOT) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-review-regressions");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions/workspace/session_fixture/agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [{ type: "llm.tools_snapshot", tools: [snapshot] }, ...events].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const records: Entry[] = [];
  const relay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set([TOOL.name]), toolDefinitions: [TOOL], calls: [],
    record(kind: string, fields: Entry) { records.push({ kind, ...fields }); } };
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: home });
  return { evidence, records };
}

test.each([false, true])("Kimi provider retry without usage creates no turn; partial content=%s", (partial) => {
  const retry = { type: "step.end", uuid: "failed-step", finishReason: "error" };
  const { evidence, records } = fixture([
    ...(partial ? [loop({ type: "content.part", stepUuid: "failed-step", part: { type: "text", text: "partial attempt" } }, 900)] : []),
    loop(retry), ...completed(),
  ]);
  try {
    evidence.accept({ role: "assistant", content: PART.text });
    evidence.finish();
    expect(records.filter((record) => record.kind === "harness_retry")).toEqual([
      { kind: "harness_retry", message_id: "failed-step", t: 1, item: retry },
    ]);
    expect(records.filter((record) => record.kind === "turn")).toEqual([
      { kind: "turn", message_id: "success-step", t: 1.2, usage: null, tool_calls: [] },
    ]);
    expect(records.filter((record) => record.kind === "turn_usage")).toHaveLength(1);
  } finally { evidence.stop(); }
});

test.each([
  ["description", { ...SNAPSHOT, description: "Changed instruction" }],
  ["parameters", { ...SNAPSHOT, parameters: { type: "object", properties: { query: { type: "number" } } } }],
])("Kimi rejects a tool snapshot with changed %s", (_field, snapshot) => {
  const { evidence } = fixture(completed(), snapshot as typeof SNAPSHOT);
  try { expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.InventoryMismatch })); }
  finally { evidence.stop(); }
});

test("Kimi accepts the upstream description and inputSchema-to-parameters mapping", () => {
  const { evidence } = fixture(completed());
  try { evidence.accept({ role: "assistant", content: PART.text }); expect(() => evidence.finish()).not.toThrow(); }
  finally { evidence.stop(); }
});
