import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { AGY_PROBE_MODES } from "../src/agy-isolation-probe.js";
import { registerCheckCommand } from "../src/check-command.js";
import * as cliRuntime from "../src/cli-runtime.js";
import { getDefaultConfig } from "../src/config.js";
import * as launcher from "../src/launch.js";
import * as quotaGate from "../src/quota-gate.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

const cases = [
  ...AGY_PROBE_MODES.map((mode) => ({ flags: ["--agy-isolation-probe", mode], flag: "--agy-isolation-probe" })),
  { flags: ["--tools", "none"], flag: "--tools none" },
  { flags: ["--hermetic"], flag: "hermetic" },
];

test.each(cases)("Agy check --print-sandbox refuses $flags without invoking a binary", async ({ flags, flag }) => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(scratch, "check-agy-print-")));
  const invocations = join(root, "invocations");
  writeFileSync(invocations, "");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const record = `printf '%s\\n' "$*" >> ${quote(invocations)}`;
  const fake = createFakeBinaryEnv({
    agy: `${record}\nprintf 'OK\\n'`,
    scode: `${record}\nexit 99`,
    security: `${record}\nexit 99`,
  });
  const binary = realpathSync(Bun.which("agy", { PATH: fake.env.PATH })!);
  const previousPath = process.env.PATH;
  const previousExit = process.exitCode;
  const errors: string[] = [];
  let exitCode: string | number | null | undefined;
  const stopped = new Error("synthetic exit");
  const version = spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("1.2.14");
  const quota = spyOn(quotaGate, "assertQuotaHeadroomForLaunch").mockResolvedValue(undefined);
  // Execute only the recording fixture if a probe reaches the launch path.
  // This prevents credential preparation even when the regression fails.
  const launch = spyOn(launcher, "launchRunRequest").mockImplementation(async () => {
    const proc = Bun.spawn([binary, "probe"], { env: { PATH: dirname(binary) }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { stdout, stderr, exitCode: status, success: status === 0 };
  });
  const mocks = [
    version, quota, launch,
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(console, "error").mockImplementation((...values: unknown[]) => { errors.push(values.map(String).join(" ")); }),
    spyOn(process.stdout, "write").mockImplementation(() => true),
    spyOn(process, "exit").mockImplementation(((code) => { exitCode = code; throw stopped; }) as typeof process.exit),
  ];
  process.env.PATH = dirname(binary);
  process.exitCode = 0;
  try {
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    try {
      await program.parseAsync(["check", "-a", "agy", ...flags, "--print-sandbox"], { from: "user" });
    } catch (error) {
      if (error !== stopped) throw error;
    }
    expect(readFileSync(invocations, "utf8")).toBe("");
    expect(exitCode).toBe(64);
    expect(errors.join("\n")).toContain("--print-sandbox");
    expect(errors.join("\n")).toContain(flag);
    expect(version).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    for (const mock of mocks) mock.mockRestore();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    process.exitCode = previousExit;
    fake.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
