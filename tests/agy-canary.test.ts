import { summarizeAgyStream } from "../src/agy-stream.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter, markAgyIsolationProbe } from "../src/adapters/agy.js";
import { evaluateAgyProbe, plantAgyCanary, runAgyIsolationProbe, summarizeAgyProbe } from "../src/agy-isolation-probe.js";
import { launchRunRequest } from "../src/launch.js";
import { buildScodeCommand } from "../src/sandbox.js";
import { verifyAgentWiring } from "../src/verify.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "agy-candidate-test-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  const request: RunRequest = { agent: "agy", cwd, prompt: "Reply OK", autonomy: "read-only", sandboxed: true };
  return { home, cwd, request, adapter: new AgyAdapter({ HOME: home, GEMINI_API_KEY: "synthetic-api-key" }) };
}
function native(response = "OK", denied_actions: object[] = [], step?: string, init = {}) {
  return [{ event: "init", init }, ...(step ? [{ event: "step_update", step_update: { step_type: step } }] : []),
    { event: "result", result: { status: "SUCCESS", response, denied_actions } }]
    .map((frame) => JSON.stringify(frame)).join("\n");
}
const result = (stdout: string, exitCode = 0): RunResult => ({ stdout, stderr: "", exitCode, success: exitCode === 0 });

test("tools none refuses a result without native initialization", () => {
  const { adapter, request } = setup();
  request.tools = "none";
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  const stdout = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "OK" } });
  expect(summarizeAgyStream(stdout).malformed).toBe(true);
  const processed = adapter.processRunResult(result(stdout), request, context);
  expect(processed.exitCode).toBe(1);
  expect(processed.stderr).toContain("malformed native event stream");
});

test("the canary git boundary excludes unrelated ancestor instructions", () => {
  const { adapter, request } = setup();
  const canary = plantAgyCanary();
  cleanup.push(canary.cleanup);
  for (const name of ["AGENTS.md", "GEMINI.md"]) writeFileSync(join(canary.root, name), "unrelated");
  mkdirSync(join(canary.root, ".agents"));
  expect(() => adapter.validateRunRequest({ ...request, cwd: canary.cwd, hermetic: true })).not.toThrow();
});

test.each(["hermetic", "tools", "control", "tools-control", "login"])("%s probe launches a request with truthful isolation flags", async (mode) => {
  let seen: RunRequest | undefined;
  const validate = spyOn(AgyAdapter.prototype, "validateRunRequest").mockImplementation((request) => {
    seen = request;
    throw new Error("stop before spawn");
  });
  try {
    await expect(runAgyIsolationProbe(mode, 1000)).rejects.toThrow("stop before spawn");
    expect(seen?.hermetic).toBe(mode === "hermetic");
    expect(seen?.tools).toBe(mode === "tools" ? "none" : undefined);
  } finally { validate.mockRestore(); }
});

test("the hermetic probe and control ledger preserve their actual isolation modes", async () => {
  const { home } = setup();
  const ledger = join(home, "calls.jsonl");
  const response = await runCli(["check", "-a", "agy", "--hermetic"], { ...fake(), CODEMUX_CALL_LOG: ledger });
  expect(response.exitCode).toBe(0);
  const records = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.map((record) => [record.kind, record.hermetic, record.exit_code])).toEqual([
    ["check", true, 0], ["check", false, 0],
  ]);
});

test.each(["GEMINI.md", "AGENTS.md", ".agents"])("hermetic agy names forbidden %s, including ancestors and symlinks", (name) => {
  const { adapter, request, cwd, home } = setup();
  expect(() => adapter.validateRunRequest({ ...request, hermetic: true, cwd: undefined })).toThrow("explicit --cwd");
  const path = join(cwd, name);
  if (name === ".agents") mkdirSync(path); else symlinkSync(join(home, "absent"), path);
  expect(() => adapter.validateRunRequest({ ...request, hermetic: true })).toThrow(path);
  const nested = join(cwd, "nested");
  mkdirSync(nested);
  expect(() => adapter.validateRunRequest({ ...request, cwd: nested, hermetic: true })).toThrow(path);
});

