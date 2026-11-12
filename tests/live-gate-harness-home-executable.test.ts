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

test("a failed canary session reports its own error and end events, not quota warnings", async () => {
  const { sessionFailureDetail } = await import("../src/hermetic-session-canary-driver.js");
  const detail = sessionFailureDetail({
    stderr: "Warning: quota gate: opencode: usage unreadable; proceeding\nreal stderr line\n",
    stdout: [
      JSON.stringify({ type: "turn_started", seq: 1 }),
      JSON.stringify({ type: "error", seq: 2, ts: "t", session_id: "s", raw: "x", message: "auth failed", code: "harness" }),
      JSON.stringify({ type: "session_ended", reason: "crash", exit_code: 1, harness_exit: { code: 1, signal: null } }),
      "not json",
    ].join("\n"),
  });
  expect(detail).toEqual([
    "real stderr line",
    'session error: {"type":"error","message":"auth failed","code":"harness"}',
    'session ended: {"reason":"crash","exit_code":1,"harness_exit":{"code":1,"signal":null}}',
  ]);
});

test("the OpenCode caller-home canary carries the authenticated model preference once", async () => {
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { seedHarnessHomeCanary } = await import("../src/hermetic-session-canary-home.js");
  const root = join(process.cwd(), "scratch", "fix", `model-seed-${process.pid}`);
  const authenticated = join(root, "auth"), home = join(root, "caller"), operatorHome = join(root, "operator");
  mkdirSync(join(authenticated, ".local", "state", "opencode"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(operatorHome, { recursive: true });
  const preference = JSON.stringify({ recent: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }] });
  writeFileSync(join(authenticated, ".local", "state", "opencode", "model.json"), preference, { mode: 0o600 });
  const plant = { home, operatorHome, env: {} } as unknown as Parameters<typeof seedHarnessHomeCanary>[1];
  seedHarnessHomeCanary("opencode", plant, authenticated);
  seedHarnessHomeCanary("opencode", plant, authenticated);
  expect(readFileSync(join(home, ".local", "state", "opencode", "model.json"), "utf8")).toBe(preference);
});
