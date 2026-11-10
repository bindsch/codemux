import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import type { CopilotAdapter } from "../src/adapters/copilot.js";
import * as runtime from "../src/cli-runtime.js";
import { launchRunRequest } from "../src/launch.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { RESULT_ANSWER_FIELD } from "../src/result-envelope/index.js";
import { AGENT_IDS, type AgentId, type RunRequest, type RunResult } from "../src/types.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./fixtures/kimi-stream.js";
import { READS_PROMPT } from "./helpers/cli.js";

type Wire = (answer: string) => string;
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const resultLine: Wire = (answer) => lines({ type: "result", subtype: "success", is_error: false, result: answer });

// Native adapter input, not codemux envelopes. Keep every agent literal so
// the parity gate can verify coverage when the supported harnesses change.
const NATIVE_WIRE: Record<AgentId, Wire | null> = {
  agy: (answer) => lines({ event: "init", init: { tools: [] } },
    { event: "result", result: { status: "SUCCESS", response: answer } }),
  aider: null,
  claude: resultLine,
  cline: (answer) => lines({ type: "run_start", sessionId: "synthetic-session" },
    { type: "run_result", finishReason: "completed", text: answer }),
  codex: (answer) => lines(
    { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: answer } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }),
  copilot: (answer) => lines({ type: "assistant.message", data: { content: answer } },
    { type: "result", sessionId: "synthetic-session", exitCode: 0, usage: {} }),
  cursor: resultLine,
  droid: resultLine,
  goose: (answer) => lines({ content: answer, usage: {} }),
  gemini: (answer) => lines({ response: answer, stats: {} }),
  kimi: (answer) => lines({ role: "assistant", content: answer }, kimiResumeHint()),
  openhands: (answer) => lines({ kind: "MessageEvent", source: "agent", llm_message: { content: answer } }),
  opencode: (answer) => lines({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: answer } },
    { type: "step_finish", sessionID: "ses_0123456789abcdef", part: { tokens: { input: 10, output: 2 } } }),
  pi: (answer) => lines({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" } }),
  qwen: (answer) => JSON.stringify([{ type: "result", subtype: "success", is_error: false, result: answer }]) + "\n",
  zai: resultLine,
};

const STRUCTURED_AGENTS = AGENT_IDS.filter((agent) => NATIVE_WIRE[agent] !== null);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
interface Receipt { agent: AgentId; exit_code: number; finish: string | null; sandboxed: boolean }

async function launchSynthetic(
  agent: AgentId,
  stdout: string,
  { resultJson = false, childExit = 0, sandbox = false } = {}
): Promise<{ result: RunResult; receipt: Receipt }> {
  const scratch = join(import.meta.dir, "../scratch/fix");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "result-empty-"));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const ledger = join(home, "calls.jsonl");
  const executable = join(home, "synthetic-harness");
  // The harness reads its prompt first (READS_PROMPT, tests/helpers/cli.ts):
  // one that exited unread raced codemux's stdin write into EPIPE. Aider's
  // stdin repeats and never closes (stdinRepeats), so a read to EOF would
  // never return; one byte is enough there, because the first block is
  // then already in the pipe and the repeats after it tolerate a gone
  // reader (src/process-stdin-repeat.ts).
  const reads = getAdapter(agent, { PATH: "" }).stdinRepeats({ agent, prompt: "" })
    ? "dd bs=1 count=1 >/dev/null 2>&1\n"
    : READS_PROMPT;
  writeFileSync(executable, `#!/bin/sh\n${reads}printf '%s' ${quote(stdout)}\nexit ${childExit}\n`, { mode: 0o700 });
  const env = { HOME: home, PATH: "/usr/bin:/bin", CODEMUX_NO_KEYCHAIN_SYNC: "1" };
  const adapter = getAdapter(agent, env);
  const previousLedger = process.env.CODEMUX_CALL_LOG;
  const previousTestLedger = process.env.CODEMUX_TEST_LEDGER;
  // Kimi reads its native usage log after parsing the resume hint. The
  // fixture supplies that log under the isolated HOME, with no credentials.
  if (agent === "kimi") {
    const wireLog = join(home, ".kimi-code/sessions/workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
    mkdirSync(dirname(wireLog), { recursive: true });
    writeFileSync(wireLog, lines({ type: "usage.record", usageScope: "turn",
      usage: { inputOther: 10, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } }));
  }
  // Only lifecycle and launch configuration are replaced. The child is a
  // real local fixture process and each adapter's actual result parser runs.
  const processResult = spyOn(adapter, "processRunResult");
  const spies: { mockRestore(): void }[] = [
    processResult,
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "beforeLaunch").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue({}),
    spyOn(adapter, "prepareSandbox").mockImplementation(() => {}),
    spyOn(adapter, "getEnv").mockReturnValue({}),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildExecutionEnv").mockReturnValue(env),
    spyOn(adapter, "buildRunCommand").mockReturnValue([executable]),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => {}),
  ];
  if (agent === "copilot") {
    spies.push(spyOn(adapter as CopilotAdapter, "prepareCopilotModelRun").mockImplementation(() => {}));
  }
  if (sandbox) {
    // Exercise the sandbox branch's own postprocessing and receipt, with
    // a synthetic runner seam so no installed scode or harness is invoked.
    spies.push(spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async (command, stdinInput, runCwd, childEnv) =>
      runCapturedCommand(command, { stdinInput, cwd: runCwd ?? cwd, env: childEnv ?? env })));
  }
  try {
    process.env.CODEMUX_CALL_LOG = ledger;
    process.env.CODEMUX_TEST_LEDGER = ledger;
    const request: RunRequest = { agent, prompt: "synthetic empty-answer check", cwd,
      autonomy: "high", resultJson, sandboxed: sandbox };
    const result = await launchRunRequest(adapter, request, { sandbox, requestedAutonomy: "high", cwd });
    expect(processResult).toHaveBeenCalledTimes(1);
    expect(processResult.mock.calls[0]![0].exitCode).toBe(childExit);
    const receipts = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Receipt);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.agent).toBe(agent);
    return { result, receipt: receipts[0]! };
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    if (previousLedger === undefined) delete process.env.CODEMUX_CALL_LOG;
    else process.env.CODEMUX_CALL_LOG = previousLedger;
    if (previousTestLedger === undefined) delete process.env.CODEMUX_TEST_LEDGER;
    else process.env.CODEMUX_TEST_LEDGER = previousTestLedger;
    rmSync(home, { recursive: true, force: true });
  }
}

