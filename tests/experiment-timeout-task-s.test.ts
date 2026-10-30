import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import * as runtime from "../src/cli-runtime.js";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { launchRunRequest } from "../src/launch.js";
import { runCapturedCommand } from "../src/process-runner.js";
import * as processTable from "../src/process-table.js";
import { kimiResult } from "../src/result-envelope/kimi.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { codexCatalog, codexWorldState } from "./fixtures/experiment-codex.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
type Mode = "codex" | "kimi";
const TOOL = { name: "lookup", description: "", inputSchema: { type: "object", properties: {} } };
const INPUT = {};
const RESULT = { content: [{ type: "text", text: "original" }] };
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
const QUALIFIED = "mcp__experiment__lookup";
const stream = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const line = (type: string, payload: Entry) => ({ timestamp: "2026-10-29T01:02:03Z", type, payload });
const loop = (event: Entry) => ({ type: "context.append_loop_event", event, time: 1000 });

async function fixture(mode: Mode, change = "none", missingUsage = true, resultJson = true) {
  const parent = resolve("scratch/session-14c66a93/exp/timeout-s");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const spec = { name: "experiment", command: "unused", args: [], env: [], recording: join(home, "records"),
    accept_harness_prefix: [`${mode}-wall-time`] };
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) =>
    ({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } }));
  const sink = mode === "codex" ? new ExperimentCodexRun(spec, home, home, resultJson, {}) :
    new ExperimentKimiRun(spec, home, home, join(home, "agent.md"), {});
  try {
    await sink.prepare();
    const listed = await fetch(sink.relay.url, { method: "POST", headers: {
      Authorization: `Bearer ${sink.relay.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(listed.status).toBe(200);
    await listed.arrayBuffer();
  } finally { request.mockRestore(); start.mockRestore(); }
  sink.relay.calls.push({ relay_index: 0, call_id: "call-1", name: TOOL.name, input: INPUT, result: RESULT });
  const altered = change === "result" ? "altered" : "original";
  let wire: Entry[], stdout: Entry[], path: string;
  if (mode === "codex") {
    path = join(home, "sessions/2026/10/29/rollout-2026-10-29T01-02-03-thread-s.jsonl");
    wire = [line("session_meta", { id: "thread-s" }), codexCatalog([TOOL]), codexWorldState([TOOL.name]),
      line("response_item", { type: "function_call", id: "function-1", call_id: "call-1",
        namespace: "mcp__experiment", name: TOOL.name, arguments: "{}" }),
      line("response_item", { type: "function_call_output", call_id: "call-1", output: [
        { type: "input_text", text: "Wall time: 0.0100 seconds\nOutput:" }, { type: "input_text", text: altered }] }),
      ...(!missingUsage ? [line("event_msg", { type: "token_count", info: {
        last_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } } })] : [])];
    stdout = [{ type: "thread.started", thread_id: "thread-s" }, { type: "item.completed", item: {
      id: "exec-1", type: "mcp_tool_call", server: "experiment", tool: TOOL.name, arguments: INPUT,
      result: { content: change === "exec" ? [{ type: "text", text: "altered" }] : RESULT.content }, status: "completed" } },
    { type: "item.completed", item: { type: "agent_message", id: "reply-1", text: "finished" } }];
  } else {
    path = join(home, "sessions/workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
    const native = { type: "function", id: "call-1", name: QUALIFIED, arguments: "{}" };
    const message = (content: Entry[], toolCalls: Entry[], usage: boolean) => ({ type: "agent.message.appended",
      message: { message: { role: "assistant", content, toolCalls }, meta: usage ? { usage: USAGE } : {} } });
    wire = [{ type: "llm.tools_snapshot", tools: [{ name: QUALIFIED, description: "", parameters: TOOL.inputSchema }] },
      loop({ type: "tool.call", uuid: "tool-1", stepUuid: "step-1", toolCallId: "call-1", name: QUALIFIED, args: INPUT }),
      loop({ type: "tool.result", parentUuid: "tool-1", toolCallId: "call-1", result: { output: altered, durationMs: 1 } }),
      loop({ type: "step.end", uuid: "step-1", usage: USAGE }), message([], [native], true),
      { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: "call-1",
        content: [{ type: "text", text: altered }] } } },
      loop({ type: "content.part", stepUuid: "step-2", part: { type: "text", text: "finished" } }),
      loop({ type: "step.end", uuid: "step-2", ...(!missingUsage ? { usage: USAGE } : {}) }),
      message([{ type: "text", text: "finished" }], [], !missingUsage)];
    stdout = [kimiAssistantCall("call-1", QUALIFIED, change === "call" ? { changed: true } : INPUT),
      { role: "tool", tool_call_id: "call-1", content: altered },
      { role: "assistant", content: change === "text" ? "fin" : "finished" }, kimiResumeHint()];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stream(wire));
  const records = () => readFileSync(sink.recordingPath, "utf8").trim().split("\n").map((entry) => JSON.parse(entry));
  return { sink, home, stdout: stream(stdout), records, path, wire };
}

async function timeoutLaunch(mode: Mode, change: string, earlyEof: boolean, resultJson: boolean) {
  const f = await fixture(mode, change, true, resultJson);
  const adapter = mode === "codex" ? new CodexAdapter({}) : new KimiAdapter({});
  const context: RunContext = { stdoutSink: f.sink, experimentRecording: f.sink.recordingPath,
    ...(f.sink instanceof ExperimentCodexRun ? { experimentCodex: f.sink } : { experimentKimi: f.sink }) };
  const request: RunRequest = { agent: mode, prompt: "fixture", model: "fixture", resultJson,
    experimentMcp: "synthetic.json", hermetic: true, sandboxed: true, tools: "none" };
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; if (!earlyEof) stdout.close(); exit(0); } };
  const spawn = spyOn(Bun, "spawn").mockReturnValue({ pid: 2147483647, stdin: { write() {}, end() {} }, kill: stop,
    exited: new Promise<number>((resolveExit) => { exit = resolveExit; }),
    stdout: new ReadableStream<Uint8Array>({ start(controller) {
      stdout = controller; controller.enqueue(Buffer.from(f.stdout)); if (earlyEof) controller.close();
    } }), stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const spies: { mockRestore(): void }[] = [spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context), spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => { await f.sink.close(); }),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue(mode === "codex" ? "0.165.0" : "2.3.2"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(() => runCapturedCommand(["synthetic"], {
      cwd: f.home, env: {}, stdoutSink: f.sink, timeoutMs: 20 })),
    spyOn(processTable, "readProcessTable").mockReturnValue(new Map())];
  if (mode === "kimi") spies.push(spyOn(adapter, "processRunResult").mockImplementation((raw, req, ctx, failure) =>
    kimiResult(raw, req, f.home, ctx, failure)));
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    return { result, records: f.records(), failureCode: f.sink.relay.failureCode };
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    stop(); spawn.mockRestore(); await f.sink.close().catch(() => {});
  }
}

for (const mode of ["codex", "kimi"] as const) {
  test.each([false, true])(`${mode} timeout tolerates only missing final usage after stdout EOF; JSON=%s`, async (resultJson) => {
    const { result, records, failureCode } = await timeoutLaunch(mode, "none", true, resultJson);
    expect(result).toMatchObject({ exitCode: 124, success: false });
    expect(failureCode).toBeNull();
    expect(records.filter((entry) => entry.kind === "result_comparison")).toMatchObject([{ equal: true }]);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: null });
  });

  test.each([false, true])(`${mode} timeout still rejects changed delivered output; earlyEof=%s`, async (earlyEof) => {
    const { result, records, failureCode } = await timeoutLaunch(mode, "result", earlyEof, true);
    expect(result).toMatchObject({ exitCode: 124, success: false });
    expect(failureCode).toBe(Code.ResultChanged);
    expect(records.filter((entry) => entry.kind === "result_comparison")).toMatchObject([{ equal: false }]);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: "result_changed" });
  });
}

test("Codex timeout still compares exec results without final usage", async () => {
  const { result, failureCode } = await timeoutLaunch("codex", "exec", false, true);
  expect(result.exitCode).toBe(124);
  expect(failureCode).toBe(Code.ResultChanged);
});

test.each(["text", "call"])("Kimi timeout still compares delivered assistant %s", async (change) => {
  const { result, failureCode } = await timeoutLaunch("kimi", change, true, true);
  expect(result.exitCode).toBe(124);
  expect(failureCode).toBe(Code.Protocol);
  expect(result.stderr).toContain(change === "text" ? "stdout assistant text" : "stdout assistant tool calls");
});

test.each(["codex", "kimi"] as const)("%s still rejects missing final usage without a timeout", async (mode) => {
  const { sink, stdout } = await fixture(mode);
  try {
    sink.push(stdout);
    await expect(sink.complete()).rejects.toMatchObject({ code: "harness_log_missing" });
  } finally { await sink.close().catch(() => {}); }
});

test.each(["step-end", "message-usage", "step-usage"])("Kimi timeout tolerates missing final %s and verifies delivered evidence", async (missing) => {
  const { sink, stdout, path, wire, records } = await fixture("kimi", "none", false);
  if (!(sink instanceof ExperimentKimiRun)) throw new Error("expected Kimi fixture");
  if (missing === "message-usage") delete wire.at(-1)!.message.meta.usage;
  else if (missing === "step-usage") delete wire.at(-2)!.event.usage;
  else wire.splice(-2, 1);
  writeFileSync(path, stream(wire));
  try {
    sink.push(stdout);
    sink.finish({ timedOut: true });
    await expect(sink.complete({ timedOut: true })).resolves.toBeUndefined();
    expect(records().filter((entry) => entry.kind === "result_comparison")).toMatchObject([{ equal: true }]);
  } finally { await sink.close().catch(() => {}); }
});

test.each(["earlier-usage", "malformed-usage", "assistant-content", "assistant-call", "missing-delivery"])(
  "Kimi timeout preserves %s validation", async (change) => {
    const { sink, stdout, path, wire } = await fixture("kimi");
    if (!(sink instanceof ExperimentKimiRun)) throw new Error("expected Kimi fixture");
    if (change === "earlier-usage") delete wire[3]!.event.usage;
    else if (change === "malformed-usage") wire.at(-2)!.event.usage = { ...USAGE, output: -1 };
    else if (change === "assistant-content") wire.at(-1)!.message.message.content[0].text = "altered";
    else if (change === "assistant-call") wire[4]!.message.message.toolCalls[0].arguments = '{"altered":true}';
    else wire.splice(5, 1);
    writeFileSync(path, stream(wire));
    try {
      sink.push(stdout);
      sink.finish({ timedOut: true });
      await expect(sink.complete({ timedOut: true })).rejects.toMatchObject({
        code: change === "earlier-usage" || change === "missing-delivery" ? Code.HarnessLogMissing : Code.Protocol });
    } finally { await sink.close().catch(() => {}); }
  });
