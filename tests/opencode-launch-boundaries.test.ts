import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import * as runtime from "../src/cli-runtime.js";
import { registerCheckCommand } from "../src/check-command.js";
import { getDefaultConfig } from "../src/config.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunContext } from "../src/run-context.js";
import { registerRunCommand } from "../src/run-command.js";
import type { RunRequest } from "../src/types.js";
import { withOpenCodeLaunch } from "./helpers/opencode-launch.js";

async function command(kind: "run" | "check", args: string[]) {
  const program = new Command(); program.exitOverride();
  (kind === "run" ? registerRunCommand : registerCheckCommand)(program, getDefaultConfig(), () => {});
  const handler = spyOn(runtime, "handleUnexpectedError").mockImplementation((error) => { throw error; });
  try { await program.parseAsync([kind, "-a", "opencode", "--no-quota-gate", ...args], { from: "user" }); }
  finally { handler.mockRestore(); }
}

test.each([false, true])("OpenCode run command completes experiment evidence and cleanup, resultJson=%s", async (resultJson) => {
  await withOpenCodeLaunch(async (rig) => {
    process.env.OPENCODE_PURE = "1";
    process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = "1";
    const prompt = "synthetic prompt ".repeat(6000);
    await command("run", ["--hermetic", "--tools", "none", "--experiment-mcp", rig.spec,
      "--cwd", rig.cwd, "--timeout", "5", "--pass-env", "OPENCODE_PURE,OPENCODE_EXPERIMENTAL_NATIVE_LLM",
      "-p", prompt, ...(resultJson ? ["--result-json"] : [])]);
    expect(process.exitCode, rig.errors.join("\n")).toBe(0);
    const [observed] = rig.observations();
    expect(observed!.stdin).toBe(prompt);
    expect(observed!.args).not.toContain(prompt);
    expect(observed!.args).not.toContain("--pure");
    expect(observed!.projectDisabled).toBe(true);
    expect([observed!.pure, observed!.nativeLlm]).toEqual([null, null]);
    expect(existsSync(observed!.home)).toBe(false);
    const [records] = rig.recordings();
    expect(records!.some((row) => row.kind === "tool_result_delivered")).toBe(true);
    expect(records!.some((row) => row.kind === "opencode_evidence_copy")).toBe(true);
    expect(records!.find((row) => row.kind === "opencode_plugin_evidence")).toMatchObject({ evidence_kind: "model_turn" });
    expect(records!.at(-1)).toMatchObject({ kind: "run_end", error: null, tool_calls: 1 });
    if (resultJson) {
      const result = JSON.parse(rig.stdout.join(""));
      expect(result.reply).toBe("OK\n");
      expect(result.codemux).toMatchObject({ served_model: "synthetic-served-model", failure_code: null });
    } else expect(rig.stdout.join("")).toBe("OK\n");
  });
});

test.each(["changed-result", "missing-evidence"])("OpenCode run retains failed experiment output and removes private files: %s", async (mode) => {
  await withOpenCodeLaunch(async (rig) => {
    await command("run", ["--hermetic", "--tools", "none", "--experiment-mcp", rig.spec,
      "--cwd", rig.cwd, "--timeout", "5", "--result-json", "-p", "synthetic"]);
    expect(process.exitCode).toBe(1);
    const result = JSON.parse(rig.stdout.join(""));
    expect(result.reply).toBe(mode === "missing-evidence" ? "retained reply\n" : "OK\n");
    expect(result.codemux.failure_code).toBe(mode === "missing-evidence" ? "inventory_mismatch" : "result_changed");
    expect(existsSync(rig.observations()[0]!.home)).toBe(false);
    expect(rig.recordings()[0]!.at(-1)!.error).not.toBeNull();
  }, { mode });
});

test("OpenCode paired experiment check verifies both requests and cleans both lifecycles", async () => {
  await withOpenCodeLaunch(async (rig) => {
    await command("check", ["--hermetic", "--tools", "none", "--experiment-mcp", rig.spec, "--timeout", "5"]);
    expect(process.exitCode, rig.errors.join("\n")).toBe(0);
    expect(rig.stdout.join("")).toBe("HERMETIC opencode: OK\n");
    const observed = rig.observations();
    expect(observed).toHaveLength(2);
    expect(observed.map((row) => row.projectDisabled)).toEqual([true, false]);
    expect(observed[0]!.stdin).toBe(observed[1]!.stdin);
    expect(observed[0]!.cwd).toBe(observed[1]!.cwd);
    expect(existsSync(observed[0]!.cwd)).toBe(false);
    const pluginPaths = observed.map((row) => row.config.plugin[0]);
    expect(pluginPaths[0]).not.toBe(pluginPaths[1]);
    for (const path of pluginPaths) expect(existsSync(new URL(path))).toBe(false);
    for (const row of observed) {
      expect(row.args).not.toContain("--pure");
      expect(Object.values(row.config.agent)[0]).toMatchObject({ permission: { "*": "deny", "experiment_*": "allow" } });
    }
    const records = rig.recordings();
    expect(records).toHaveLength(2);
    for (const recording of records) expect(recording.at(-1)).toMatchObject({ kind: "run_end", error: null, tool_calls: 0 });
  }, { mode: "canary" });
});

