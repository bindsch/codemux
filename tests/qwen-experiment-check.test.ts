import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { QwenAdapter } from "../src/adapters/qwen.js";
import * as adapters from "../src/adapters/index.js";
import * as launcher from "../src/launch.js";
import * as runtime from "../src/cli-runtime.js";
import * as canaries from "../src/hermetic-canary.js";
import { createHermeticCheckPlan, assertHermeticCheckSupported } from "../src/check-hermetic-plan.js";
import { readExperimentRunSpec } from "../src/experiment-mcp.js";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import { envProgramIndex } from "../src/executable-security.js";
import type { RunRequest } from "../src/types.js";

const nativePlant = canaries.plantCanary;
type Restore = { mockRestore(): void };
async function synthetic(run: (scope: ReturnType<typeof setup>) => void | Promise<void>): Promise<void> {
  const scope = setup();
  try { await run(scope); }
  finally { for (const mock of scope.mocks.reverse()) mock.mockRestore(); rmSync(scope.root, { recursive: true, force: true }); }
}
function setup() {
  const parent = join(process.cwd(), "scratch", "fix", "qwen-check");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "case-")), mocks: Restore[] = [];
  const spec = join(root, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "test", command: process.execPath, args: [], env: [], recording: join(root, "recordings") }));
  const environment = { PATH: "", HOME: root, QWEN_HOME: join(root, "qwen"),
    CODEMUX_QWEN_PROVIDER_BASE_URL: "http://127.0.0.1:9", CODEMUX_QWEN_PROVIDER_API_KEY: "synthetic-key", CODEMUX_QWEN_PROVIDER_MODEL: "synthetic-model" };
  const adapter = new QwenAdapter((name) => name === "qwen" ? "/synthetic/qwen" : null, environment);
  mocks.push(spyOn(canaries, "plantCanary").mockImplementation((channel, _parent, experiment) => nativePlant(channel, root, experiment)),
    spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("unexpected real process"); }),
    spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("unexpected real process"); }));
  const request: RunRequest = { agent: "qwen", prompt: "probe", experimentMcp: spec,
    autonomy: "read-only", sandboxed: true, tools: "none", hermetic: true };
  return { root, spec, adapter, environment, mocks, request };
}

test("Qwen experiment plan keeps safe mode, the MCP carrier, and tool removal in both runs", async () => synthetic((scope) => {
  expect(() => assertHermeticCheckSupported("qwen")).toThrow("no control run exists");
  expect(assertHermeticCheckSupported("qwen", true).evidence).toContain("QWEN_SYSTEM_MD");
  const plan = createHermeticCheckPlan(scope.adapter, scope.request, { sandbox: true, requestedAutonomy: "read-only" });
  const homes: string[] = [];
  try {
    expect(readExperimentRunSpec(plan.probe.request).control).toBeUndefined();
    expect(readExperimentRunSpec(plan.control.request).control).toBe(true);
    expect(plan.controlDescription).toContain("QWEN_SYSTEM_MD");
    for (const [index, item] of [plan.probe, plan.control].entries()) {
      item.adapter.validateRunRequest(item.request);
      expect(item.request.tools).toBe("none");
      expect(item.request.prompt).not.toContain(plan.canary.marker);
      const context = item.adapter.prepareRun(item.request);
      homes.push(context.experimentQwen!.home);
      try {
        const command = item.adapter.buildRunCommand(item.request, context);
        expect(command).toContain("--safe-mode");
        expect(command).toContain("--mcp-config");
        expect(command).toContain("--exclude-tools");
        const assignment = command.find((arg) => arg.startsWith("QWEN_SYSTEM_MD="));
        if (index === 0) expect(assignment).toBeUndefined();
        else expect(readFileSync(assignment!.slice("QWEN_SYSTEM_MD=".length), "utf8")).toContain(plan.canary.marker);
        expect(command.indexOf("--safe-mode")).toBeGreaterThan(envProgramIndex(command, "test")!);
      } finally { item.adapter.cleanupRunSync(context); }
    }
    expect(homes[0]).not.toBe(homes[1]);
    for (const home of homes) expect(existsSync(home)).toBe(false);
  } finally { plan.canary.cleanup(); }
  expect(existsSync(plan.canary.cwd)).toBe(false);
}));