function expectEmptyFailure(agent: AgentId, result: RunResult, receipt: Receipt): void {
  expect(result.exitCode).toBe(1);
  expect(result.success).toBe(false);
  const diagnostic = `Error: ${agent} exited 0 with an empty answer`;
  expect(result.stderr.split("\n").filter((line) => line === diagnostic)).toEqual([diagnostic]);
  expect(receipt).toMatchObject({ exit_code: 1, finish: "empty-answer" });
}

describe("empty run answers across every adapter", () => {
  test("native fixtures match the result-json capabilities", () => {
    expect(Object.keys(NATIVE_WIRE).sort()).toEqual([...AGENT_IDS].sort());
    for (const agent of AGENT_IDS) {
      expect(Boolean(getAdapter(agent, { PATH: "" }).capabilities().supportsResultJson), agent)
        .toBe(NATIVE_WIRE[agent] !== null);
    }
  });

  for (const agent of AGENT_IDS) {
    for (const [label, output] of [["empty", ""], ["whitespace", " \t\r\n"]] as const) {
      test(`${agent} plain ${label} child output fails and records empty-answer`, async () => {
        const { result, receipt } = await launchSynthetic(agent, output);
        expectEmptyFailure(agent, result, receipt);
        expect(result.stdout.trim()).toBe("");
      });
    }

    test(`${agent} plain empty child exit 7 stays 7 without empty-answer metadata`, async () => {
      const { result, receipt } = await launchSynthetic(agent, "", { childExit: 7 });
      expect(result.exitCode).toBe(7);
      expect(result.success).toBe(false);
      expect(result.stderr).not.toContain("exited 0 with an empty answer");
      expect(receipt).toMatchObject({ exit_code: 7, finish: null });
    });
  }

  for (const agent of STRUCTURED_AGENTS) {
    for (const [label, answer] of [["empty", ""], ["whitespace", " \t\r\n"]] as const) {
      test(`${agent} --result-json native ${label} answer fails with envelope and ledger metadata`, async () => {
        const { result, receipt } = await launchSynthetic(agent, NATIVE_WIRE[agent]!(answer), { resultJson: true });
        expectEmptyFailure(agent, result, receipt);
        const envelope = JSON.parse(result.stdout);
        expect(envelope.codemux).toMatchObject({ agent, empty_answer: true, finish: "empty-answer" });
        expect(envelope[RESULT_ANSWER_FIELD[agent]!].trim()).toBe("");
      });
    }

    test(`${agent} --result-json nonempty native answer remains successful`, async () => {
      const { result, receipt } = await launchSynthetic(agent, NATIVE_WIRE[agent]!("answer"), { resultJson: true });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.success).toBe(true);
      const envelope = JSON.parse(result.stdout);
      expect(envelope[RESULT_ANSWER_FIELD[agent]!].trim()).toBe("answer");
      expect(envelope.codemux.empty_answer).toBeUndefined();
      expect(envelope.codemux.finish).toBeUndefined();
      expect(result.stderr).not.toContain("exited 0 with an empty answer");
      expect(receipt).toMatchObject({ exit_code: 0, finish: null });
    });

    test(`${agent} --result-json empty child exit 7 stays 7`, async () => {
      const { result, receipt } = await launchSynthetic(agent, NATIVE_WIRE[agent]!(""), { resultJson: true, childExit: 7 });
      expect(result.exitCode).toBe(7);
      expect(result.success).toBe(false);
      expect(JSON.parse(result.stdout).codemux.empty_answer).toBeUndefined();
      expect(result.stderr).not.toContain("exited 0 with an empty answer");
      expect(receipt).toMatchObject({ exit_code: 7, finish: null });
    });
  }

  test("cursor sandbox branch rejects an empty native answer and records the same finish", async () => {
    const { result, receipt } = await launchSynthetic("cursor", resultLine(""), { resultJson: true, sandbox: true });
    expectEmptyFailure("cursor", result, receipt);
    expect(JSON.parse(result.stdout).codemux).toMatchObject({ empty_answer: true, finish: "empty-answer" });
    expect(receipt.sandboxed).toBe(true);
  });
});
