import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiEvidence, type KimiEvidenceRelay } from "../src/experiment-kimi.js";
import { KimiWireParser } from "../src/experiment-kimi-parser.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentServer } from "../src/experiment-server.js";

const TOOL = { name: "lookup", description: "test", inputSchema: {} };
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
const SNAPSHOT = { type: "llm.tools_snapshot", tools: [{ name: "mcp__experiment__lookup", description: "test", parameters: {} }] };
type Entry = Record<string, any>;

function directory(): string {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-lifecycle-l");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "case-"));
}

test.each(["", 42, null])("Kimi validates optional provider messageId before accepting a retry: %j", (messageId) => {
  const parser = new KimiWireParser("experiment", () => new Set(["lookup"]), () => {}, () => [TOOL]);
  parser.accept(SNAPSHOT);
  expect(() => parser.accept({ type: "context.append_loop_event", time: 1000,
    event: { type: "step.end", uuid: "retry-step", finishReason: "error", messageId } }))
    .toThrow(expect.objectContaining({ code: Code.Protocol, message: "Kimi step.end has an invalid provider messageId" }));
});

for (const method of ["close", "closeSync", "terminateProtocol"] as const) {
  test.each([false, true])(`Kimi ${method} records interruption before verification; stdout=%s`, async (stdout) => {
    const cwd = directory();
    const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
    const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => ({
      jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] },
    }));
    const run = new ExperimentKimiRun({ name: "experiment", command: process.execPath, args: [], env: [],
      recording: join(cwd, "records"), accept_harness_prefix: ["kimi-wall-time"] }, cwd, cwd, join(cwd, "agent.md"), {});
    try {
      await run.prepare();
      const response = await fetch(run.relay.url, { method: "POST", headers: {
        Authorization: `Bearer ${run.relay.token}`, "Content-Type": "application/json",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(response.status).toBe(200);
      await response.text();
      if (stdout) run.push('{"role":"assistant","content":"reply"}\n');
      if (method === "close") await expect(run.close()).rejects.toMatchObject({ code: Code.Protocol });
      else run[method]();
      await run.close().catch(() => {});
      const records: Entry[] = readFileSync(run.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const failures = records.filter((record) => record.kind === "failure");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: Code.Protocol, message: expect.stringContaining("interrupted before") });
      expect(records.at(-1)).toMatchObject({ kind: "run_end", code: Code.Protocol, error: failures[0]!.message });
      expect(records.indexOf(failures[0]!)).toBeLessThan(records.length - 1);
      await expect(run.complete()).rejects.toMatchObject({ code: Code.Protocol });
    } finally { await run.close().catch(() => {}); start.mockRestore(); request.mockRestore(); }
  });
}

function evidenceFixture(lines: Entry[]) {
  const home = directory(), path = join(home, "sessions/workspace/session_test/agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const failures: Error[] = [];
  const relay: KimiEvidenceRelay = { spec: { name: "experiment", accept_harness_prefix: ["kimi-wall-time"] },
    toolNames: new Set(["lookup"]), toolDefinitions: [TOOL], calls: [], record: () => {} };
  return { failures, evidence: new ExperimentKimiEvidence(relay, { kimiHome: home, onFailure: (error) => failures.push(error) }) };
}

test("Kimi stop preserves a prior evidence failure and notifies once", () => {
  const { evidence, failures } = evidenceFixture([SNAPSHOT, { type: "context.append_loop_event", time: 1000,
    event: { type: "tool.call", uuid: "tool-1", stepUuid: "step-1", toolCallId: "call-1", name: "foreign", args: {} } }]);
  evidence.stop(); evidence.stop();
  expect(failures).toHaveLength(1);
  expect(() => evidence.finish()).toThrow(expect.objectContaining({ code: Code.UnknownTool }));
});

test("Kimi stop after successful verification preserves its verified verdict", () => {
  const part = { type: "text", text: "reply" };
  const { evidence, failures } = evidenceFixture([SNAPSHOT,
    { type: "context.append_loop_event", time: 1000, event: { type: "content.part", stepUuid: "step-1", part } },
    { type: "context.append_loop_event", time: 1100, event: { type: "step.end", uuid: "step-1", usage: USAGE } },
    { type: "agent.message.appended", message: { message: { role: "assistant", content: [part], toolCalls: [] }, meta: { usage: USAGE } } },
  ]);
  evidence.accept({ role: "assistant", content: part.text });
  evidence.finish(); evidence.stop(); evidence.stop(); evidence.finish();
  expect(failures).toHaveLength(0);
});

test("Kimi termination preserves an existing relay failure", async () => {
  const cwd = directory();
  const run = new ExperimentKimiRun({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(cwd, "records"), accept_harness_prefix: ["kimi-wall-time"] }, cwd, cwd, join(cwd, "agent.md"), {});
  const original = new ExperimentFailure(Code.ResultChanged, "prior result mismatch");
  run.relay.fail(original);
  run.terminateProtocol(); run.terminateProtocol();
  await expect(run.close()).rejects.toBe(original);
  const records: Entry[] = readFileSync(run.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.filter((record) => record.kind === "failure")).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ kind: "run_end", code: Code.ResultChanged, error: "prior result mismatch" });
});