test("Qwen control can wrap a command without an existing env prefix", async () => synthetic((scope) => {
  scope.mocks.push(spyOn(scope.adapter, "buildRunCommand").mockReturnValue(["/synthetic/qwen", "--safe-mode"]));
  const plan = createHermeticCheckPlan(scope.adapter, scope.request, { sandbox: true, requestedAutonomy: "read-only" });
  try {
    expect(plan.control.adapter.buildRunCommand(plan.control.request)).toEqual([
      "env", `QWEN_SYSTEM_MD=${join(plan.canary.cwd, "QWEN.md")}`, "/synthetic/qwen", "--safe-mode",
    ]);
  } finally { plan.canary.cleanup(); }
}));

for (const outcome of ["success", "clean-control", "probe-leak", "failed-control", "failed-probe"] as const) {
  test(`registered Qwen experiment check handles ${outcome}`, async () => synthetic(async (scope) => {
    const requests: RunRequest[] = [], roots: string[] = [], output: string[] = [], errors: string[] = [];
    const previous = process.exitCode;
    const stopped = new Error("synthetic exit");
    let exit: number | undefined;
    scope.mocks.push(spyOn(adapters, "getAdapter").mockReturnValue(scope.adapter),
      spyOn(runtime, "assertHarnessSupported").mockResolvedValue("0.24.0"),
      spyOn(runtime, "isScodeAvailable").mockReturnValue(true),
      spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); }),
      spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; }),
      spyOn(process.stderr, "write").mockImplementation(() => true),
      spyOn(process, "exit").mockImplementation(((code?: number) => { exit = code; throw stopped; }) as typeof process.exit),
      spyOn(launcher, "launchRunRequest").mockImplementation(async (adapter, request) => {
        requests.push(request); roots.push(request.cwd!);
        const context = adapter.prepareRun(request);
        try {
          const command = adapter.buildRunCommand(request, context);
          expect(command).toContain("--safe-mode");
          const assignment = command.find((arg) => arg.startsWith("QWEN_SYSTEM_MD="));
          const marker = readFileSync(join(request.cwd!, "QWEN.md"), "utf8").match(/CODEMUX-CANARY-[A-F0-9]+/)![0];
          const control = assignment !== undefined;
          let answer = control && outcome !== "clean-control" ? marker : "OK";
          if (!control && outcome === "probe-leak") answer = marker;
          const failure = (control && outcome === "failed-control") || (!control && outcome === "failed-probe");
          return { stdout: answer, stderr: "", success: !failure, exitCode: failure ? 1 : 0 };
        } finally { adapter.cleanupRunSync(context); }
      }));
    try {
      process.exitCode = 0;
      const program = new Command();
      registerCheckCommand(program, getDefaultConfig(), () => {});
      try {
        await program.parseAsync(["check", "-a", "qwen", "--hermetic", "--tools", "none",
          "--experiment-mcp", scope.spec, "--no-quota-gate"], { from: "user" });
      } catch (error) { if (error !== stopped) throw error; }
      expect(exit ?? process.exitCode).toBe(outcome === "success" ? 0 : 1);
      expect(requests).toHaveLength(outcome === "failed-probe" ? 1 : 2);
      for (const root of roots) expect(existsSync(root)).toBe(false);
      if (outcome === "success") expect(output.join("")).toContain("HERMETIC qwen: OK");
      if (outcome === "clean-control") expect(errors.join("\n")).toContain("proved nothing");
      if (outcome === "probe-leak") expect(errors.join("\n")).toContain("NOT hermetic");
    } finally { process.exitCode = previous; }
  }));
}