test("hermetic canary isolates planted operator state without writing the real operator home", () => {
  const { adapter, request, home } = setup();
  const canary = plantAgyCanary();
  cleanup.push(canary.cleanup);
  expect(readdirSync(canary.cwd)).toEqual([".git"]);
  expect(readFileSync(join(canary.operatorHome, ".gemini/GEMINI.md"), "utf8")).toContain(canary.marker);
  expect(readFileSync(join(canary.operatorHome, ".gemini/antigravity-cli/settings.json"), "utf8")).toContain(canary.server);
  request.cwd = canary.cwd;
  markAgyIsolationProbe(request, "hermetic", canary.operatorHome);
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  expect(realpathSync(context.agyProbe!.home!)).toStartWith(realpathSync(join(canary.operatorHome, ".gemini")));
  expect(readdirSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli"))).toEqual([]);
  expect(existsSync(join(home, ".gemini"))).toBe(false);
  const control = { ...request };
  markAgyIsolationProbe(control, "control", canary.operatorHome);
  const controlContext = adapter.prepareRun(control);
  cleanup.push(() => adapter.cleanupRun(controlContext));
  expect(adapter.buildRunCommand(control, controlContext)).toContain(`HOME=${controlContext.agyProbe!.home}`);
  expect(readFileSync(join(controlContext.agyProbe!.home!, ".gemini/GEMINI.md"), "utf8")).toContain(canary.marker);
  expect(evaluateAgyProbe("hermetic", result(native()), canary)).toBe(true);
  expect(evaluateAgyProbe("hermetic", result(native(canary.marker)), canary)).toBe(false);
  expect(evaluateAgyProbe("hermetic", result(native("OK", [], undefined, { mcp_servers: [canary.server] })), canary)).toBe(false);
  expect(evaluateAgyProbe("control", result(native()), canary)).toBe(false);
  expect(evaluateAgyProbe("control", result(native(canary.marker)), canary)).toBe(true);
});

test("public tools none installs all denials and rejects native attempts in plain and JSON results", () => {
  const { adapter, request } = setup();
  request.tools = "none";
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  const settings = JSON.parse(readFileSync(join(context.agyProbe!.home!, ".gemini/antigravity-cli/settings.json"), "utf8"));
  expect(settings.permissions.deny).toEqual([
    "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "command(*)", "unsandboxed(*)", "mcp(*)",
  ]);
  expect(adapter.buildRunCommand(request, context)).toContain("--mode=plan");
  for (const resultJson of [false, true]) {
    for (const [stdout, action] of [[native("OK", [{ action: "command" }]), "command"],
      [native("OK", [], "future_action"), "future_action"]]) {
      const processed = adapter.processRunResult(result(stdout!), { ...request, resultJson }, context);
      expect(processed.success).toBe(false);
      expect(processed.exitCode).toBe(1);
      expect(processed.stderr).toContain(`attempted actions: ${action}`);
    }
    expect(adapter.processRunResult(result(native()), { ...request, resultJson }, context).success).toBe(true);
  }
  expect(summarizeAgyProbe(native("OK", [{}])).possibleToolActivity).toBe(true);
  expect(summarizeAgyProbe(native("OK", [], "checkpoint")).possibleToolActivity).toBe(true);
  expect(adapter.processRunResult(result("broken"), request, context).success).toBe(false);
});

test("tools probe needs a denied command and its control needs native activity plus actual output", () => {
  const { adapter, request } = setup();
  const canary = plantAgyCanary();
  cleanup.push(canary.cleanup);
  expect(canary.toolsPrompt).not.toContain(canary.output);
  expect(evaluateAgyProbe("tools", result(native("", [{ action: "command" }]), 1), canary)).toBe(true);
  expect(evaluateAgyProbe("tools", result(native("NO_TOOLS")), canary)).toBe(false);
  expect(evaluateAgyProbe("tools", result(native(canary.output, [{ action: "command" }])), canary)).toBe(false);
  expect(evaluateAgyProbe("tools-control", result(native(canary.output)), canary)).toBe(false);
  const commandOutput = native(canary.output).replace('\n', '\n' + JSON.stringify({ event: "step_update",
    step_update: { step_type: "tool", tool_name: "run_command", state: "DONE", tool_info: { output: canary.output } } }) + '\n');
  expect(evaluateAgyProbe("tools-control", result(commandOutput), canary)).toBe(true);
  markAgyIsolationProbe(request, "tools-control", canary.cleanOperatorHome);
  const context = adapter.prepareRun(request);
  cleanup.push(() => adapter.cleanupRun(context));
  const cmd = adapter.buildRunCommand(request, context);
  expect(cmd).toContain("--dangerously-skip-permissions");
  expect(cmd).not.toContain("--mode=plan");
});

function fake(scodeVersion = "0.6.0"): Record<string, string> {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const state = mkdtempSync(join(tmpdir(), "agy-canary-security-"));
  cleanup.push(() => rmSync(state, { recursive: true, force: true }));
  const env = createFakeBinaryEnv({
    agy: `exec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fixtures/agy-canary.ts"))} "$@"`,
    security: `exec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fixtures/agy-security.ts"))} "$@"`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  }, scodeVersion);
  cleanup.push(env.cleanup);
  return { ...env.env, GEMINI_API_KEY: "synthetic-api-key", AGY_TEST_SECRET: "synthetic-keychain-token",
    AGY_TEST_CALLS: join(state, "security.jsonl") };
}

test("any non-command attempt or completed non-text step fails the tools canary", () => {
  const canary = plantAgyCanary();
  cleanup.push(canary.cleanup);
  const denied = { step_type: "run_command", step_index: 2, state: "ERROR",
    tool_info: { error: { message: "Permission denied for command(probe)" } } };
  for (const step_type of ["read_file", "write_file", "mcp", "unknown_tool", "tool"]) {
    for (const state of ["ACTIVE", "DONE", "ERROR"]) {
      for (const step_index of [1, 2]) {
        const other = { step_type, state, step_index };
        for (const steps of [[other, denied], [denied, other]]) {
          const stdout = [{ event: "init", init: {} },
            ...steps.map((step_update) => ({ event: "step_update", step_update })),
            { event: "result", result: { status: "ERROR", response: "denied" } },
          ].map((frame) => JSON.stringify(frame)).join("\n");
          expect(evaluateAgyProbe("tools", result(stdout, 1), canary)).toBe(false);
        }
      }
    }
  }
});

test.each(["read_file", "write_file", "mcp"])("a %s denial cannot certify the command canary", (action) => {
  const canary = { marker: "marker", server: "server", output: "expected-command-output" };
  for (const denied of [[{ action }], [{ action: "command" }, { action }]]) {
    expect(evaluateAgyProbe("tools", result(native("denied", denied, "tool"), 1), canary)).toBe(false);
  }
});

test("tools control requires the output from a completed command step, not assistant or file output", () => {
  const canary = { marker: "marker", server: "server", output: "expected-command-output" };
  const output = (tool: string, state: string, nativeOutput: string) => [
    { event: "init", init: { tools: ["read_file", "run_command"] } },
    { event: "step_update", step_update: { step_type: "tool", tool_name: tool, state, tool_info: { name: tool, output: nativeOutput } } },
    { event: "result", result: { status: "SUCCESS", response: canary.output } },
  ].map((frame) => JSON.stringify(frame)).join("\n");
  expect(evaluateAgyProbe("tools-control", result(output("read_file", "DONE", canary.output)), canary)).toBe(false);
  expect(evaluateAgyProbe("tools-control", result(output("run_command", "ACTIVE", canary.output)), canary)).toBe(false);
  expect(evaluateAgyProbe("tools-control", result(output("run_command", "DONE", "unrelated")), canary)).toBe(false);
  expect(evaluateAgyProbe("tools-control", result(output("run_command", "DONE", canary.output)), canary)).toBe(true);
});

test("a native run_command permission refusal certifies command denial", () => {
  const canary = { marker: "marker", server: "server", output: "expected-command-output" };
  const stdout = [
    { event: "init", init: {} },
    { event: "step_update", step_update: { step_type: "tool", tool_name: "run_command", state: "ERROR",
      tool_info: { error: { message: "Permission denied" } } } },
    { event: "result", result: { status: "ERROR", response: "denied" } },
  ].map((frame) => JSON.stringify(frame)).join("\n");
  expect(evaluateAgyProbe("tools", result(stdout, 1), canary)).toBe(true);
  expect(evaluateAgyProbe("tools", result(stdout.replace("run_command", "read_file"), 1), canary)).toBe(false);
  const unrelated = JSON.stringify({ event: "step_update", step_update: { step_type: "tool", tool_name: "read_file",
    state: "ERROR", tool_info: { error: { message: "Permission denied" } } } });
  expect(evaluateAgyProbe("tools", result(stdout.replace('\n', '\n' + unrelated + '\n'), 1), canary)).toBe(false);
});

test("tools probe accepts only one denied command attempt and rejects execution anywhere", () => {
  const canary = { marker: "marker", server: "server", output: "expected-command-output" };
  const denied = { step_type: "tool", tool_name: "run_command", step_index: 2, state: "ERROR",
    tool_info: { error: { message: "Permission denied for command(echo x)" } } };
  const stream = (steps: object[]) => [
    { event: "init", init: {} },
    ...steps.map((step_update) => ({ event: "step_update", step_update })),
    { event: "result", result: { status: "ERROR", response: "denied" } },
  ].map((frame) => JSON.stringify(frame)).join("\n");
  for (const command of [{ step_type: "run_command" }, { step_type: "command" },
    { step_type: "tool", tool_name: "run_command" }, { step_type: "tool", tool_info: { name: "command" } }]) {
    for (const evidence of [{ state: "DONE" }, { state: "ACTIVE", tool_info: { output: "unrelated" } },
      { state: "ERROR", tool_info: { output: "", error: { message: "Permission denied" } } }]) {
      const executed = { ...command, ...evidence, step_index: 1,
        tool_info: { ...command.tool_info, ...("tool_info" in evidence ? evidence.tool_info : {}) } };
      for (const steps of [[executed, denied], [denied, executed]]) {
        expect(evaluateAgyProbe("tools", result(stream(steps), 1), canary)).toBe(false);
      }
    }
  }
  expect(evaluateAgyProbe("tools", result(stream([{ ...denied, step_index: 1 }, denied]), 1), canary)).toBe(false);
  expect(evaluateAgyProbe("tools", result(native("denied", [{ action: "command" }, { action: "command" }]), 1), canary)).toBe(false);
  expect(evaluateAgyProbe("tools", result(stream([
    { step_type: "run_command", step_index: 2, state: "ACTIVE" }, denied,
  ]), 1), canary)).toBe(true);
});

test.each([{ flags: ["--hermetic"] }, { flags: ["--tools", "none"] }, { flags: ["--hermetic", "--tools", "none"] }])(
  "public agy check runs paired candidate canaries: %j", async ({ flags }: { flags: readonly string[] }) => {
    const response = await runCli(["check", "-a", "agy", ...flags], fake());
    expect(response.exitCode).toBe(0);
    if (flags.includes("--hermetic")) expect(response.stdout).toContain("HERMETIC agy: OK");
    if (flags.includes("--tools")) expect(response.stdout).toContain("TOOLS agy: OK");
  });

test.each(["API key", "file token", "Keychain"])("sandboxed agy with %s refuses old scode before launch", async (login) => {
  const { cwd, home } = setup();
  if (login === "file token") {
    const state = join(home, ".gemini/antigravity-cli");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "antigravity-oauth-token"), "synthetic-file-token");
  }
  const response = await runCli(["run", "-a", "agy", "--cwd", cwd, "-p", "OK"], {
    ...fake("0.5.0"), HOME: home, GOOGLE_API_KEY: "", GEMINI_API_KEY: login === "API key" ? "synthetic-api-key" : "",
  });
  expect(response.exitCode).not.toBe(0);
  expect(response.stderr).toContain("every sandboxed agy run requires scode 0.6.0 or newer");
  expect(response.stdout).toBe("");
  const authentication = readFileSync(join(import.meta.dir, "../docs/authentication.md"), "utf8");
  expect(authentication).toMatch(/Every sandboxed Antigravity headless run.*requires scode 0\.6\.0 or newer/);
});

