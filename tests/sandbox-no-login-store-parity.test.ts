import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import { PARITY } from "../src/parity/index.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { runSessionCommand } from "./helpers/session-command.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/no-login-parity-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const versions = {
  claude: "2.1.317", codex: "codex-cli 0.166.0", zai: "2.1.317", agy: "1.5.3",
  aider: "aider 0.86.2", cline: "3.0.74", copilot: "Copilot binary version: 1.0.85",
  cursor: "2026.11.05", droid: "0.221.0", gemini: "0.60.0", goose: "1.50.1",
  kimi: "2.5.2", opencode: "1.19.5", openhands: "OpenHands CLI 1.16.0", pi: "0.85.1", qwen: "0.24.0",
};
const binary = (agent: string) => agent === "zai" ? "claude" : agent === "cursor" ? "cursor-agent" : agent;
const fixture = (version: string) =>
  `case "$1" in --version|--binary-version) printf '%s\\n' '${version}'; exit 0;; esac\nexit 99`;

// Only synthetic version probes run. A harness launch would fail with exit 99.
describe.each([...AGENT_IDS])("%s login-store option parity", (agent) => {
  test.each(["run", "session", "tui", "check"] as const)("%s accepts and forwards the off switch", async (mode) => {
    const home = join(root, `${agent}-${mode}`), cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true }); mkdirSync(join(cwd, ".git"));
    const binaries = { [binary(agent)]: fixture(versions[agent]), scode: "exit 99" };
    const fake = createFakeBinaryEnv(binaries, "0.6.11");
    const env = { ...fake.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"), ZAI_API_KEY: "synthetic" };
    const flags = ["-a", agent, "--sandbox-no-login-store", "--cwd", cwd, "--print-sandbox", "--no-quota-gate"];
    try {
      const result = mode === "session"
        ? await runSessionCommand(flags, binaries, { env, scodeVersion: "0.6.11" })
        : await runCli([mode, ...flags, ...(mode === "run" ? ["-p", "unused"] : [])], env);
      expect(result.exitCode, result.stderr).toBe(0);
      const argv = result.stdout.trimEnd().split("\n");
      const policy = argv.slice(0, argv.indexOf("--"));
      expect(policy.filter((arg) => arg === "--no-login-store")).toHaveLength(1);
      expect(policy).not.toContain("--allow-staged");
      expect(policy.some((arg) => /Keychains|com\.apple\.security|oauth_refresh/.test(arg))).toBe(false);
      expect(PARITY[agent][`${mode}.sandbox-no-login-store`].state).toBe("supported");
    } finally { fake.cleanup(); }
  });
});

test.each(["run", "session", "tui", "check"])("%s defaults the off switch from config", async (mode) => {
  const home = join(root, `config-${mode}`), config = join(home, ".config/codemux"), cwd = join(home, "project");
  mkdirSync(config, { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(config, "config.yaml"), "sandboxNoLoginStore: true\nquota: false\n");
  const fake = createFakeBinaryEnv({ claude: fixture(versions.claude), scode: "exit 99" }, "0.6.11");
  try {
    const result = await runCli([mode, "-a", "claude", "--cwd", cwd, "--print-sandbox",
      ...(mode === "run" ? ["-p", "unused"] : [])],
    { ...fake.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.split("\n")).toContain("--no-login-store");
    expect(result.stderr.match(/the sandbox was not granted the login store/g) ?? []).toHaveLength(process.platform === "darwin" ? 1 : 0);
  } finally { fake.cleanup(); }
});

test.each([
  { args: ["agy", "--hermetic"] }, { args: ["agy", "--agy-isolation-probe", "login"] },
  { args: ["claude", "--hermetic", "--session"] },
])("policy-managed check refuses unrelated overrides with denial: %j", async ({ args }) => {
  const result = await runCli(["check", "-a", ...args, "--sandbox-no-login-store", "--sandbox-no-net", "--no-quota-gate"]);
  expect(result.exitCode, result.stderr).toBe(64);
  expect(result.stderr).toMatch(/default.*scode|sandbox policy overrides/);
});