test("OpenCode experiment check scans provider payloads even when both answers omit the marker", async () => {
  await withOpenCodeLaunch(async (rig) => {
    await command("check", ["--hermetic", "--tools", "none", "--experiment-mcp", rig.spec, "--timeout", "5"]);
    expect(process.exitCode).toBe(1);
    expect(rig.errors.join("\n")).toContain("is NOT hermetic: the planted code word reached the model");
    expect(rig.observations()).toHaveLength(2);
    expect(rig.recordings()).toHaveLength(2);
  }, { mode: "leak-payload" });
});

test("OpenCode paired experiment check stops after a failed first verification", async () => {
  await withOpenCodeLaunch(async (rig) => {
    await command("check", ["--hermetic", "--tools", "none", "--experiment-mcp", rig.spec, "--timeout", "5"]);
    expect(process.exitCode).toBe(1);
    const observed = rig.observations();
    expect(observed).toHaveLength(1);
    expect(existsSync(observed[0]!.home)).toBe(false);
    expect(existsSync(observed[0]!.cwd)).toBe(false);
    expect(rig.recordings()[0]!.at(-1)).toMatchObject({ kind: "run_end", code: "inventory_mismatch" });
  }, { mode: "missing-evidence" });
});

test("OpenCode experiment feature floor refuses before starting the relay or native child", async () => {
  await withOpenCodeLaunch(async (rig) => {
    const adapter = new OpencodeAdapter(process.env, rig.home);
    const prepare = adapter.prepareRun.bind(adapter);
    let context: RunContext | undefined;
    const preparation = spyOn(adapter, "prepareRun").mockImplementation((request) => context = prepare(request));
    const request: RunRequest = { agent: "opencode", prompt: "synthetic", cwd: rig.cwd,
      hermetic: true, tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: rig.spec };
    try {
      const result = await launchRunRequest(adapter, request, { cwd: rig.cwd, sandbox: true, requestedAutonomy: "read-only" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("older than the 1.19.5");
      expect(rig.observations()).toHaveLength(0);
      expect(existsSync(context!.opencodeHermeticHome!.home)).toBe(false);
      expect(rig.recordings()[0]!.some((row) => row.kind === "server_spawn")).toBe(false);
    } finally { preparation.mockRestore(); }
  }, { version: "1.19.4" });
});

test("OpenCode experiment timeout fails verification after terminal output and cleans the relay", async () => {
  await withOpenCodeLaunch(async (rig) => {
    const adapter = new OpencodeAdapter(process.env, rig.home);
    const request: RunRequest = { agent: "opencode", prompt: "synthetic", cwd: rig.cwd, timeoutMs: 500,
      hermetic: true, tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: rig.spec };
    const result = await launchRunRequest(adapter, request, { cwd: rig.cwd, sandbox: true,
      requestedAutonomy: "read-only", timeoutMs: 500 });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("OK\n");
    expect(result.stderr).toContain("capture was interrupted");
    expect(existsSync(rig.observations()[0]!.home)).toBe(false);
    expect(rig.recordings()[0]!.at(-1)).toMatchObject({ kind: "run_end", code: "harness_log_missing" });
  }, { mode: "timeout" });
});

test.each([{ noNet: true }, { trust: "untrusted" as const }])("OpenCode experiment refuses a disconnected options-only relay before preparation: %j", async (policy) => {
  await withOpenCodeLaunch(async (rig) => {
    const adapter = new OpencodeAdapter(process.env, rig.home);
    const prepare = spyOn(adapter, "prepareRun");
    const request: RunRequest = { agent: "opencode", prompt: "synthetic", cwd: rig.cwd,
      hermetic: true, tools: "none", autonomy: "read-only", sandboxed: true, experimentMcp: rig.spec };
    try {
      await expect(launchRunRequest(adapter, request, { cwd: rig.cwd, sandbox: true,
        requestedAutonomy: "read-only", sandboxPolicyOverrides: policy })).rejects.toThrow(
        `--experiment-mcp on opencode uses a loopback HTTP relay and refuses ${"noNet" in policy ? "--sandbox-no-net" : "--sandbox-trust untrusted"}`);
      expect(prepare).not.toHaveBeenCalled();
      expect(rig.observations()).toHaveLength(0);
    } finally { prepare.mockRestore(); }
  });
});
