import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import * as runtime from "../src/cli-runtime.js";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { launchRunRequest } from "../src/launch.js";
import { runCapturedCommand } from "../src/process-runner.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";

const events = [
  { type: "thread.started", thread_id: "thread-prefix" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "reply-prefix", type: "agent_message", text: "retained reply" } },
  { type: "turn.completed", usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2 } },
];

test.each([
  { resultJson: false, suffix: "{broken\n", prefix: events }, { resultJson: true, suffix: "{broken\n", prefix: events },
  { resultJson: false, suffix: "{broken", prefix: events }, { resultJson: true, suffix: "{broken", prefix: events },
  { resultJson: false, suffix: "{broken\n", prefix: [] },
  { resultJson: false, suffix: "{broken\n", prefix: [events[2]!, events[0]!] },
])("Codex launch retains valid output before malformed JSON; resultJson=$resultJson suffix=$suffix", async ({ resultJson, suffix, prefix }) => {
  const parent = resolve("scratch/session-14c66a93/exp/task-q-launch");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const server = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const sink = new ExperimentCodexRun({ name: "experiment", command: process.execPath,
    args: [], env: [], recording: join(cwd, "records") }, cwd, cwd, resultJson, {});
  await sink.prepare();
  const adapter = new CodexAdapter({});
  const context: RunContext = { stdoutSink: sink, experimentCodex: sink, experimentRecording: sink.recordingPath };
  const request: RunRequest = { agent: "codex", prompt: "fixture", cwd, model: "selected-model", resultJson,
    hermetic: true, sandboxed: true, tools: "none", experimentMcp: "synthetic.json" };
  const accepted: unknown[] = [];
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, stdin: { write() {}, end() {} }, exited: Promise.resolve(0), kill() {},
    stdout: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix.map((event) => JSON.stringify(event)).join("\n") + "\n" + suffix));
      controller.close();
    } }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => { await sink.close().catch(() => {}); }),
    spyOn(sink.evidence, "accept").mockImplementation((event) => { accepted.push(event); }),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.165.0"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(() =>
      runCapturedCommand(["synthetic"], { cwd, env: {}, stdoutSink: sink })),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd });
    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(result.stderr).toContain("experiment failure [protocol]");
    expect(accepted).toEqual([...prefix]);
    if (resultJson) {
      const envelope = JSON.parse(result.stdout);
      expect(envelope.result).toBe("retained reply");
      expect(envelope.events).toEqual(events.filter((event) => event.type !== "item.completed"));
      expect(envelope.codemux).toMatchObject({ agent: "codex", model: "selected-model",
        recording: sink.recordingPath, failure_code: "protocol" });
    } else expect(result.stdout).toBe(prefix[0]?.type === "thread.started" ? "retained reply\n" : "");
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    spawn.mockRestore();
    await sink.close().catch(() => {});
    server.mockRestore();
  }
});