test("agy isolation cannot attest a different cwd or writable sandbox", async () => {
  const { adapter, request, cwd } = setup();
  request.hermetic = true;
  for (const options of [{ cwd, requestedAutonomy: "high" as const },
    { cwd: tmpdir(), requestedAutonomy: "read-only" as const }]) {
    await expect(launchRunRequest(adapter, request, { sandbox: true, ...options })).rejects.toThrow("run's own working directory");
  }
});

test("Antigravity documentation separates supported policy from dated live evidence", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/isolation.md"), "utf8");
  expect(doc).toContain("| Antigravity |");
  expect(doc).toContain("read-only scode");
  expect(doc).toContain("Tool schemas can remain visible");
  const report = readFileSync(join(import.meta.dir, "../docs/experiment-mcp-report.md"), "utf8");
  const outcome = report.split("## Outcome")[1]!.split("\n## ")[0]!;
  expect(outcome).toContain("Round 11");
  expect(outcome).toContain("They were not included in that");
  expect(outcome).not.toMatch(/\d+ pass/);
});

test("Antigravity compatibility evidence does not renew the historical live claim", () => {
  const compatibility = readFileSync(join(import.meta.dir, "../docs/harnesses.md"), "utf8");
  const row = compatibility.split("\n").find((line) => line.startsWith("| Antigravity CLI |"))!;
  expect(row).toContain("1.3.3, 2026-10-13");
  expect(row).toContain("Round 11");
  expect(row).toContain("Later hardening was not live-retested");
  const report = readFileSync(join(import.meta.dir, "../docs/experiment-mcp-report.md"), "utf8");
  expect(report).toContain("> Historical report:");
  expect(report).toContain("[experiment MCP](experiment-mcp.md)");
  expect(report).toContain("**unavailable**");
});

