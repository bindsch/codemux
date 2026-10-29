import { expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentServer } from "../src/experiment-server.js";

type Entry = Record<string, any>;
const TOOL = { name: "lookup", description: "", inputSchema: {} };
const NAME = "mcp__experiment__lookup";
const EXIT_MESSAGES = ["experiment MCP stdout closed before run completion",
  "experiment MCP server exited before termination", "experiment MCP server exited unexpectedly (0)"];
const encode = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const loop = (event: Entry) => ({ type: "context.append_loop_event", time: 1000, event });
const timeoutRecord = () => encode([loop({ type: "tool.result", parentUuid: "tool-1", toolCallId: "call-1",
  result: { output: `Tool "${NAME}" failed: MCP error -32001: Request timed out`, isError: true } })]);

async function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-flush-task-u");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const path = join(home, "sessions/workspace/session_fixture/agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } }));
  const run = new ExperimentKimiRun({ name: "experiment", command: "unused", args: [], env: [],
    recording: join(home, "records"), accept_harness_prefix: ["kimi-wall-time"], tool_timeout_seconds: 123 },
  home, home, join(home, "agent.md"), {});
  await run.prepare();
  const response = await fetch(run.relay.url, { method: "POST", headers: { Authorization: `Bearer ${run.relay.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  await response.text();
  writeFileSync(path, encode([{ type: "llm.tools_snapshot", tools: [{ name: NAME, description: "", parameters: {} }] },
    loop({ type: "tool.call", uuid: "tool-1", stepUuid: "step-1", toolCallId: "call-1", name: NAME, args: {} })]));
  run.evidence.refresh();
  run.relay.calls.push({ relay_index: 0, call_id: "call-1", name: "lookup", input: {} });
  let aborts = 0;
  run.start(() => {}, () => {}, () => { aborts++; run.terminateProtocol(); });
  const records = (): Entry[] => readFileSync(run.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { run, path, records, aborts: () => aborts, async close() {
    await run.close().catch(() => {});
    start.mockRestore(); request.mockRestore();
  } };
}

test.each(EXIT_MESSAGES)("Kimi reconciles a timeout appended after %s", async (message) => {
  const f = await fixture();
  const timeout = timeoutRecord();
  let appended: Promise<void> = Promise.resolve();
  try {
    f.run.relay.fail(new ExperimentFailure(Code.ServerError, message));
    appended = new Promise<void>((resolve) => setTimeout(() => {
      appendFileSync(f.path, timeout.slice(0, 40));
      setTimeout(() => { appendFileSync(f.path, timeout.slice(40)); resolve(); }, 60);
    }, 20));
    await f.run.closeProtocol();
    await expect(f.run.complete()).rejects.toMatchObject({ code: Code.ServerError,
      message: "kimi tool call timed out after 123000 ms" });
    expect(f.aborts()).toBe(1);
    expect(f.records().filter((record) => record.kind === "failure")).toMatchObject([
      { code: Code.ServerError, message: "kimi tool call timed out after 123000 ms" },
    ]);
  } finally { await appended; await f.close(); }
});

test("Kimi starts the wire quiet interval after the harness exit boundary", async () => {
  const f = await fixture();
  f.run.relay.fail(new ExperimentFailure(Code.ServerError, EXIT_MESSAGES[0]!));
  const verification = f.run.complete().catch((error: unknown) => error);
  const exit = Bun.sleep(100).then(() => f.run.closeProtocol());
  const append = Bun.sleep(150).then(() => appendFileSync(f.path, timeoutRecord()));
  try {
    expect(await verification).toMatchObject({ code: Code.ServerError, message: "kimi tool call timed out after 123000 ms" });
  } finally { await Promise.all([exit, append]); await f.close(); }
});

test("Kimi retains the first server exit when the flushed log has no timeout", async () => {
  const f = await fixture(), original = new ExperimentFailure(Code.ServerError, EXIT_MESSAGES[0]!);
  try {
    f.run.relay.fail(original);
    f.run.relay.fail(new ExperimentFailure(Code.ServerError, EXIT_MESSAGES[1]!));
    f.run.relay.fail(new ExperimentFailure(Code.Protocol, "protocol capture aborted"));
    expect(f.aborts()).toBe(1);
    expect(f.records().filter((record) => record.kind === "failure")).toEqual([]);
    await f.run.closeProtocol();
    await expect(f.run.complete()).rejects.toBe(original);
    expect(f.records().filter((record) => record.kind === "failure")).toHaveLength(1);
  } finally { await f.close(); }
});

test("Kimi keeps an unrelated failure that predates the server exit", async () => {
  const f = await fixture(), original = new ExperimentFailure(Code.ResultChanged, "prior result mismatch");
  try {
    f.run.relay.fail(original);
    f.run.relay.fail(new ExperimentFailure(Code.ServerError, EXIT_MESSAGES[0]!));
    appendFileSync(f.path, timeoutRecord());
    await f.run.closeProtocol();
    await expect(f.run.complete()).rejects.toBe(original);
    expect(f.records().filter((record) => record.kind === "failure")).toMatchObject([
      { code: Code.ResultChanged, message: "prior result mismatch" },
    ]);
  } finally { await f.close(); }
});

test("Kimi ignores a secondary abort error while reconciling a native timeout", async () => {
  const f = await fixture();
  try {
    f.run.relay.fail(new ExperimentFailure(Code.ServerError, EXIT_MESSAGES[0]!));
    f.run.relay.fail(new ExperimentFailure(Code.Protocol, "protocol capture aborted"));
    appendFileSync(f.path, timeoutRecord());
    await f.run.closeProtocol();
    await expect(f.run.complete()).rejects.toMatchObject({ code: Code.ServerError,
      message: "kimi tool call timed out after 123000 ms" });
    expect(f.aborts()).toBe(1);
    expect(f.records().filter((record) => record.kind === "failure")).toHaveLength(1);
  } finally { await f.close(); }
});

test("Kimi bounds reconciliation when the wire log keeps growing", async () => {
  const f = await fixture(), original = new ExperimentFailure(Code.ServerError, EXIT_MESSAGES[0]!);
  const growth = setInterval(() => appendFileSync(f.path, encode([{ type: "usage.record" }])), 20);
  try {
    f.run.relay.fail(original);
    const started = performance.now();
    await f.run.closeProtocol();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
    await expect(f.run.complete()).rejects.toBe(original);
    expect(f.records().filter((record) => record.kind === "failure")).toHaveLength(1);
  } finally { clearInterval(growth); await f.close(); }
});
