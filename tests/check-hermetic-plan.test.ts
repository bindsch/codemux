import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type { BaseAdapter, RunContext } from "../src/adapters/base.js";
import * as adapters from "../src/adapters/index.js";
import * as agyCanary from "../src/agy-isolation-probe.js";
import { registerCheckCommand } from "../src/check-command.js";
import { createHermeticCheckPlan } from "../src/check-hermetic-plan.js";
import * as cliRuntime from "../src/cli-runtime.js";
import { getDefaultConfig } from "../src/config.js";
import { readExperimentRunSpec } from "../src/experiment-mcp.js";
import * as canaries from "../src/hermetic-canary.js";
import * as launcher from "../src/launch.js";
import type { SandboxOptions } from "../src/sandbox.js";
import type { AgentId, RunRequest } from "../src/types.js";
import type { FakeHermeticCheckInput } from "./fixtures/live/fake-hermetic-check.js";

const pairedAgents = ["agy", "aider", "claude", "codex", "copilot", "droid", "gemini", "goose",
  "kimi", "opencode", "openhands", "pi", "zai"] as const;
const nativeGetAdapter = adapters.getAdapter;
const nativePlant = canaries.plantCanary;
type Restorable = { mockRestore(): void };
interface Scope {
  root: string;
  environment: NodeJS.ProcessEnv;
  mocks: Restorable[];
  planted: string[];
  availability: AgentId[];
  adapter(agent: AgentId): BaseAdapter;
}

async function synthetic<T>(run: (scope: Scope) => T | Promise<T>): Promise<T> {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "check-hermetic-plan-"));
  const fakePath = join(root, "fake-bin");
  mkdirSync(fakePath);
  const environment = {
    HOME: root, PATH: fakePath, ZAI_API_KEY: "synthetic-key",
    CODEMUX_GOOSE_PROVIDER_BASE_URL: "http://127.0.0.1:9", CODEMUX_GOOSE_PROVIDER_API_KEY: "synthetic-key",
    CODEMUX_GOOSE_PROVIDER_MODEL: "synthetic-model", CODEMUX_OPENHANDS_PROVIDER_MODEL: "synthetic-model",
    CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "http://127.0.0.1:9", CODEMUX_OPENHANDS_PROVIDER_API_KEY: "synthetic-key",
  };
  const previousEnv = process.env;
  const previousExit = process.exitCode;
  const mocks: Restorable[] = [];
  const planted: string[] = [];
  const availability: AgentId[] = [];
  process.env = environment;
  process.exitCode = 0;
  mocks.push(spyOn(canaries, "plantCanary").mockImplementation((channel, _parent, experiment) => {
    const canary = nativePlant(channel, root, experiment);
    planted.push(canary.cwd);
    return canary;
  }));
  mocks.push(spyOn(agyCanary, "plantAgyCanary").mockImplementation(() => {
    const directory = mkdtempSync(join(root, "agy-"));
    const cwd = join(directory, "work");
    const operatorHome = join(directory, "operator");
    const cleanOperatorHome = join(directory, "clean-operator");
    const marker = "CODEMUX-AGY-CANARY-SYNTHETIC";
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(join(operatorHome, ".gemini"), { recursive: true });
    mkdirSync(cleanOperatorHome);
    writeFileSync(join(operatorHome, ".gemini/GEMINI.md"), `The code word is ${marker}.\n`);
    planted.push(directory);
    return { root: directory, cwd, operatorHome, cleanOperatorHome, marker,
      server: "synthetic-mcp-marker", output: "synthetic-tool-output", toolsPrompt: "synthetic tools",
      cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  }));
  try {
    return await run({ root, environment, mocks, planted, availability, adapter(agent) {
      const adapter = nativeGetAdapter(agent, environment);
      mocks.push(spyOn(adapter, "getEnv").mockReturnValue({}),
        spyOn(adapter, "isAvailable").mockImplementation(() => { availability.push(agent); return true; }),
        spyOn(adapter, "prepareRun").mockImplementation(() => { throw new Error("native preparation is forbidden in this test"); }));
      return adapter;
    } });
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    process.env = previousEnv;
    process.exitCode = previousExit;
    rmSync(root, { recursive: true, force: true });
  }
}

