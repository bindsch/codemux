import { expect, test } from "bun:test";
import { join } from "node:path";
import { applyHarnessHomeSandboxBlocks, harnessHomeBlockedPaths } from "../src/launch/harness-home-sandbox.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { strictLaunchFailureExitCode } from "../src/sandbox-command.js";
import { AGENT_IDS } from "../src/types.js";
import fixture from "./fixtures/live/live-gate-2.0.1-failures.json";

test("live K denial: reopen the executable inside the blocked store, never the store", () => {
  const operator = join(process.cwd(), "scratch/fix/operator");
  const binary = fixture.opencodeK.replace("env: ", "").replace(": Operation not permitted", "")
    .replace("<operator>", operator);
  const privateHome = join(process.cwd(), "scratch/fix/caller");
  const options: SandboxOptions = {};
  const blocks = harnessHomeBlockedPaths({ HOME: operator }, operator);
  applyHarnessHomeSandboxBlocks(options, privateHome, blocks);
  // The live command wraps the native binary in env to relocate HOME/XDG.
  const command = ["/usr/bin/env", `HOME=${privateHome}`, binary, "run"];
  const argv = buildScodeCommand(command, process.cwd(), "read-only", options);
  const values = (flag: string) => argv.flatMap((arg, i) => arg === flag ? [argv[i + 1]] : []);
  expect(values("--block")).toContain(join(operator, ".opencode"));
  expect(values("--allow")).toEqual([privateHome, binary]);
  expect(values("--allow")).not.toContain(join(operator, ".opencode/bin"));
  expect(() => buildScodeCommand(command, process.cwd(), "read-only", { ...options, strict: true }))
    .toThrow("writable executable grant");
  expect(() => buildScodeCommand(command, process.cwd(), "read-only", {
    ...options, callerBlockPaths: [join(operator, ".opencode")],
  })).toThrow("--sandbox-block");
  // Session turns report this refusal as exit 64, like the strict-grant refusal.
  let refusal: unknown;
  try {
    buildScodeCommand(command, process.cwd(), "read-only", { ...options, callerBlockPaths: [join(operator, ".opencode")] });
  } catch (error) {
    refusal = error;
  }
  expect(strictLaunchFailureExitCode(refusal)).toBe(64);
});

test.each([...AGENT_IDS])("%s harness-home grants only resolved command files under operator blocks", (agentId) => {
  const store = join(process.cwd(), "scratch/fix/operator", `.${agentId}`);
  const binary = join(store, "bin", agentId);
  const privateHome = join(process.cwd(), "scratch/fix/caller");
  const options: SandboxOptions = { agentId };
  applyHarnessHomeSandboxBlocks(options, privateHome, [store]);
  const argv = buildScodeCommand(["/usr/bin/env", `HOME=${privateHome}`, binary], undefined, "read-only", options);
  expect(argv.slice(argv.indexOf("--allow"))).toEqual([
    "--allow", privateHome, "--allow", binary, "--", "/usr/bin/env", `HOME=${privateHome}`, binary,
  ]);
  const outside = buildScodeCommand(["/usr/bin/synthetic"], undefined, "read-only", options);
  expect(outside.filter((arg) => arg === "--allow")).toHaveLength(1);
});
