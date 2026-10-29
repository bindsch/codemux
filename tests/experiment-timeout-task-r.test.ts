import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import * as runtime from "../src/cli-runtime.js";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { launchRunRequest } from "../src/launch.js";
import { runCapturedCommand } from "../src/process-runner.js";
import * as processTable from "../src/process-table.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";

test.each([
  { resultJson: false, earlyEof: false }, { resultJson: true, earlyEof: false },
  { resultJson: false, earlyEof: true }, { resultJson: true, earlyEof: true },
])("Codex timeout skips final usage verification through launch; JSON=$resultJson earlyEof=$earlyEof", async ({ resultJson, earlyEof }) => {
  const parent = resolve("scratch/session-14c66a93/exp/timeout-r");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const sink = new ExperimentCodexRun({ name: "experiment", command: "unused", args: [], env: [],
    recording: join(cwd, "records") }, cwd, cwd, resultJson, {});
  await sink.prepare();
  const adapter = new CodexAdapter({});
  const context: RunContext = { stdoutSink: sink, experimentCodex: sink, experimentRecording: sink.recordingPath };
  const request: RunRequest = { agent: "codex", prompt: "fixture", model: "fixture", resultJson,
    experimentMcp: "synthetic.json", hermetic: true, sandboxed: true, tools: "none" };
  const finish = spyOn(sink.evidence, "finish").mockImplementation(() => {});
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!earlyEof) stdout.close();
    stderr.close();
    exit(0);
  };
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, stdin: { write() {}, end() {} }, kill: stop,
    exited: new Promise<number>((resolveExit) => { exit = resolveExit; }),
    stdout: new ReadableStream<Uint8Array>({ start(controller) {
      stdout = controller;
      controller.enqueue(Buffer.from('{"type":"thread.started","thread_id":"thread-r"}\n{"type":"turn.started"}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","id":"message-r","text":"partial reply"}}\n'));
      if (earlyEof) controller.close();
    } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => { await sink.close(); }),
    spyOn(sink.evidence, "accept").mockImplementation(() => {}),
    // The relay has already validated the inventory and completed all tool calls.
    spyOn(sink.relay, "finish").mockImplementation(() => {}),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.165.0"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(() =>
      runCapturedCommand(["synthetic-timeout"], { cwd, env: {}, stdoutSink: sink, timeoutMs: 20 })),
    spyOn(processTable, "readProcessTable").mockReturnValue(new Map()),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    expect(result).toMatchObject({ exitCode: 124, success: false });
    expect(finish).toHaveBeenCalledWith(cwd, { timedOut: true });
    expect(sink.relay.failureCode).toBeNull();
    expect(result.stderr).not.toContain("harness_log_missing");
    const records = readFileSync(sink.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((record) => record.kind === "failure")).toBe(false);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", code: null, error: null });
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    stop();
    spawn.mockRestore();
    finish.mockRestore();
    await sink.close().catch(() => {});
    start.mockRestore();
  }
});
