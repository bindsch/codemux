import { describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { AgyAdapter } from "../src/adapters/agy.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import type { RunContext } from "../src/adapters/base.js";
import * as cliRuntime from "../src/cli-runtime.js";
import * as experimentMcp from "../src/experiment-mcp.js";
import * as launcher from "../src/launch.js";
import { agyKeychainHost } from "../src/agy-keychain.js";
import { registerCheckCommand } from "../src/check-command.js";
import { CANARY_MARKER_PATTERN } from "../src/hermetic-canary.js";
import { getDefaultConfig } from "../src/config.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

test("Kimi experiment check marks its planted control without changing the spec or tools", async () => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "codemux-check-kimi-experiment-"));
  const spec = join(home, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath, args: [], env: [],
    accept_harness_prefix: ["kimi-wall-time"] }));
  const previousHome = process.env.HOME;
  const previousExit = process.exitCode;
  const requests: RunRequest[] = [];
  const mocks = [
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("2.3.2"),
    spyOn(KimiAdapter.prototype, "isAvailable").mockReturnValue(true),
    spyOn(KimiAdapter.prototype, "validateRunRequest").mockImplementation(() => {}),
    spyOn(launcher, "launchRunRequest").mockImplementation(async (_adapter, request) => {
      requests.push(request);
      const instructions = join(dirname(request.cwd!), "operator", ".kimi-code", "AGENTS.md");
      const marker = readFileSync(instructions, "utf8").match(/CODEMUX-CANARY-[A-Z0-9]+/)![0];
      return { exitCode: 0, success: true, stdout: request.hermetic ? "OK\n" : `${marker}\n`, stderr: "" };
    }),
  ];
  try {
    process.env.HOME = home;
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    await program.parseAsync(["check", "-a", "kimi", "--hermetic", "--tools", "none",
      "--experiment-mcp", spec], { from: "user" });
    expect(process.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    const [probe, control] = requests as [RunRequest, RunRequest];
    expect(probe.hermetic).toBe(true);
    expect(control.hermetic).toBe(false);
    expect(probe.experimentMcp).toBe(spec);
    expect(control.experimentMcp).toBe(spec);
    expect([probe.tools, control.tools]).toEqual(["none", "none"]);
    expect(control.passthroughEnv).toContain("KIMI_CODE_HOME");
    expect(experimentMcp.readExperimentRunSpec(probe).control).toBeUndefined();
    expect(experimentMcp.readExperimentRunSpec(control).control).toBe(true);
    expect(() => experimentMcp.validateExperimentRequest(control)).not.toThrow();
    expect(existsSync(control.cwd!)).toBe(false);
  } finally {
    for (const mock of mocks) mock.mockRestore();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.exitCode = previousExit;
    rmSync(home, { recursive: true, force: true });
  }
});