test("the capability test comment records the supported policies", () => {
  const source = readFileSync(join(import.meta.dir, "new-adapters.test.ts"), "utf8");
  expect(source).toContain("VERIFIED by Round 11 live checks");
  expect(source).not.toContain("No verified hermetic mode");
});

test("the base capability comment describes the supported Antigravity mechanism", () => {
  const source = readFileSync(join(import.meta.dir, "../src/adapters/base.ts"), "utf8");
  expect(source).toContain("mechanism and its verification evidence, including Antigravity");
  expect(source).not.toContain("agy candidate awaiting");
  expect(new AgyAdapter({}).capabilities().supportsHermetic).toBe(true);
});

test("the Round 11 live record retains the operator's date, outcomes, and gate", () => {
  const report = readFileSync(join(import.meta.dir, "../docs/experiment-mcp-report.md"), "utf8");
  const live = report.split("## Final live verification on the Round 11 tree")[1]!.split("\n## ")[0]!;
  for (const fact of ["2026-10-13 at 07:41 CEST", "scode 0.6.0 and agy 1.3.3", "1931 pass, 2 skip, 0 fail",
    "only the login keychain before and after", "`OK` (exit 0)", "`HERMETIC agy: OK`", "`TOOLS agy: OK` (exit 0)",
    "No private home remained."]) expect(live).toContain(fact);
});