function baseRequest(agent: AgentId): RunRequest {
  return { agent, prompt: "Reply OK", autonomy: "read-only", sandboxed: true, timeoutMs: 9000,
    tools: "default", labels: { test: "synthetic" }, passthroughEnv: [] };
}

const launchOptions = { sandbox: true, requestedAutonomy: "read-only", timeoutMs: 9000, kind: "check" } as const;

function fixtureInvocation(adapter: BaseAdapter, request: RunRequest, cleanControl = false) {
  let context: RunContext = {};
  if (request.agent === "copilot") context = adapter.prepareRun(request);
  if (request.agent === "agy") {
    // Replace private-home preparation with two empty, synthetic homes.
    const root = dirname(request.cwd!);
    context = { agyProbe: { home: join(root, request.hermetic ? "clean-operator" : "operator") } } as RunContext;
  }
  const command = adapter.buildRunCommand(request, context);
  const input: FakeHermeticCheckInput = { agent: request.agent, cwd: request.cwd!, command,
    environment: adapter.buildExecutionEnv({}, request.passthroughEnv), cleanControl };
  return { command, input };
}

async function runCheck(scope: Scope, agent: AgentId, cleanControl = false, extraArgs: string[] = []) {
  const requests: RunRequest[] = [];
  const commands: string[][] = [];
  const answers: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  const validations: RunRequest[] = [];
  const stopped = new Error("synthetic process exit");
  let exit: string | number | null | undefined;
  const version = spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("99.0.0");
  const launch = spyOn(launcher, "launchRunRequest").mockImplementation(async (adapter, request) => {
    requests.push(request);
    const result = fixtureInvocation(adapter, request, cleanControl);
    commands.push(result.command);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/live/fake-hermetic-check.ts")], {
      cwd: request.cwd, env: { HOME: scope.root, PATH: scope.environment.PATH! },
      stdin: Buffer.from(JSON.stringify(result.input)), stdout: "pipe", stderr: "pipe",
    });
    const [answer, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Synthetic harness failed with exit ${code}: ${stderr}`);
    answers.push(answer);
    const stdout = agent === "agy"
      ? [JSON.stringify({ event: "init", init: { tools: [] } }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: answer.trim() } })].join("\n")
      : answer;
    return { stdout, stderr: "", exitCode: 0, success: true };
  });
  const select = spyOn(adapters, "getAdapter").mockImplementation((selected) => {
    const adapter = scope.adapter(selected);
    const validate = adapter.validateRunRequest.bind(adapter);
    scope.mocks.push(spyOn(adapter, "validateRunRequest").mockImplementation((request) => {
      validations.push(request);
      validate(request);
    }));
    return adapter;
  });
  scope.mocks.push(version, launch, select,
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(console, "error").mockImplementation((...args) => { errors.push(args.map(String).join(" ")); }),
    spyOn(console, "log").mockImplementation((...args) => { output.push(args.map(String).join(" ")); }),
    spyOn(process.stdout, "write").mockImplementation((value) => { output.push(String(value)); return true; }),
    spyOn(process.stderr, "write").mockImplementation((value) => { errors.push(String(value)); return true; }),
    spyOn(process, "exit").mockImplementation(((code) => { exit = code; throw stopped; }) as typeof process.exit));
  const program = new Command();
  registerCheckCommand(program, getDefaultConfig(), () => {});
  try {
    await program.parseAsync(["check", "-a", agent, "--hermetic", "--no-quota-gate", ...extraArgs], { from: "user" });
  } catch (error) { if (error !== stopped) throw error; }
  return { requests, commands, answers, validations, errors: errors.join("\n"), output: output.join(""),
    code: exit ?? process.exitCode, version, launch, select };
}

test.each([...pairedAgents])("%s reads the planted channel only in its positive control", async (agent) => {
  await synthetic(async (scope) => {
    const result = await runCheck(scope, agent);
    expect(result.code).toBe(0);
    expect(result.requests).toHaveLength(2);
    expect(result.answers[0]).toBe("OK\n");
    expect(result.answers[1]).toMatch(/^CODEMUX-(?:AGY-)?CANARY-/);
    expect(result.output).toContain(`HERMETIC ${agent}: OK`);
    expect(result.requests[0]!.cwd).toBe(result.requests[1]!.cwd);
    expect(result.requests.map((request) => request.tools)).toEqual([undefined, undefined]);
    for (const path of scope.planted) expect(existsSync(path)).toBe(false);
    if (agent === "copilot") {
      expect(result.requests.map((request) => request.hermetic)).toEqual([true, true]);
      expect(result.commands[0]).toContain("--no-custom-instructions");
      expect(result.commands[1]).not.toContain("--no-custom-instructions");
    } else expect(result.requests.map((request) => Boolean(request.hermetic))).toEqual([true, false]);
  });
});

test.each([...pairedAgents])("%s rejects a clean control that proves no channel was read", async (agent) => {
  await synthetic(async (scope) => {
    const result = await runCheck(scope, agent, true);
    expect(result.code).toBe(1);
    expect(result.requests).toHaveLength(2);
    expect(result.output).not.toContain(`HERMETIC ${agent}: OK`);
    expect(result.errors).toContain(agent === "agy" ? "control failed" : "proved nothing");
    for (const path of scope.planted) expect(existsSync(path)).toBe(false);
  });
});

test("Qwen refuses with exit 64 before version, availability, planting, or launch", async () => {
  await synthetic(async (scope) => {
    const result = await runCheck(scope, "qwen");
    expect(result.code).toBe(64);
    expect(result.errors).toContain("--safe-mode");
    expect(result.errors).toContain("no control run exists");
    expect(result.version).not.toHaveBeenCalled();
    expect(result.launch).not.toHaveBeenCalled();
    expect(scope.availability).toHaveLength(0);
    expect(scope.planted).toHaveLength(0);
  });
});

// The refusal premise is the adapter's own flag: only a harness whose
// plain runs refuse --tools none needs the refusal (gemini gained plain
// tool removal, so its control can retain the selection).
const controlCannotRetainToolsNone = pairedAgents.filter((agent) =>
  nativeGetAdapter(agent, { PATH: "" }).capabilities().toolsNoneRequiresHermetic === true);
test.each(controlCannotRetainToolsNone)("%s refuses tools-none when the control cannot retain it", async (agent) => {
  await synthetic(async (scope) => {
    const result = await runCheck(scope, agent, false, ["--tools", "none"]);
    expect(result.code).toBe(64);
    expect(result.errors).toContain("the control probe would be a plain --tools none run");
    expect(result.version).not.toHaveBeenCalled();
    expect(result.launch).not.toHaveBeenCalled();
    expect(scope.planted).toHaveLength(0);
  });
});

test.each(["claude", "zai", "kimi"] as const)("%s experiment plans retain the spec and tool policy", async (agent) => {
  await synthetic((scope) => {
    const spec = join(scope.root, "spec.json");
    writeFileSync(spec, JSON.stringify({ name: "synthetic", command: process.execPath, args: [], env: [],
      accept_harness_prefix: ["kimi-wall-time"] }));
    const plan = createHermeticCheckPlan(scope.adapter(agent), {
      ...baseRequest(agent), experimentMcp: spec, tools: "none",
    }, launchOptions);
    try {
      expect(plan.probe.request.experimentMcp).toBe(spec);
      expect(plan.control.request.experimentMcp).toBe(spec);
      expect([plan.probe.request.tools, plan.control.request.tools]).toEqual(["none", "none"]);
      expect(readExperimentRunSpec(plan.probe.request).control).toBeUndefined();
      expect(readExperimentRunSpec(plan.control.request).control).toBe(true);
      if (agent === "kimi") {
        expect(plan.control.request.kimiControlBrandHome).toBe(plan.kimiBrandHome);
        expect(plan.control.request.passthroughEnv).toContain("KIMI_CODE_HOME");
      } else expect(existsSync(join(plan.canary.cwd, ".mcp.json"))).toBe(true);
    } finally { plan.canary.cleanup(); }
  });
});

test("hermetic validation uses the managed cwd even when the caller has Gemini execution settings", async () => {
  await synthetic(async (scope) => {
    const caller = join(scope.root, "caller");
    mkdirSync(join(caller, ".gemini"), { recursive: true });
    writeFileSync(join(caller, ".gemini/settings.json"), JSON.stringify({
      mcpServers: { synthetic: { command: "must-not-run" } },
    }));
    const previousCwd = process.cwd();
    process.chdir(caller);
    try {
      const result = await runCheck(scope, "gemini");
      expect(result.code).toBe(0);
      expect(result.validations.length).toBeGreaterThanOrEqual(2);
      for (const request of result.validations) expect(request.cwd).toBe(result.requests[0]!.cwd);
      expect(result.requests[0]!.cwd).not.toBe(caller);
    } finally { process.chdir(previousCwd); }
  });
});

test.each(pairedAgents.filter((agent) => agent !== "agy"))("%s preserves the paired request and launch settings", async (agent) => {
  await synthetic((scope) => {
    const adapter = scope.adapter(agent);
    const base = baseRequest(agent);
    const plan = createHermeticCheckPlan(adapter, base, launchOptions);
    try {
      expect(plan.probe.request).toEqual({ ...plan.control.request, hermetic: true,
        passthroughEnv: base.passthroughEnv });
      expect(plan.probe.launch).toEqual(plan.control.launch);
      expect(plan.probe.launch.cwd).toBe(plan.canary.cwd);
      expect(plan.probe.request.instructionDirs).toEqual([plan.canary.cwd]);
      expect(base.cwd).toBeUndefined();
      expect(base.hermetic).toBeUndefined();
      expect(plan.controlDescription).toContain(agent === "copilot" ? "--no-custom-instructions" : "--hermetic");
    } finally { plan.canary.cleanup(); }
  });
});

const loginRows = [
  { agent: "copilot", source: ".copilot/config.json", target: "config.json" },
  { agent: "gemini", source: ".gemini/oauth_creds.json", target: ".gemini/oauth_creds.json" },
  { agent: "gemini", source: ".gemini/google_accounts.json", target: ".gemini/google_accounts.json" },
  { agent: "droid", source: ".factory/auth.json", target: ".factory/auth.json" },
] as const;
test.each([...loginRows])("$agent copies only its synthetic $source login into disposable state", async ({ agent, source, target }) => {
  await synthetic((scope) => {
    const original = join(scope.root, source);
    mkdirSync(dirname(original), { recursive: true });
    writeFileSync(original, "synthetic-login");
    writeFileSync(join(dirname(original), "unrelated-settings.json"), "must stay outside control");
    const plan = createHermeticCheckPlan(scope.adapter(agent), baseRequest(agent), launchOptions);
    const copied = join(plan.canary.home!, target);
    try {
      expect(readFileSync(copied, "utf8")).toBe("synthetic-login");
      expect(statSync(copied).mode & 0o777).toBe(0o600);
      expect(existsSync(join(dirname(copied), "unrelated-settings.json"))).toBe(false);
      writeFileSync(copied, "synthetic-rotation");
      expect(readFileSync(original, "utf8")).toBe("synthetic-login");
    } finally { plan.canary.cleanup(); }
    expect(existsSync(copied)).toBe(false);
  });
});

test.each(["symlink", "oversize"])("a %s control login refuses setup and removes planted state", async (kind) => {
  await synthetic((scope) => {
    const source = join(scope.root, ".copilot/config.json");
    mkdirSync(dirname(source));
    if (kind === "symlink") {
      const target = join(scope.root, "synthetic-login");
      writeFileSync(target, "synthetic-login");
      symlinkSync(target, source);
    } else writeFileSync(source, Buffer.alloc(1024 * 1024 + 1));
    expect(() => createHermeticCheckPlan(scope.adapter("copilot"), baseRequest("copilot"), launchOptions)).toThrow();
    expect(scope.planted).toHaveLength(1);
    expect(existsSync(scope.planted[0]!)).toBe(false);
  });
});

test("Copilot shares one scratch home and changes only the control instruction flag", async () => {
  await synthetic((scope) => {
    const adapter = scope.adapter("copilot");
    const plan = createHermeticCheckPlan(adapter, baseRequest("copilot"), launchOptions);
    try {
      const retained = join(scope.root, "retained-state");
      const sandbox = { cwd: plan.canary.cwd, harnessStateDirs: [retained] } as SandboxOptions;
      const context = plan.probe.adapter.prepareRun(plan.probe.request, "standard", sandbox);
      expect(context.copilotHermeticHome?.home).toBe(plan.canary.home);
      expect(sandbox.harnessStateDirs).toEqual([retained, plan.canary.home!]);
      context.copilotHermeticHome!.finalize();
      expect(existsSync(plan.canary.home!)).toBe(true);
      const probe = plan.probe.adapter.buildRunCommand(plan.probe.request, context);
      const control = plan.control.adapter.buildRunCommand(plan.control.request, context);
      expect(control).toEqual(probe.filter((arg) => arg !== "--no-custom-instructions"));
      expect(adapter.buildRunCommand(plan.control.request, context)).toContain("--no-custom-instructions");
      expect(() => plan.control.adapter.prepareRun(plan.control.request, "standard",
        { cwd: plan.canary.cwd, blockPaths: [plan.canary.home!] } as SandboxOptions)).toThrow();
    } finally { plan.canary.cleanup(); }
  });
});

test.each([
  { flags: [] },
  { flags: ["--no-custom-instructions", "--no-custom-instructions"] },
])("Copilot refuses a malformed native instruction flag list $flags", async ({ flags }) => {
  await synthetic((scope) => {
    const adapter = scope.adapter("copilot");
    scope.mocks.push(spyOn(adapter, "buildRunCommand").mockReturnValue(["copilot", ...flags]));
    const plan = createHermeticCheckPlan(adapter, baseRequest("copilot"), launchOptions);
    try {
      expect(() => plan.control.adapter.buildRunCommand(plan.control.request)).toThrow("exactly one --no-custom-instructions");
    } finally { plan.canary.cleanup(); }
  });
});

test("a home wrapper forwards native preparation with the scratch write grant", async () => {
  await synthetic((scope) => {
    const adapter = scope.adapter("gemini");
    const context: RunContext = {};
    const prepare = spyOn(adapter, "prepareRun").mockReturnValue(context);
    scope.mocks.push(prepare);
    const plan = createHermeticCheckPlan(adapter, baseRequest("gemini"), launchOptions);
    const sandbox = { cwd: plan.canary.cwd, harnessStateDirs: [] } as SandboxOptions;
    const intent = { printOnly: true };
    try {
      expect(plan.probe.adapter.prepareRun(plan.probe.request, "standard", sandbox, intent)).toBe(context);
      expect(prepare).toHaveBeenCalledWith(plan.probe.request, "standard", sandbox, intent);
      expect(sandbox.harnessStateDirs).toEqual([plan.canary.home!]);
    } finally { plan.canary.cleanup(); }
  });
});

test.each([
  { command: ["env", "GEMINI_CLI_HOME=native-home", "gemini"], preserved: true },
  { command: ["env", "-u", "GEMINI_CLI_HOME", "gemini"], preserved: true },
  { command: ["env", "UNRELATED=kept", "gemini"], preserved: false },
])("a home wrapper keeps one env prefix for $command", async ({ command, preserved }) => {
  await synthetic((scope) => {
    const adapter = scope.adapter("gemini");
    scope.mocks.push(spyOn(adapter, "buildRunCommand").mockReturnValue([...command]));
    const plan = createHermeticCheckPlan(adapter, baseRequest("gemini"), launchOptions);
    try {
      const built = plan.probe.adapter.buildRunCommand(plan.probe.request);
      expect(built.filter((arg) => arg === "env")).toHaveLength(1);
      expect(built).toEqual(preserved ? [...command] : ["env", "UNRELATED=kept", `GEMINI_CLI_HOME=${plan.canary.home}`, "gemini"]);
    } finally { plan.canary.cleanup(); }
  });
});
