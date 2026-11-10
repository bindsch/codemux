/**
 * The `check --hermetic --session` wiring (lane H4): the CLI refuses the
 * shapes the session canary cannot carry with the check's exit-64
 * wording, and a well-formed request runs the canary — here pointed at
 * the fake codemux session fixture, so no harness binary and no provider
 * is contacted. The canary's own session verdicts are tested in
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
import {
  SESSION_CANARY_PLANTED_ENV, assertSessionCanaryRequest, plantSessionCanary, sessionCanary, sessionCanaryOwnedEnv,
} from "../src/hermetic-session-canary.js";
import { HARNESS_HOME_CANARY_CLEARED_ENV, sessionCanaryLaunchCount } from "../src/hermetic-session-canary-home.js";
import { UsageRefusalError } from "../src/validation.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { AGENT_IDS } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-codemux-session.ts", import.meta.url));

// Every shipped agent has a session driver, so no CLI argv reaches the
// "has no session driver" refusal; tests/hermetic-session-canary.test.ts
// pins it with an unregistered id, and the test below pins why.
test("every shipped agent has a session driver, so the canary's driver refusal is unreachable from the CLI", () => {
  expect(AGENT_IDS.filter((agent) => SESSION_AGENTS[agent] === undefined)).toEqual([]);
});

const refusals: { label: string; argv: string[]; message: string }[] = [
  {
    // cursor's session exists but the harness has no verified hermetic
    // mode; for the CHECK path the hermetic gate answers first with its
    // own spelling (the session command's "no verified hermetic mode"
    // refusal is cli-request.ts's, one layer later).
    label: "sessions without hermetic",
    argv: ["check", "-a", "cursor", "--hermetic", "--session"],
    message: "cursor does not support a hermetic instruction check",
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
  {
    // The claude-family plant points CLAUDE_CONFIG_DIR at its scratch
    // operator config directory; a caller's own profile would be replaced
    // without notice (review of 05ecf26, finding 3).
    label: "claude's pass-env CLAUDE_CONFIG_DIR",
    argv: ["check", "-a", "claude", "--hermetic", "--session", "--pass-env", "PATH,CLAUDE_CONFIG_DIR"],
    message: "--session cannot carry --pass-env CLAUDE_CONFIG_DIR for claude: the canary sets or clears CLAUDE_CONFIG_DIR itself in its sessions",
  },
  {
    label: "zai's pass-env CLAUDE_CONFIG_DIR",
    argv: ["check", "-a", "zai", "--hermetic", "--session", "--pass-env", "CLAUDE_CONFIG_DIR"],
    message: "--session cannot carry --pass-env CLAUDE_CONFIG_DIR for zai",
  },
  {
    // The caller-home arm sets HOME to a scratch operator home for every
    // agent, codex included (review of the REL1 change, finding 1).
    label: "codex's pass-env HOME",
    argv: ["check", "-a", "codex", "--hermetic", "--session", "--pass-env", "HOME"],
    message: "--session cannot carry --pass-env HOME for codex",
  },
];

test.each(refusals)("check --session refuses $label before spending anything", async ({ argv, message }) => {
  const fake = createFakeBinaryEnv({ claude: "exit 0", scode: "exit 0" });
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
    // The request's flags ride every session the canary starts: the three
    // hermetic sessions plus, for agents with a caller-home canary, the two
    // --harness-home sessions (src/hermetic-session-canary-home.ts).
    const runs = readFileSync(stateFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[] });
    expect(runs).toHaveLength(sessionCanaryLaunchCount("claude"));
    expect(sessionCanaryLaunchCount("claude")).toBe(5);
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

test("the session guard refuses a --pass-env name the agent's plant sets, and only that", () => {
  const guards = {
    wanted: true, agent: "kimi" as const, hermetic: true, supportsHermetic: true, sandbox: true,
    tools: undefined, experimentMcp: false, agyProbe: false, printSandbox: false, sandboxOverrides: undefined,
    passthroughEnv: ["KIMI_CODE_HOME"],
  };
  expect(() => assertSessionCanaryRequest(guards)).toThrow(/--pass-env KIMI_CODE_HOME for kimi/);
  expect(() => assertSessionCanaryRequest({ ...guards, agent: "cline", passthroughEnv: ["HOME"] }))
    .toThrow(/--pass-env HOME for cline/);
  // The caller-home arm clears every redirect name and sets HOME, for every
  // session agent; a name neither arm touches passes.
  expect(() => assertSessionCanaryRequest({ ...guards, agent: "codex", passthroughEnv: ["CODEX_HOME"] }))
    .toThrow(/--pass-env CODEX_HOME for codex/);
  for (const name of HARNESS_HOME_CANARY_CLEARED_ENV) {
    expect(() => assertSessionCanaryRequest({ ...guards, agent: "gemini", passthroughEnv: [name] })).toThrow(UsageRefusalError);
  }
  // zai's caller-home arm rewrites its gateway key (review round 2 of REL1).
  expect(() => assertSessionCanaryRequest({ ...guards, agent: "zai", passthroughEnv: ["ZAI_API_KEY"] }))
    .toThrow(/--pass-env ZAI_API_KEY for zai/);
  expect(() => assertSessionCanaryRequest({ ...guards, passthroughEnv: ["PATH", "ANTHROPIC_BASE_URL"] })).not.toThrow();
  for (const agent of AGENT_IDS.filter((id) => SESSION_AGENTS[id]?.hermetic === true)) {
    expect({ agent, home: sessionCanaryOwnedEnv(agent).includes("HOME") }).toEqual({ agent, home: true });
  }
});

test("the guard's planted-name table lists exactly the names each plant sets", () => {
  const parent = mkdtempSync(join(tmpdir(), "codemux-planted-env-"));
  const credentials = join(parent, "credentials.json");
  const originalHome = process.env.HOME;
  // kimi's plant reads the operator HOME; keep it inside scratch.
  process.env.HOME = parent;
  try {
    for (const agent of AGENT_IDS.filter((id) => SESSION_AGENTS[id]?.hermetic === true)) {
      const planted = plantSessionCanary(agent, parent, credentials);
      try {
        expect({ agent, names: Object.keys(planted.env).sort() })
          .toEqual({ agent, names: [...(SESSION_CANARY_PLANTED_ENV[agent] ?? [])].sort() });
      } finally {
        planted.cleanup();
      }
    }
  } finally {
    process.env.HOME = originalHome;
    rmSync(parent, { recursive: true, force: true });
  }
});