test("agy's scode version probe carries the parent HOME", async () => {
  const env = fake();
  const scode = Bun.which("scode", { PATH: env.PATH })!;
  const body = readFileSync(scode, "utf8").replace("#!/bin/sh\n",
    '#!/bin/sh\nif [ -z "$HOME" ]; then echo "unsafe HOME" >&2; exit 1; fi\n');
  writeFileSync(scode, body);
  const response = await runCli(["check", "-a", "agy", "--hermetic"], env);
  expect(response.exitCode).toBe(0);
  expect(response.stdout).toContain("HERMETIC agy: OK");
});

test("scratch operator homes contain no Keychain links or credentials", () => {
  const { home, adapter, request } = setup();
  const keychains = join(home, "Library/Keychains");
  mkdirSync(keychains, { recursive: true });
  writeFileSync(join(keychains, "synthetic-keychain"), "metadata fixture");
  const canary = plantAgyCanary();
  cleanup.push(canary.cleanup);
  const context = adapter.prepareRun({ ...request, hermetic: true });
  cleanup.push(() => adapter.cleanupRun(context));
  for (const relocated of [context.agyProbe!.home!, canary.operatorHome, canary.cleanOperatorHome]) {
    expect(existsSync(join(relocated, "Library/Keychains"))).toBe(false);
    expect(existsSync(join(relocated, ".gemini/antigravity-cli/antigravity-oauth-token"))).toBe(false);
  }
  adapter.cleanupRun(context);
  expect(readFileSync(join(keychains, "synthetic-keychain"), "utf8")).toBe("metadata fixture");
});

