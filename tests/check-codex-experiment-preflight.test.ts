/**
 * The `check --hermetic --experiment-mcp` preflight for codex
 * (declarations-run.ts check.experiment-mcp): the command builds a hermetic
 * probe and its non-hermetic control, validates both through the real
 * request boundaries, launches them in order, and prints the verdict only
 * when the probe is clean and the control leaks the planted code word.
 * The launch is mocked; every gate before it is real.
 */

import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { CodexAdapter } from "../src/adapters/codex.js";
import { registerCheckCommand } from "../src/check-command.js";
import * as cliRuntime from "../src/cli-runtime.js";
import { getDefaultConfig } from "../src/config.js";
import * as hermeticCanary from "../src/hermetic-canary.js";
import * as launcher from "../src/launch.js";
import type { RunRequest } from "../src/types.js";
import { resolve } from "node:path";

async function checkExperiment(controlClean = false) {
  const scratch = join(resolve("scratch/session-14c66a93/exp"), "codex-check-preflight");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "codemux-check-codex-"));
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  // The cache every codex experiment validation reads: the command's
  // preflight adapter comes from getAdapter, so it reads this home through
  // process.env for the duration of the parse.
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
    client_version: "0.165.0", fetched_at: "2026-10-29T00:00:00Z", models: [
      { slug: "gpt-5.5", tool_mode: "direct" },
    ],
  }));
  const specPath = join(home, "spec.json");
  writeFileSync(specPath, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      resolve("tests/fixtures/experiment-mcp.ts")], env: [], recording: join(home, "recordings"),
    accept_harness_prefix: ["codex-wall-time"] }));
  const marker = "CODEMUX-CANARY-SYNTHETIC";
  const requests: RunRequest[] = [];
  const output: string[] = [];
  const previousExit = process.exitCode;
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  let cleaned = false;
  const mocks = [
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("0.166.0"),
    spyOn(cliRuntime, "handleUnexpectedError").mockImplementation((error) => { throw error; }),
    spyOn(CodexAdapter.prototype, "isAvailable").mockReturnValue(true),
    spyOn(hermeticCanary, "plantCanary").mockImplementation(() => ({
      cwd, marker, cleanup: () => { cleaned = true; },
    })),
    spyOn(launcher, "launchRunRequest").mockImplementation(async (selectedAdapter, request) => {
      requests.push(request);
      selectedAdapter.validateRunRequest(request);
      return { exitCode: 0, success: true,
        stdout: request.hermetic || controlClean ? "OK\n" : `${marker}\n`, stderr: "" };
    }),
    spyOn(console, "error").mockImplementation((message) => { output.push(`${String(message)}\n`); }),
    spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; }),
  ];
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    let error: unknown;
    try {
      await program.parseAsync(
        ["check", "-a", "codex", "--hermetic", "--tools", "none", "-m", "gpt-5.5",
          "--experiment-mcp", specPath],
        { from: "user" });
    } catch (caught) { error = caught; }
    return { error, requests, cleaned, exitCode: process.exitCode, output: output.join("") };
  } finally {
    for (const mock of mocks) mock.mockRestore();
    process.exitCode = previousExit ?? 0;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("codex paired check runs a hermetic probe then a non-hermetic control and passes", async () => {
  const result = await checkExperiment();
  expect(result.error).toBeUndefined();
  expect(result.exitCode).toBe(0);
  expect(result.requests).toHaveLength(2);
  expect(result.requests.map((request) => Boolean(request.hermetic))).toEqual([true, false]);
  for (const request of result.requests) {
    expect(request.agent).toBe("codex");
    expect(request.tools).toBe("none");
    expect(request.autonomy).toBe("read-only");
    expect(request.sandboxed).toBe(true);
    expect(request.experimentMcp).toBeDefined();
  }
  expect(result.cleaned).toBe(true);
  expect(result.output).toContain("HERMETIC codex: OK");
});

test("a control that stays clean fails the paired check without the OK line", async () => {
  const result = await checkExperiment(true);
  expect(result.error).toBeUndefined();
  expect(result.exitCode).toBe(1);
  expect(result.requests).toHaveLength(2);
  expect(result.output).not.toContain("HERMETIC codex: OK");
  expect(result.output).toContain("clean too, so the planted files never reached the model");
  expect(result.cleaned).toBe(true);
});
