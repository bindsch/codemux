import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { MAX_CAPTURE_BYTES, runCapturedCommand, type StdoutSink } from "../src/process-runner.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { launchRunRequest } from "../src/launch.js";
import * as runtime from "../src/cli-runtime.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";

const CODEX_PREFIX = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "partial reply" } },
].map((event) => JSON.stringify(event)).join("\n") + "\n";
const KIMI_PREFIX = '{"role":"assistant","content":"partial reply"}\n';

function syntheticSpawn(chunks: string[], stderr = "") {
  return spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, stdin: { write() { return 0; }, end() { return 0; } }, exited: Promise.resolve(0), kill() {},
    stdout: new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } }),
    stderr: new ReadableStream({ start(controller) {
      if (stderr) controller.enqueue(new TextEncoder().encode(stderr));
      controller.close();
    } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
}

test.each(["kimi", "codex-json", "codex-plain"])("%s sink lets the runner return output limit 125 with partial output", async (mode) => {
  const parent = resolve("scratch/session-14c66a93/exp/output-limit-l");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const spec = { name: "experiment", command: process.execPath, args: [], env: [], recording: join(cwd, "records") };
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const sink = mode === "kimi" ? new ExperimentKimiRun(spec, cwd, cwd, join(cwd, "agent.md"), {}) :
    new ExperimentCodexRun(spec, cwd, cwd, mode === "codex-json", {});
  await sink.prepare();
  const accept = spyOn(sink.evidence, "accept").mockImplementation(() => {});
  const record = spyOn(sink.relay, "record").mockImplementation(() => {});
  const prefix = mode === "kimi" ? KIMI_PREFIX : CODEX_PREFIX;
  const chunk = prefix + "x".repeat(MAX_CAPTURE_BYTES + 1);
  const spawn = syntheticSpawn([chunk]);
  // Relay startup is already mocked. Keep the real sink's capture methods.
  const consumer: StdoutSink = { push: (text) => sink.push(text), finish: (options) => sink.finish(options),
    keptBytes: () => sink.keptBytes(), terminateProtocol: () => sink.terminateProtocol() };
  try {
    const result = await runCapturedCommand(["synthetic-output"], { cwd, env: {}, stdoutSink: consumer });
    expect(result.exitCode).toBe(125);
    expect(result.captureLimitExceeded).toBe(true);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("stdout exceeded the 16777216-byte capture limit");
    expect(result.stdout).toContain("partial reply");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(sink.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
  } finally {
    spawn.mockRestore(); record.mockRestore(); accept.mockRestore();
    await sink.close().catch(() => {}); start.mockRestore();
  }
});

test.each([
  { agent: "kimi", resultJson: false, stream: "stdout" }, { agent: "kimi", resultJson: true, stream: "stdout" },
  { agent: "codex", resultJson: false, stream: "stdout" }, { agent: "codex", resultJson: true, stream: "stdout" },
  { agent: "kimi", resultJson: false, stream: "stderr" }, { agent: "kimi", resultJson: true, stream: "stderr" },
  { agent: "codex", resultJson: false, stream: "stderr" }, { agent: "codex", resultJson: true, stream: "stderr" },
] as const)("$agent launch preserves partial output and exit 125 after $stream overflow; resultJson=$resultJson", async ({ agent, resultJson, stream }) => {
  const parent = resolve("scratch/session-14c66a93/exp/output-limit-l");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "launch-"));
  const spec = { name: "experiment", command: process.execPath, args: [], env: [], recording: join(cwd, "records") };
  const serverStart = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const sink = agent === "kimi" ? new ExperimentKimiRun(spec, cwd, cwd, join(cwd, "agent.md"), {}) :
    new ExperimentCodexRun(spec, cwd, cwd, resultJson, {});
  await sink.prepare();
  const adapter = agent === "kimi" ? new KimiAdapter({}) : new CodexAdapter({});
  const context: RunContext = { stdoutSink: sink, experimentRecording: sink.recordingPath,
    ...(sink instanceof ExperimentKimiRun ? { experimentKimi: sink } : { experimentCodex: sink }) };
  const request: RunRequest = { agent, prompt: "fixture", cwd, model: "selected-model", resultJson,
    hermetic: true, sandboxed: true, tools: "none", experimentMcp: "synthetic.json" };
  const prefix = agent === "kimi" ? KIMI_PREFIX : CODEX_PREFIX;
  const excessive = "x".repeat(MAX_CAPTURE_BYTES + 1);
  const spawn = syntheticSpawn(stream === "stdout" ? [prefix, excessive] : [prefix], stream === "stderr" ? excessive : "");
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => { await sink.close().catch(() => {}); }),
    spyOn(sink.evidence, "accept").mockImplementation(() => {}),
    spyOn(sink.evidence, "finish").mockImplementation(() => {}),
    spyOn(sink.relay, "finish").mockImplementation(() => {}),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue(agent === "codex" ? "0.165.0" : "2.3.2"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => {
      const consumer: StdoutSink = { push: (chunk) => sink.push(chunk), finish: (options) => sink.finish(options),
        keptBytes: () => sink.keptBytes(), terminateProtocol() {} };
      return runCapturedCommand(["synthetic"], { cwd, env: {}, stdoutSink: consumer });
    }),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd });
    expect(result).toMatchObject({ exitCode: 125, success: false });
    expect(result.stderr).toContain(`${stream} exceeded the 16777216-byte capture limit`);
    if (resultJson) {
      const envelope = JSON.parse(result.stdout);
      expect(agent === "kimi" ? envelope.reply : envelope.result).toContain("partial reply");
      expect(envelope.codemux).toMatchObject({ agent, model: "selected-model", recording: sink.recordingPath,
        failure_code: "protocol" });
    } else expect(result.stdout).toBe("partial reply\n");
    expect(sink.relay.failureCode).toBe(Code.Protocol);
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    spawn.mockRestore(); await sink.close().catch(() => {}); serverStart.mockRestore();
  }
});