test("temporary agy HOME access preserves the read-only scode working directory", () => {
  const { cwd, home } = setup();
  const cmd = buildScodeCommand(["agy"], cwd, "read-only", { harnessStateDirs: [home] });
  expect(cmd).toEqual(["scode", "-C", cwd, "--trust", "standard", "--ro", "--allow", home, "--", "agy"]);
  expect(() => buildScodeCommand(["agy"], cwd, "read-only", { harnessStateDirs: ["relative"] })).toThrow("absolute");
});

test("static agy verification builds a placeholder without state and launch still requires preparation", () => {
  const { adapter, request, home } = setup();
  request.hermetic = true;
  expect(adapter.buildRunCommand(request)).toContain(`HOME=${join(home, ".gemini/.codemux-isolation-probes/unprepared")}`);
  expect(existsSync(join(home, ".gemini"))).toBe(false);
  expect(() => adapter.getRunEnv(request)).toThrow("not prepared before launch");
  expect(verifyAgentWiring("agy").runBuildOk).toBe(true);
});

test("a deny-rule refusal on the tool step counts as a denied action (live 2026-10-12)", () => {
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: "c", init: { cwd: "/w", tools: ["run_command"] } }),
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "printf x" }, error: { type: "TOOL_ERROR",
        message: "permission check failed for unsandboxed \"printf x\": Permission denied for unsandboxed(printf x). Matches user-configured deny rule." } } } }),
    JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "The command execution was denied.", num_turns: 1 } }),
  ].join("\n");
  const summary = summarizeAgyStream(stdout);
  expect(summary.deniedActions).toEqual(["unsandboxed"]);
  expect(summary.attemptedActions).toContain("tool");
  expect(summary.possibleToolActivity).toBe(true);
  expect(summary.malformed).toBe(false);
  const canary = { marker: "marker", server: "server", output: "expected-command-output" };
  expect(evaluateAgyProbe("tools", result(stdout), canary)).toBe(true);
  expect(evaluateAgyProbe("tools", result(stdout.replace("The command execution was denied.", canary.output)), canary)).toBe(false);
  const { adapter, request } = setup();
  const toolsRequest = { ...request, tools: "none" as const };
  const context = adapter.prepareRun(toolsRequest);
  cleanup.push(() => adapter.cleanupRun(context));
  const processed = adapter.processRunResult(result(stdout), toolsRequest, context);
  expect(processed.exitCode).toBe(1);
  expect(processed.stderr).toContain("forbids attempted actions: tool, unsandboxed");
});
