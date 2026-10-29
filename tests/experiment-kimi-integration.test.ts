import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { launchRunRequest } from "../src/launch.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { kimiToolName } from "../src/experiment-kimi.js";
import { readExperimentRunSpec } from "../src/experiment-mcp.js";
import * as runtime from "../src/cli-runtime.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest } from "../src/types.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./fixtures/kimi-stream.js";

const contexts: { adapter: KimiAdapter; context: RunContext }[] = [];
afterEach(async () => {
  for (const { adapter, context } of contexts.splice(0)) {
    try { await adapter.cleanupRun(context); } catch { /* Failure fixtures retain their verdict. */ }
  }
});

function setup(resultJson = true) {
  const parent = resolve("scratch/session-14c66a93/exp/kimi-integration");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  const cwd = join(root, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const home = join(root, "operator");
  mkdirSync(join(home, ".kimi-code"), { recursive: true });
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "exp__test", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(root, "recordings"), accept_harness_prefix: ["kimi-wall-time"] }));
  const request: RunRequest = { agent: "kimi", prompt: "fixture", cwd, hermetic: true,
    tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: specPath, resultJson };
  const adapter = new KimiAdapter({ HOME: home }, home);
  return { adapter, request, cwd };
}

test("Kimi accepts the shared experiment request with its own prefix opt-in", () => {
  const { adapter, request } = setup();
  expect(() => adapter.validateRunRequest(request)).not.toThrow();
});

test.each([true, false])("Kimi experiment writes one private authenticated endpoint and no built-ins: JSON=%s", async (json) => {
  const { adapter, request } = setup(json);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  const experiment = context.experimentKimi!;
  expect(experiment).toBeDefined();
  await experiment.prepare();
  const configPath = join(context.kimiHermeticHome!.kimiHome, "mcp.json");
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ mcpServers: { exp__test: {
    url: experiment.relay.url, headers: { Authorization: `Bearer ${experiment.relay.token}` },
    startupTimeoutMs: 120000, toolTimeoutMs: 7200000,
  } } });
  const agent = readFileSync(context.kimiHermeticHome!.agentFile, "utf8");
  expect(agent).toContain('tools: ["mcp__exp_test__*"]');
  expect(agent).toContain("${base_prompt}");
  const command = adapter.buildRunCommand(request, context);
  expect(command).toContain("stream-json");
  expect(command.join(" ")).not.toContain(experiment.relay.token);
  expect(JSON.stringify(adapter.getRunEnv(request, context))).not.toContain(experiment.relay.token);
  const privateHome = context.kimiHermeticHome!.home;
  await expect(adapter.cleanupRun(context)).rejects.toMatchObject({
    code: "protocol", message: "interrupted before verification",
  });
  expect(existsSync(privateHome)).toBe(false);
});

test("programmatic Kimi experiment no-net refuses before preparing state", async () => {
  const { adapter, request } = setup();
  const prepare = spyOn(adapter, "prepareRun");
  try {
    await expect(launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only",
      cwd: request.cwd, sandboxPolicyOverrides: { noNet: true } })).rejects.toThrow("--sandbox-no-net");
    expect(prepare).not.toHaveBeenCalled();
  } finally { prepare.mockRestore(); }
});

test("Kimi experiment launcher requires version 2.3.2 before starting its relay", async () => {
  const { adapter, request } = setup();
  const floor = spyOn(runtime, "assertHarnessSupported").mockImplementation(async (...args) => {
    expect(args[0]).toBe("kimi");
    expect(args[7]).toBe("2.3.2");
    throw new Error("synthetic version refusal");
  });
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true,
      requestedAutonomy: "read-only", cwd: request.cwd });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("synthetic version refusal");
    const envelope = JSON.parse(result.stdout);
    expect(envelope.codemux.recording).toBeString();
    expect(envelope.codemux.failure_code).toBe("protocol");
    expect(floor).toHaveBeenCalledTimes(1);
  } finally { floor.mockRestore(); }
});

