import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import * as runtime from "../src/cli-runtime.js";
import { validateExperimentRequest } from "../src/experiment-mcp.js";
import { launchRunRequest } from "../src/launch.js";
import { runCapturedCommand } from "../src/process-runner.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { validatePrompt } from "../src/validation.js";

function fixture(agent: RunRequest["agent"] = "codex") {
  const parent = resolve("scratch/session-14c66a93/exp/task-o");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const spec = join(cwd, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [], env: [], accept_harness_prefix: ["codex-wall-time", "kimi-wall-time"] }));
  const request: RunRequest = { agent, prompt: "fixture", cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: spec };
  return { cwd, request };
}

test("Codex experiment accepts a 2 MiB stdin prompt and retains the general limit", () => {
  const { request } = fixture();
  const prompt = "x".repeat(2 * 1024 * 1024);
  expect(validatePrompt(prompt)).toBe(prompt);
  expect(new CodexAdapter({}).getStdinInput({ ...request, prompt })).toBe(prompt);
  expect(() => validateExperimentRequest({ ...request, prompt })).not.toThrow();
  expect(() => validatePrompt("x".repeat(16 * 1024 * 1024 + 1))).toThrow("byte limit");
});

test.each(["claude", "zai"] as const)("%s experiment retains its control-frame prompt limit", (agent) => {
  const { request } = fixture(agent);
  expect(() => validateExperimentRequest({ ...request, prompt: "x".repeat(1024 * 1024) }))
    .toThrow("control frame limit");
});

test("Kimi experiment retains its argv bound instead of the control-frame bound", () => {
  const { request } = fixture("kimi");
  const prompt = "x".repeat(2 * 1024 * 1024);
  expect(() => validateExperimentRequest({ ...request, prompt })).not.toThrow();
  expect(() => new KimiAdapter({}).validateRunRequest({ ...request, prompt }))
    .toThrow("32768-byte safe limit");
});

test("native experiment exit 125 with bounded output is processed and verified", async () => {
  const { cwd, request } = fixture();
  const adapter = new CodexAdapter({});
  let verifies = 0;
  const context = { experimentCodex: { failureError: null, prepare: async () => {},
    verify: async () => { verifies++; } } } as unknown as RunContext;
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, stdin: { write() {}, end() {} }, exited: Promise.resolve(125), kill() {},
    stdout: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("bounded output\n")); controller.close();
    } }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic"]),
    spyOn(adapter, "cleanupRun").mockImplementation(() => {}),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.165.0"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(() =>
      runCapturedCommand(["synthetic"], { cwd, env: {} })),
  ];
  const processResult = spyOn(adapter, "processRunResult").mockImplementation((result) => result);
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only", cwd });
    expect(result).toMatchObject({ exitCode: 125, success: false, stdout: "bounded output\n", stderr: "" });
    expect(result.captureLimitExceeded).toBeUndefined();
    expect(processResult).toHaveBeenCalledTimes(1);
    expect(verifies).toBe(1);
  } finally {
    processResult.mockRestore();
    for (const spy of spies.reverse()) spy.mockRestore();
    spawn.mockRestore();
  }
});

test("usage guide requires both missing usage and no calls for a Kimi retry", () => {
  const guide = readFileSync(resolve("docs/results-and-usage.md"), "utf8");
  expect(guide).toContain("fails without usage and without tool calls emits `harness_retry`");
  expect(guide).toContain("An error step with tool calls emits a `turn`");
});
