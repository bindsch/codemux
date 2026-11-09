/**
 * The `check --hermetic --session` wiring (lane H4): the CLI refuses the
 * shapes the session canary cannot carry with the check's exit-64
 * wording, and a well-formed request runs the canary — here pointed at
 * the fake codemux session fixture, so no harness binary and no provider
 * is contacted. The canary's own three-session verdicts are tested in
 * tests/hermetic-session-canary.test.ts.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import * as cliRuntime from "../src/cli-runtime.js";
import { getDefaultConfig } from "../src/config.js";
import { registerCheckCommand } from "../src/check-command.js";
import { sessionCanary } from "../src/hermetic-session-canary.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-codemux-session.ts", import.meta.url));

const refusals: { label: string; argv: string[]; message: string }[] = [
  {
    label: "no session driver",
    argv: ["check", "-a", "qwen", "--hermetic", "--session"],
    message: "qwen has no session driver",
  },
  {
    label: "sessions without hermetic",
    argv: ["check", "-a", "aider", "--hermetic", "--session"],
    message: "aider has no verified hermetic mode",
  },
  {
    label: "session without hermetic",
    argv: ["check", "-a", "claude", "--session"],
    message: "--session requires --hermetic",
  },
  {
    label: "tools selection",
    argv: ["check", "-a", "claude", "--hermetic", "--session", "--tools", "none"],
    message: "--session cannot carry --tools",
  },
  {
    // The run-shaped --print-sandbox + --hermetic refusal fires first
    // (check-command.ts, before the session guards); the combination is
    // still refused before anything is spent.
    label: "print-sandbox",
    argv: ["check", "-a", "claude", "--hermetic", "--session", "--print-sandbox"],
    message: "--print-sandbox supports the plain probe only",
  },
];

test.each(refusals)("check --session refuses $label before spending anything", async ({ argv, message }) => {
  const fake = createFakeBinaryEnv({ claude: "exit 0", aider: "exit 0", scode: "exit 0" });
  try {
    const { stderr, exitCode } = await runCli(argv, fake.env);
    expect(exitCode).toBe(64);
    expect(stderr).toContain(message);
  } finally {
    fake.cleanup();
  }
});

test("check --hermetic --session runs the canary and prints its OK line", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "check-session-test-"));
  const stateFile = join(homeRoot, "state.jsonl");
  const command = spyOn(sessionCanary, "command").mockReturnValue([process.execPath, FAKE]);
  const stdoutChunks: string[] = [];
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const originalScenario = process.env.FAKE_CODEMUX_SCENARIO;
  const originalHomeRoot = process.env.FAKE_CODEMUX_HOME_ROOT;
  const originalState = process.env.FAKE_CODEMUX_STATE;
  const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0" });
  const mocks = [
    command,
    spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write),
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write),
    spyOn(cliRuntime, "isScodeAvailable").mockReturnValue(true),
    spyOn(cliRuntime, "assertHarnessSupported").mockResolvedValue("2.1.220"),
  ];
  process.env.PATH = fake.env.PATH;
  process.env.FAKE_CODEMUX_SCENARIO = "clean";
  process.env.FAKE_CODEMUX_HOME_ROOT = homeRoot;
  process.env.FAKE_CODEMUX_STATE = stateFile;
  try {
    const program = new Command();
    registerCheckCommand(program, getDefaultConfig(), () => {});
    await program.parseAsync(
      ["check", "-a", "claude", "--hermetic", "--session", "--effort", "low", "--pass-env", "EXTRA_NAME", "--timeout", "10"],
      { from: "user" }
    );
    expect(process.exitCode).toBe(0);
    expect(stdoutChunks.join("")).toContain("HERMETIC SESSION claude: OK");
    // The request's flags ride every session the canary starts.
    const runs = readFileSync(stateFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[] });
    expect(runs).toHaveLength(3);
    expect(runs[0]!.argv).toContain("--effort");
    expect(runs[0]!.argv.join(" ")).toContain("--pass-env EXTRA_NAME");
  } finally {
    for (const mock of mocks) mock.mockRestore();
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    for (const [name, value] of [
      ["FAKE_CODEMUX_SCENARIO", originalScenario],
      ["FAKE_CODEMUX_HOME_ROOT", originalHomeRoot],
      ["FAKE_CODEMUX_STATE", originalState],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(homeRoot, { recursive: true, force: true });
    fake.cleanup();
  }
});
