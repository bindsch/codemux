import { afterEach, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { AgyAdapter } from "../src/adapters/agy.js";
import { AGY_EXPERIMENT_LIMITATION, refuseAgyExperiment } from "../src/agy-experiment-run.js";
import { assertExperimentMcpUnavailable, EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { FEATURE_FLOORS } from "../src/harness-contracts.js";
import { PARITY } from "../src/parity/index.js";
import { registerRunCommand } from "../src/run-command.js";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import { UsageRefusalError } from "../src/validation.js";

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const mock of restores.splice(0).reverse()) mock.mockRestore(); });

test("agy documents injection separately from unavailable model-bound evidence", () => {
  expect(() => refuseAgyExperiment()).toThrow(UsageRefusalError);
  expect(AGY_EXPERIMENT_LIMITATION.evidence).toContain("bin/agy 1.5.3");
  expect(AGY_EXPERIMENT_LIMITATION.evidence).toContain("steps.filterToolParameters");
  expect(EXPERIMENT_MCP_HARNESSES.agy).toBeUndefined();
  expect(FEATURE_FLOORS.agy?.["experiment-mcp"]).toBeUndefined();
  for (const feature of ["run.experiment-mcp", "check.experiment-mcp"] as const) {
    expect(PARITY.agy[feature]).toMatchObject({ state: "harness-limitation", ...AGY_EXPERIMENT_LIMITATION });
  }
});

test("agy refuses before reading a spec or preparing private state", () => {
  for (const name of ["spawn", "spawnSync"] as const) {
    restores.push(spyOn(Bun, name).mockImplementation(() => { throw new Error("unexpected process invocation"); }));
  }
  const request = { agent: "agy" as const, prompt: "probe", hermetic: true, tools: "none" as const,
    autonomy: "read-only" as const, sandboxed: true, experimentMcp: "/synthetic/missing.json" };
  const adapter = new AgyAdapter({ PATH: "", HOME: "/synthetic/absent" });
  for (const call of [() => assertExperimentMcpUnavailable("agy", request.experimentMcp),
    () => adapter.validateRunRequest(request), () => adapter.prepareRun(request)]) {
    expect(call).toThrow(AGY_EXPERIMENT_LIMITATION.refusal);
  }
  expect(() => assertExperimentMcpUnavailable("agy", undefined)).not.toThrow();
});

for (const command of ["run", "check"] as const) test(`agy ${command} refuses before a binary or credential probe`, async () => {
  for (const name of ["spawn", "spawnSync"] as const) {
    restores.push(spyOn(Bun, name).mockImplementation(() => { throw new Error("unexpected process invocation"); }));
  }
  const errors: string[] = [];
  restores.push(spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); }));
  let exitCode: number | undefined;
  const stopped = new Error("synthetic exit");
  restores.push(spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code; throw stopped;
  }) as typeof process.exit));
  const previous = process.exitCode;
  try {
    const program = new Command();
    if (command === "run") registerRunCommand(program, getDefaultConfig(), () => {});
    else registerCheckCommand(program, getDefaultConfig(), () => {});
    try {
      await program.parseAsync([command, "-a", "agy", "--hermetic", "--tools", "none",
        "--experiment-mcp", "/synthetic/missing.json", ...(command === "run" ? ["-p", "probe"] : [])], { from: "user" });
    } catch (error) { if (error !== stopped) throw error; }
    expect(exitCode).toBe(64);
    expect(errors.join("\n")).toContain(AGY_EXPERIMENT_LIMITATION.refusal);
    expect(errors.join("\n")).toContain("docs/harnesses.md");
  } finally { process.exitCode = previous; }
});
