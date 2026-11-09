import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";
import { EXPERIMENT_MCP_HARNESSES, experimentCanaryControl } from "../src/experiment-mcp.js";
import type { RunRequest } from "../src/types.js";

let root: string;
let adapter: ClineAdapter;
let request: RunRequest;
let registeredCline: readonly string[] | undefined;
beforeEach(() => {
  mkdirSync("scratch/fix/w1-fixtures", { recursive: true });
  root = mkdtempSync(resolve("scratch/fix/w1-fixtures/cline-experiment-adapter-"));
  mkdirSync(join(root, "cwd/.git"), { recursive: true });
  mkdirSync(join(root, "home"));
  const spec = join(root, "experiment.json");
  writeFileSync(spec, JSON.stringify({ name: "fixture", command: "/bin/true", args: [], env: [], recording: join(root, "recordings") }));
  adapter = new ClineAdapter({ HOME: join(root, "home"), PATH: "",
    CODEMUX_CLINE_PROVIDER_BASE_URL: "https://fixture.invalid/v1", CODEMUX_CLINE_PROVIDER_API_KEY: "fixture-key",
    CODEMUX_CLINE_PROVIDER_MODEL: "fixture-model" });
  request = { agent: "cline", prompt: "p", cwd: join(root, "cwd"), hermetic: true, sandboxed: true, autonomy: "read-only",
    tools: "none", resultJson: true, experimentMcp: spec };
  // Exercise the proposed registration without changing the shared source.
  registeredCline = (EXPERIMENT_MCP_HARNESSES as Record<string, readonly string[]>).cline;
  (EXPERIMENT_MCP_HARNESSES as Record<string, readonly string[]>).cline = [];
});
afterEach(() => {
  if (registeredCline === undefined) delete (EXPERIMENT_MCP_HARNESSES as Record<string, readonly string[]>).cline;
  else (EXPERIMENT_MCP_HARNESSES as Record<string, readonly string[]>).cline = registeredCline;
  rmSync(root, { recursive: true, force: true });
});

test("owned experiment preparation isolates native tools and refuses an unprepared launch", async () => {
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  context.harnessVersion = "3.0.74";
  const home = context.clineConfig!.home;
  try {
    expect(context.experimentCline).toBeDefined();
    const env = adapter.getRunEnv(request, context);
    expect(env.CLINE_CAPTURE_PROVIDER_REQUEST).toBe("full");
    expect(env.CODEMUX_CLINE_EXPERIMENT_TOKEN).not.toBeEmpty();
    expect(JSON.parse(readFileSync(env.CLINE_MCP_SETTINGS_PATH!, "utf8"))).toEqual({ mcpServers: {} });
    expect(() => adapter.buildRunCommand(request, context)).toThrow("not prepared before command construction");
    Object.defineProperty(context.experimentCline!, "isPrepared", { value: true, configurable: true });
    try { expect(adapter.buildRunCommand(request, context)).toContain(`HOME=${home}`); }
    finally { Reflect.deleteProperty(context.experimentCline!, "isPrepared"); }
    const result = adapter.processRunResult({ success: true, exitCode: 0, stderr: "", stdout:
      JSON.stringify({ type: "run_result", finishReason: "completed", text: "reply" }) }, request, context);
    expect(JSON.parse(result.stdout).codemux.recording).toBe(context.experimentCline!.recordingPath);
    expect(result.scanSurface).toBeDefined();
  } finally { await adapter.cleanupRun(context); }
  expect(existsSync(home)).toBe(false);
});

test("the paired control retains private config while allowing the planted HOME", async () => {
  const control = experimentCanaryControl(request);
  adapter.validateRunRequest(control);
  const context = adapter.prepareRun(control);
  context.harnessVersion = "3.0.74";
  Object.defineProperty(context.experimentCline!, "isPrepared", { value: true, configurable: true });
  try {
    expect(adapter.getRunEnv(control, context).CLINE_DIR).toBe(context.clineConfig!.configDir);
    expect(adapter.buildRunCommand(control, context)[0]).toBe("cline");
  } finally { Reflect.deleteProperty(context.experimentCline!, "isPrepared"); await adapter.cleanupRun(context); }
});

test("the launch sink forwards prompt input and captures native output for verification", async () => {
  const context = adapter.prepareRun(request);
  try {
    expect(context.stdoutSink).toBe(context.experimentCline);
    const input: string[] = [];
    let ended = false;
    context.experimentCline!.start((text) => input.push(text), () => { ended = true; }, () => { throw new Error("unexpected abort"); });
    expect(input).toEqual([request.prompt]);
    expect(ended).toBe(true);
    context.stdoutSink!.push("native output\n");
    expect(context.stdoutSink!.finish({ timedOut: false })).toBe("native output\n");
    expect(context.experimentCline!.capturedOutput).toBe("native output\n");
  } finally { await adapter.cleanupRun(context); }
});

test("invalid experiment preparation removes its private config", () => {
  for (const extra of [{ sandboxed: false }, { tools: "default" as const }, { hermetic: false }, { experimentMcp: join(root, "absent.json") }]) {
    expect(() => adapter.prepareRun({ ...request, ...extra })).toThrow();
    expect(readdirSync(join(root, "home/.cline/.codemux-hermetic"))).toEqual([]);
  }
});
