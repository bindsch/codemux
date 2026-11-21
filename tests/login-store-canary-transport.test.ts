import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { BaseAdapter } from "../src/adapters/base.js";
import * as runtime from "../src/cli-runtime.js";
import * as agy from "../src/agy-isolation-probe.js";
import * as session from "../src/hermetic-session-canary.js";
import * as launcher from "../src/launch.js";
import { getDefaultConfig } from "../src/config.js";
import { registerCheckCommand } from "../src/check-command.js";
import type { SandboxPolicyOverrides } from "../src/sandbox-policy.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/login-canary-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const policies = [
  { flags: [], loginStore: false, noLoginStore: false },
  { flags: ["--sandbox-login-store"], loginStore: true, noLoginStore: false },
  { flags: ["--sandbox-no-login-store"], loginStore: false, noLoginStore: true },
  { flags: ["--sandbox-no-login-store", "--sandbox-login-store"], loginStore: false, noLoginStore: true },
];

test.each(policies)("check forwards login policy to every managed canary: %j", async (policy) => {
  const seen: Array<Pick<SandboxPolicyOverrides, "loginStore" | "noLoginStore"> | undefined> = [];
  const previousExit = process.exitCode;
  const mocks = [
    spyOn(BaseAdapter.prototype, "isAvailable").mockReturnValue(true),
    spyOn(runtime, "isScodeAvailable").mockReturnValue(true),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue("synthetic"),
    spyOn(agy, "runAgyIsolationProbe").mockImplementation(async (_mode, _timeout, _model, _version, overrides) => { seen.push(overrides); return 0; }),
    spyOn(agy, "runAgyCanaryChecks").mockImplementation(async (_hermetic, _tools, _timeout, _model, _version, overrides) => { seen.push(overrides); return 0; }),
    spyOn(session, "runHermeticSessionCanary").mockImplementation(async (request) => {
      seen.push({ loginStore: request.sandboxLoginStore, noLoginStore: request.sandboxNoLoginStore }); return 0;
    }),
  ];
  try {
    for (const args of [["agy", "--agy-isolation-probe", "login"], ["agy", "--hermetic"], ["claude", "--hermetic", "--session"]]) {
      const program = new Command();
      registerCheckCommand(program, getDefaultConfig(), () => {});
      await program.parseAsync(["check", "-a", ...args, ...policy.flags, "--no-quota-gate"], { from: "user" });
      expect(process.exitCode).toBe(0);
    }
    expect(seen).toHaveLength(3);
    for (const value of seen) {
      expect(value?.loginStore === true).toBe(policy.loginStore);
      expect(value?.noLoginStore === true).toBe(policy.noLoginStore);
    }
  } finally { for (const mock of mocks.reverse()) mock.mockRestore(); process.exitCode = previousExit; }
});

test.each([{}, { loginStore: true }, { loginStore: true, noLoginStore: true }])("agy applies login policy to probe and controls: %j", async (policy) => {
  const seen: Array<SandboxPolicyOverrides | undefined> = [];
  const launch = spyOn(launcher, "launchRunRequest").mockImplementation(async (_adapter, _request, options) => {
    seen.push(options.sandboxPolicyOverrides);
    return { success: false, exitCode: 1, stdout: "", stderr: "" };
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await agy.runAgyIsolationProbe("login", 1000, undefined, undefined, policy);
    await agy.runAgyCanaryChecks(true, false, 1000, undefined, undefined, policy);
    await agy.runAgyCanaryChecks(false, true, 1000, undefined, undefined, policy);
    expect(seen).toHaveLength(5);
    for (const value of seen) expect(value).toEqual(policy);
  } finally { error.mockRestore(); launch.mockRestore(); }
});

test.each(policies)("session canary carries login policy through control, resume and caller homes: %j", async (policy) => {
  const home = mkdtempSync(join(root, "session-")), state = join(home, "state.jsonl");
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_CODEMUX_SCENARIO: "clean", FAKE_CODEMUX_HOME_ROOT: home, FAKE_CODEMUX_STATE: state });
  const command = spyOn(session.sessionCanary, "command").mockReturnValue([process.execPath, join(import.meta.dir, "fixtures/live/fake-codemux-session.ts")]);
  const credentials = spyOn(session.sessionCanary, "credentialSource").mockReturnValue(join(home, "absent-credentials"));
  const error = spyOn(console, "error").mockImplementation(() => {});
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await session.runHermeticSessionCanary({ agent: "claude", autonomy: "read-only", passthroughEnv: [],
      timeoutMs: 10_000, sandboxLoginStore: policy.loginStore, sandboxNoLoginStore: policy.noLoginStore })).toBe(0);
    const records = readFileSync(state, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[] });
    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(record.argv.includes("--sandbox-login-store")).toBe(policy.loginStore);
      expect(record.argv.includes("--sandbox-no-login-store")).toBe(policy.noLoginStore);
    }
  } finally { stdout.mockRestore(); error.mockRestore(); credentials.mockRestore(); command.mockRestore(); process.env = saved; }
});
