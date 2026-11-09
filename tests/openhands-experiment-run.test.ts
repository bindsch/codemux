import { afterEach, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { OPENHANDS_EXPERIMENT_LIMITATION, refuseOpenhandsExperiment } from "../src/openhands-experiment-run.js";
import { assertExperimentMcpUnavailable, EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import { FEATURE_FLOORS } from "../src/harness-contracts.js";
import { PARITY } from "../src/parity/index.js";
import { registerRunCommand } from "../src/run-command.js";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import { UsageRefusalError } from "../src/validation.js";

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const mock of restores.splice(0).reverse()) mock.mockRestore(); });

test("openhands documents injection separately from unavailable model-bound evidence", () => {
  expect(() => refuseOpenhandsExperiment()).toThrow(UsageRefusalError);
  expect(OPENHANDS_EXPERIMENT_LIMITATION.evidence).toContain("openhands-1.16.0");
  expect(OPENHANDS_EXPERIMENT_LIMITATION.evidence).toContain("_create_mcp_action_type");
  expect(EXPERIMENT_MCP_HARNESSES.openhands).toBeUndefined();
  expect(FEATURE_FLOORS.openhands?.["experiment-mcp"]).toBeUndefined();
  for (const feature of ["run.experiment-mcp", "check.experiment-mcp"] as const) {
    expect(PARITY.openhands[feature]).toMatchObject({ state: "harness-limitation", ...OPENHANDS_EXPERIMENT_LIMITATION });
  }
});

test("openhands refuses before reading a spec or preparing private state", () => {
  for (const name of ["spawn", "spawnSync"] as const) {
    restores.push(spyOn(Bun, name).mockImplementation(() => { throw new Error("unexpected process invocation"); }));
  }
  const request = { agent: "openhands" as const, prompt: "probe", hermetic: true, tools: "none" as const,
    autonomy: "read-only" as const, sandboxed: true, experimentMcp: "/synthetic/missing.json" };
  const adapter = new OpenHandsAdapter({ PATH: "", HOME: "/synthetic/absent" });
  for (const call of [() => assertExperimentMcpUnavailable("openhands", request.experimentMcp),
    () => adapter.validateRunRequest(request), () => adapter.prepareRun(request)]) {
    expect(call).toThrow(OPENHANDS_EXPERIMENT_LIMITATION.refusal);
  }
  expect(() => assertExperimentMcpUnavailable("openhands", undefined)).not.toThrow();
});

for (const command of ["run", "check"] as const) test(`openhands ${command} refuses before a binary or credential probe`, async () => {
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
      await program.parseAsync([command, "-a", "openhands", "--hermetic", "--tools", "none",
        "--experiment-mcp", "/synthetic/missing.json", ...(command === "run" ? ["-p", "probe"] : [])], { from: "user" });
    } catch (error) { if (error !== stopped) throw error; }
    expect(exitCode).toBe(64);
    expect(errors.join("\n")).toContain(OPENHANDS_EXPERIMENT_LIMITATION.refusal);
    expect(errors.join("\n")).toContain("docs/harnesses.md");
  } finally { process.exitCode = previous; }
});