test("Kimi usage survives private-home cleanup after an experiment verification failure", async () => {
  const { adapter, request } = setup();
  const context = adapter.prepareRun({ ...request, experimentMcp: undefined });
  contexts.push({ adapter, context });
  const path = join(context.kimiHermeticHome!.kimiHome,
    "sessions/workspace/session_fixture/agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "usage.record", usage: {
    inputOther: 10, output: 2, inputCacheRead: 3, inputCacheCreation: 1,
  } }) + "\n");
  const experiment = context.experimentKimi = new ExperimentKimiRun(readExperimentRunSpec(request), request.cwd!,
    context.kimiHermeticHome!.kimiHome, context.kimiHermeticHome!.agentFile, {});
  await expect(experiment.complete()).rejects.toThrow();
  expect(experiment.foldedUsage()?.total_tokens).toBe(16);
  adapter.cleanupRunSync(context);
  expect(existsSync(path)).toBe(false);
  expect(experiment.foldedUsage()?.total_tokens).toBe(16);
  const records = readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const copied = records.filter((record) => record.kind === "harness_log_copy");
  expect(copied).toHaveLength(1);
  expect(copied[0]).toMatchObject({ harness: "kimi", path: experiment.recordingPath.replace(/\.jsonl$/, ".kimi-wire.jsonl"), bytes: expect.any(Number) });
  expect(statSync(copied[0].path).mode & 0o777).toBe(0o600);
  expect(readFileSync(copied[0].path, "utf8")).toContain('"usage.record"');
});

test.each([false, true])("a Kimi experiment reports result normalization failures in its output; JSON=%s", (resultJson) => {
  const { adapter, request } = setup(resultJson);
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  const stdout = JSON.stringify({ role: "assistant", content: "OK" }) + "\n";
  const result = adapter.processRunResult({ success: true, exitCode: 0, stdout, stderr: "" }, request, context);
  expect(result).toMatchObject({ success: false, exitCode: 1, reply: "OK\n" });
  expect(result.stderr).toContain("session.resume_hint");
  expect(context.experimentKimi!.relay.failureError).toMatchObject({
    code: "protocol", message: expect.stringContaining("session.resume_hint"),
  });
  if (resultJson) expect(JSON.parse(result.stdout)).toMatchObject({ reply: "OK\n", codemux: { failure_code: "protocol" } });
  else expect(result.stdout).toBe("OK\n");
});

test("Kimi evidence completion leaves recording open until result normalization succeeds", async () => {
  const { adapter, request } = setup();
  const context = adapter.prepareRun(request);
  contexts.push({ adapter, context });
  const experiment = context.experimentKimi!;
  await experiment.prepare();
  const response = await fetch(experiment.relay.url, { method: "POST", headers: {
    Authorization: `Bearer ${experiment.relay.token}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect(response.status).toBe(200);
  const listed = await response.json() as { result: { tools: { name: string; description?: string; inputSchema: unknown }[] } };
  const usage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  const content = [{ type: "text", text: "OK" }];
  const wire = join(context.kimiHermeticHome!.kimiHome, "sessions", "workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(wire), { recursive: true });
  writeFileSync(wire, [
    { type: "llm.tools_snapshot", tools: listed.result.tools.map((tool) => ({
      name: kimiToolName("exp__test", tool.name), description: tool.description ?? "", parameters: tool.inputSchema })) },
    { type: "context.append_loop_event", time: 1000, event: { type: "content.part", stepUuid: "step-1", part: content[0] } },
    { type: "context.append_loop_event", time: 1000, event: { type: "step.end", uuid: "step-1", usage } },
    { type: "agent.message.appended", message: { message: { role: "assistant", content, toolCalls: [] }, meta: { usage } } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const stdout = [JSON.stringify({ role: "assistant", content: "OK" }),
    JSON.stringify(kimiResumeHint())].join("\n") + "\n";
  experiment.push(stdout);
  await experiment.complete();
  const recorded = () => readFileSync(experiment.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const copy = recorded().find((record) => record.kind === "harness_log_copy");
  expect(copy).toMatchObject({ harness: "kimi", bytes: statSync(wire).size });
  expect(readFileSync(copy.path)).toEqual(readFileSync(wire));
  expect(statSync(copy.path).mode & 0o777).toBe(0o600);
  expect(recorded().some((record) => record.kind === "run_end")).toBe(false);
  expect(adapter.processRunResult({ success: true, exitCode: 0, stdout, stderr: "" }, request, context).success).toBe(true);
  await adapter.cleanupRun(context);
  expect(recorded().filter((record) => record.kind === "harness_log_copy")).toHaveLength(1);
  expect(existsSync(copy.path)).toBe(true);
  expect(recorded().at(-1)).toMatchObject({ kind: "run_end", code: null, error: null });
});
