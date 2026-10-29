import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { BaseAdapter } from "../src/adapters/base.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { registerCheckCommand } from "../src/check-command.js";
import * as cliRuntime from "../src/cli-runtime.js";
import { getDefaultConfig } from "../src/config.js";
import * as kimiCanary from "../src/kimi-isolation-probe.js";
import * as launcher from "../src/launch.js";
import type { RunRequest } from "../src/types.js";

async function checkWithPassedNames(names: string[], syntheticValidation = false, retainHome = false) {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "codemux-check-kimi-control-"));
  const cwd = join(home, "work");
  const brandHome = join(home, ".kimi-code");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(brandHome);
  const adapter = new KimiAdapter({ HOME: home, KIMI_CODE_HOME: brandHome }, home);
  const marker = "CODEMUX-CANARY-SYNTHETIC";
  const requests: RunRequest[] = [];
  const previousExit = process.exitCode;
  let cleaned = false;
  const output: string[] = [];
  const mocks = [
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("2.3.2"),
    spyOn(cliRuntime, "handleUnexpectedError").mockImplementation((error) => { throw error; }),
    spyOn(KimiAdapter.prototype, "isAvailable").mockReturnValue(true),
    spyOn(kimiCanary, "plantKimiCanary").mockReturnValue({ cwd, marker, adapter,
      operatorHome: home, brandHome, cleanup: () => {
        cleaned = true;
        if (!retainHome) rmSync(brandHome, { recursive: true, force: true });
      } }),
    spyOn(launcher, "launchRunRequest").mockImplementation(async (selectedAdapter, request) => {
      requests.push(request);
      selectedAdapter.validateRunRequest(request);
      return { exitCode: 0, success: true, stdout: request.hermetic ? "OK\n" : `${marker}\n`, stderr: "" };
    }),
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; }),
  ];
  if (syntheticValidation) {
    // Isolate control generation from Kimi's separate hermetic home opt-in refusal.
    mocks.push(spyOn(adapter, "validateRunRequest").mockImplementation((request) => {
      BaseAdapter.prototype.validateRunRequest.call(adapter, request);
    }));
  }
  try {
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    let error: unknown;
    try {
      await program.parseAsync(["check", "-a", "kimi", "--hermetic", "--pass-env", names.join(",")],
        { from: "user" });
    } catch (caught) { error = caught; }
    return { error, requests, cleaned, exitCode: process.exitCode, output: output.join("") };
  } finally {
    for (const mock of mocks) mock.mockRestore();
    process.exitCode = previousExit;
    rmSync(home, { recursive: true, force: true });
  }
}

test("Kimi control rejects 64 passed names before either probe when its home name is missing", async () => {
  const names = Array.from({ length: 64 }, (_, index) => `CONTROL_ENV_${index}`);
  const result = await checkWithPassedNames(names);
  expect(String(result.error)).toContain("environment passthrough must contain at most 64 variable names");
  expect(result.requests).toHaveLength(0);
  expect(result.cleaned).toBe(true);
});

test("Kimi paired check refuses OK when cleanup leaves its planted brand home", async () => {
  const result = await checkWithPassedNames(["CONTROL_ENV"], false, true);
  expect(result.requests).toHaveLength(2);
  expect(result.cleaned).toBe(true);
  expect(String(result.error)).toContain("Kimi planted brand home still exists after cleanup");
  expect(result.output).not.toContain("HERMETIC kimi: OK");
});

test("Kimi control keeps 64 passed names when its home name already exists", async () => {
  const names = [...Array.from({ length: 63 }, (_, index) => `CONTROL_ENV_${index}`), "KIMI_CODE_HOME"];
  const result = await checkWithPassedNames(names, true);
  expect(result.error).toBeUndefined();
  expect(result.exitCode).toBe(0);
  expect(result.requests).toHaveLength(2);
  for (const request of result.requests) {
    expect(request.passthroughEnv).toEqual(names);
    expect(request.passthroughEnv).toHaveLength(64);
    expect(new Set(request.passthroughEnv).size).toBe(64);
  }
  expect(result.requests.map((request) => Boolean(request.hermetic))).toEqual([true, false]);
  expect(result.cleaned).toBe(true);
});