test("shared agy security fixture handles interactive commands and per-HOME defaults", () => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "codemux-security-fixture-"));
  const privateHome = join(home, "private");
  mkdirSync(privateHome);
  const template = join(home, "template.keychain-db");
  const mirror = join(privateHome, 'mirror "quoted" \\$file.keychain-db');
  const login = join(home, "Library/Keychains/login.keychain-db");
  const fake = createFakeBinaryEnv({ agy: "exit 0" });
  const invoke = (args: string[], commandHome = home, input?: string, exitCode = 0) => {
    const result = Bun.spawnSync([fake.env.CODEMUX_TEST_AGY_SECURITY!, ...args], {
      env: { ...fake.env, HOME: commandHome },
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(exitCode);
    return result.stdout.toString("utf8");
  };
  const line = (args: string[]) => args.map((arg) =>
    `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(" ");
  try {
    invoke(["create-keychain", "-p", "synthetic-password", template]);
    expect(existsSync(template)).toBe(true);
    copyFileSync(template, mirror);
    const add = ["add-generic-password", "-s", "codemux-usability-probe", "-a", "probe", "-w", "synthetic-probe", mirror];
    invoke(["show-keychain-info", mirror], privateHome);
    invoke(["-i"], privateHome, line(add) + "\n", 1);
    invoke(["-i"], home, line(["unlock-keychain", "-p", "wrong-password", mirror]) + "\n", 1);
    invoke(["-i"], privateHome, line(add) + "\n", 1);
    invoke(["-i"], home, line(["unlock-keychain", "-p", "synthetic-password", mirror]) + "\n");
    invoke(["-i"], privateHome, line(add) + "\n");
    invoke(["delete-generic-password", "-s", "codemux-usability-probe", "-a", "probe", mirror], privateHome);
    copyFileSync(template, mirror);
    invoke(["-i"], privateHome, line(add) + "\n", 1);
    invoke(["-i"], privateHome, [
      ["unlock-keychain", "-p", "synthetic-password", mirror],
      ["set-keychain-settings", mirror],
      ["add-generic-password", "-s", "fixture", "-w", 'synthetic "$token', mirror],
    ].map(line).join("\n") + "\n");
    expect(existsSync(mirror)).toBe(true);
    invoke(["show-keychain-info", mirror], privateHome);
    expect(invoke(["default-keychain", "-d", "user"]).trim()).toBe(`"${login}"`);
    invoke(["default-keychain", "-d", "user", "-s", mirror], privateHome);
    expect(invoke(["default-keychain", "-d", "user"], privateHome).trim()).toBe(`"${mirror}"`);
    expect(invoke(["default-keychain", "-d", "user"]).trim()).toBe(`"${login}"`);
    expect(invoke(["list-keychains", "-d", "user"]).trim().split("\n").map((path) => path.trim()))
      .toEqual([`"${login}"`, `"${template}"`]);
    invoke(["list-keychains", "-d", "user", "-s", template]);
    expect(invoke(["list-keychains", "-d", "user"]).trim()).toBe(`"${template}"`);
    expect(invoke(["find-generic-password", "-s", "fixture", "-w"]).trim())
      .toBe("synthetic-agy-token");
    invoke(["delete-keychain", mirror], privateHome);
    expect(existsSync(mirror)).toBe(false);
  } finally {
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  { flags: ["--agy-isolation-probe", "login"] },
  { flags: ["--hermetic"] },
  { flags: ["--tools", "none"] },
])("check $flags refuses agy below its supported version before a request", async ({ flags }) => {
  const fake = createFakeBinaryEnv({
    agy: 'if [ "$1" = "--version" ]; then printf "1.2.13\\n"; exit 0; fi; printf "LIVE-REQUEST\\n"',
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  try {
    const result = await runCli(["check", "-a", "agy", ...flags], {
      ...fake.env,
      CODEMUX_ALLOW_UNTESTED_HARNESS: "",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agy 1.2.13 is older than");
    expect(result.stdout).toBe("");
  } finally { fake.cleanup(); }
});

test.each([
  { flags: ["--agy-isolation-probe", "login"], launches: 1 },
  { flags: ["--hermetic"], launches: 2 },
  { flags: ["--tools", "none"], launches: 2 },
])("check $flags probes agy's version once and retains it in every launch context", async ({ flags, launches }) => {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "codemux-check-version-"));
  const versions = join(home, "versions.log");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const events = [{ event: "init", init: { tools: [] } },
    { event: "result", result: { status: "SUCCESS", response: "OK" } }]
    .map((event) => JSON.stringify(event)).join("\n");
  const fake = createFakeBinaryEnv({
    agy: `if [ "$1" = "--version" ]; then printf '1.2.14\\n' >> ${quote(versions)}; printf '1.2.14\\n'; exit 0; fi; printf '%s\\n' ${quote(events)}`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  const environment = { ...fake.env, HOME: home, CODEMUX_ALLOW_UNTESTED_HARNESS: "" };
  const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
  const previousExit = process.exitCode;
  const contexts: RunContext[] = [];
  const original = AgyAdapter.prototype.buildRunCommand;
  const build = spyOn(AgyAdapter.prototype, "buildRunCommand").mockImplementation(function (
    this: AgyAdapter, request: RunRequest, context: RunContext = {}
  ) {
    contexts.push(context);
    return original.call(this, request, context);
  });
  const hostHome = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  try {
    Object.assign(process.env, environment);
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    await program.parseAsync(["check", "-a", "agy", ...flags], { from: "user" });
    expect(contexts).toHaveLength(launches);
    for (const context of contexts) expect(context.harnessVersion).toBe("1.2.14");
    expect(readFileSync(versions, "utf8")).toBe("1.2.14\n");
  } finally {
    build.mockRestore();
    hostHome.mockRestore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = previousExit;
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

describe("CLI - check pre-launch usage refusals exit 64", () => {
  // The same refusal classes `run` and `tui` exit 64 for, on the check
  // path: every row refuses before any probe spends a request.
  const refusalCases: {
    label: string;
    binaries: Record<string, string>;
    argv: string[];
    message: string;
  }[] = [
    {
      label: "unknown agent",
      binaries: {},
      argv: ["check", "-a", "nope"],
      message: "Unknown agent 'nope'",
    },
    {
      // Only qwen's legacy binary (qwen-coder, found when "qwen" is absent)
      // lacks model selection, so this is the reachable model refusal.
      label: "model selection the agent cannot carry",
      binaries: { "qwen-coder": "exit 0" },
      argv: ["check", "-a", "qwen", "-m", "raw-model-name", "--no-sandbox", "--auto", "high"],
      message: "qwen does not support model selection",
    },
    {
      label: "autonomy below high without --sandbox",
      binaries: { opencode: "exit 0" },
      argv: ["check", "-a", "opencode", "--no-sandbox", "--auto", "read-only"],
      message: "opencode cannot enforce 'read-only' autonomy without --sandbox",
    },
    {
      label: "unsupported tools none request",
      binaries: { cline: "exit 0" },
      argv: ["check", "-a", "cline", "--no-sandbox", "--auto", "high", "--tools", "none"],
      message: "cline cannot remove its built-in tools",
    },
  ];
  test.each(refusalCases)("$label", async ({ binaries, argv, message }) => {
    const fake = createFakeBinaryEnv(binaries);
    try {
      const { stderr, exitCode } = await runCli(argv, fake.env);
      expect(exitCode).toBe(64);
      expect(stderr).toContain(message);
    } finally {
      fake.cleanup();
    }
  });
});

/** The plain (non-hermetic) check flow in process: the launch is mocked,
 * so the command's own branch on the probe outcome is what is measured. */
async function runPlainCheck(
  result: { exitCode: number; stdout: string; stderr?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const program = new Command();
  registerCheckCommand(program, getDefaultConfig(), () => {});
  const stdoutChunks: string[] = [];
  const stderrLines: string[] = [];
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderrLines.push(values.map(String).join(" "));
  });
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation(((chunk: Uint8Array | string) => {
    stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0" });
  const mocks = [
    write, error, stderrWrite,
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("2.1.220"),
    spyOn(launcher, "launchRunRequest").mockImplementation(async () => ({
      success: result.exitCode === 0, ...result, stderr: result.stderr ?? "",
    })),
  ];
  process.env.PATH = fake.env.PATH;
  try {
    await program.parseAsync(["check", "-a", "claude"], { from: "user" });
    const resolved = process.exitCode;
    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrLines.join("\n"),
      exitCode: typeof resolved === "number" ? resolved : undefined,
    };
  } finally {
    for (const mock of mocks) mock.mockRestore();
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    fake.cleanup();
  }
}

describe("the plain check probe outcomes in process", () => {
  test("an OK line passes the check", async () => {
    const outcome = await runPlainCheck({ exitCode: 0, stdout: "OK\n", stderr: "" });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("OK\n");
  });

  test("a failing probe reports the harness output and its exit code", async () => {
    const outcome = await runPlainCheck({ exitCode: 3, stdout: "noise\n", stderr: "boom\n" });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("noise");
    expect(outcome.stderr).toContain("boom");
  });

  test("a clean exit without an OK line is an unexpected response", async () => {
    const outcome = await runPlainCheck({ exitCode: 0, stdout: "not ok\n", stderr: "" });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("agent probe returned an unexpected response");
    expect(outcome.stderr).toContain("not ok");
  });
});

/** The hermetic check flow in process (audit round 2, C-9): the canary is
 * planted for real, and the launch mock answers per request — the hermetic
 * probe (`request.hermetic === true`) and the control — with whatever
 * surface the test wants the verdict to judge. The marker is read from the
 * planted instructions, the way a leaking harness would read it. */
async function runHermeticCheck(
  answer: (marker: string, hermetic: boolean) => { exitCode: number; stdout: string; stderr?: string; reply?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined; launches: number }> {
  const program = new Command();
  registerCheckCommand(program, getDefaultConfig(), () => {});
  const stdoutChunks: string[] = [];
  const stderrLines: string[] = [];
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderrLines.push(values.map(String).join(" "));
  });
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation(((chunk: Uint8Array | string) => {
    stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0" });
  let launches = 0;
  const mocks = [
    write, error, stderrWrite,
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("2.1.220"),
    spyOn(launcher, "launchRunRequest").mockImplementation(async (_adapter, request) => {
      launches += 1;
      const marker = CANARY_MARKER_PATTERN.exec(readFileSync(join(request.cwd!, "AGENTS.md"), "utf8"))![0];
      const result = answer(marker, request.hermetic === true);
      return { success: result.exitCode === 0, ...result, stderr: result.stderr ?? "" };
    }),
  ];
  process.env.PATH = fake.env.PATH;
  try {
    await program.parseAsync(["check", "-a", "claude", "--hermetic"], { from: "user" });
    const resolved = process.exitCode;
    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrLines.join("\n"),
      exitCode: typeof resolved === "number" ? resolved : undefined,
      launches,
    };
  } finally {
    for (const mock of mocks) mock.mockRestore();
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    fake.cleanup();
  }
}

describe("the hermetic check verdicts in process (C-9)", () => {
  test("a failing hermetic probe reports the harness output and its exit code", async () => {
    const outcome = await runHermeticCheck((_marker, hermetic) =>
      hermetic ? { exitCode: 7, stdout: "noise\n", stderr: "boom\n" } : { exitCode: 0, stdout: "OK\n" }
    );
    expect(outcome.exitCode).toBe(7);
    expect(outcome.launches).toBe(1); // a failed probe never reaches the control
    expect(outcome.stderr).toContain("noise");
    expect(outcome.stderr).toContain("boom");
  });

  test("the planted code word in the probe output is a leak verdict", async () => {
    const outcome = await runHermeticCheck((marker, hermetic) =>
      hermetic ? { exitCode: 0, stdout: `${marker}\nOK\n`, reply: "OK" } : { exitCode: 0, stdout: `${marker}\n` }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("is NOT hermetic: the planted code word reached the model");
    expect(outcome.stderr).toContain("control: planted code word reached the model, as expected");
    expect(outcome.stdout).not.toContain("HERMETIC");
  });

  test("a probe answer other than OK fails the check even when the control leaks", async () => {
    const outcome = await runHermeticCheck((marker, hermetic) =>
      hermetic
        ? { exitCode: 0, stdout: "", reply: "I cannot answer that" }
        : { exitCode: 0, stdout: `${marker}\n` }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("probe did not pass: the model answered 'I cannot answer that' instead of OK");
    expect(outcome.stderr).toContain("control: planted code word reached the model, as expected");
  });

  test("a clean control proves nothing and fails the check", async () => {
    const outcome = await runHermeticCheck((_marker, hermetic) =>
      hermetic ? { exitCode: 0, stdout: "OK\n" } : { exitCode: 0, stdout: "OK\n" }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("answered OK, but the check proved nothing");
    expect(outcome.stderr).toContain("clean too, so the planted files never reached the model");
  });

  test("a failing control proves nothing and reports the control's output", async () => {
    const outcome = await runHermeticCheck((_marker, hermetic) =>
      hermetic ? { exitCode: 0, stdout: "OK\n" } : { exitCode: 5, stdout: "control-died\n", stderr: "gone\n" }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("answered OK, but the check proved nothing: the request failed (exit 5)");
    expect(outcome.stderr).toContain("control-died");
  });
});
