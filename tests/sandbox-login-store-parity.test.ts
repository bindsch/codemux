import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import { PARITY } from "../src/parity/index.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { runSessionCommand } from "./helpers/session-command.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/login-parity-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const versions = {
  claude: "2.1.317", codex: "codex-cli 0.166.0", zai: "2.1.317", agy: "1.5.3",
  aider: "aider 0.86.2", cline: "3.0.74", copilot: "Copilot binary version: 1.0.85",
  cursor: "2026.11.05", droid: "0.221.0", gemini: "0.60.0", goose: "1.50.1",
  kimi: "2.5.2", opencode: "1.19.5", openhands: "OpenHands CLI 1.16.0", pi: "0.85.1", qwen: "0.24.0",
};
const fixture = (version: string) =>
  `case "$1" in --version|--binary-version) printf '%s\\n' '${version}'; exit 0;; esac\nexit 99`;
const binary = (agent: string) => agent === "zai" ? "claude" : agent === "cursor" ? "cursor-agent" : agent;
const loginGrants = (stdout: string) => {
  const argv = stdout.trimEnd().split("\n");
  return argv.slice(0, argv.indexOf("--")).filter((arg) => /Keychains|com\.apple\.security|oauth_refresh/.test(arg));
};
function environment(name: string) {
  const home = join(root, name), cwd = join(home, "project");
  for (const dir of [cwd, join(cwd, ".git"), join(home, "Library/Keychains"), join(home, ".config/codemux")]) {
    mkdirSync(dir, { recursive: true });
  }
  return { home, cwd, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"), ZAI_API_KEY: "synthetic", GEMINI_API_KEY: "",
    ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_OAUTH_TOKEN: "" } };
}

// Version-only shims refuse execution. No native store or harness is accessed.
describe.each([...AGENT_IDS])("%s login opt-in parity", (agent) => {
  test.each(["run", "session", "tui", "check"] as const)("%s defaults off and honors explicit opt-in and denial", async (mode) => {
    const { cwd, env } = environment(`${agent}-${mode}`);
    const binaries = { [binary(agent)]: fixture(versions[agent]), scode: "exit 99" };
    const fake = createFakeBinaryEnv(binaries, "0.6.8");
    try {
      for (const policy of [[], ["--sandbox-login-store"], ["--sandbox-login-store", "--sandbox-no-login-store"]]) {
        const flags = ["-a", agent, ...policy, "--cwd", cwd, "--print-sandbox", "--no-quota-gate"];
        const result = mode === "session"
          ? await runSessionCommand(flags, binaries, { env, scodeVersion: "0.6.8" })
          : await runCli([mode, ...flags, ...(mode === "run" ? ["-p", "unused"] : [])], { ...fake.env, ...env });
        expect(result.exitCode, result.stderr).toBe(0);
        const native = process.platform === "darwin" && (agent === "claude" || agent === "agy");
        expect(loginGrants(result.stdout).length > 0).toBe(native && policy.length === 1);
        if (policy.length !== 1) expect(result.stdout.split("\n")).toContain("--no-login-store");
        expect(PARITY[agent][`${mode}.sandbox-login-store`].state).toBe("supported");
      }
    } finally { fake.cleanup(); }
  });
});

test.each(["run", "session", "tui", "check"])("%s reads only the user opt-in and lets denial win", async (mode) => {
  const { home, cwd, env } = environment(`config-${mode}`);
  const fake = createFakeBinaryEnv({ claude: fixture(versions.claude), scode: "exit 99" }, "0.6.8");
  const config = join(home, ".config/codemux/config.yaml");
  const flags = [mode, "-a", "claude", "--cwd", cwd, "--print-sandbox", "--no-quota-gate",
    ...(mode === "run" ? ["-p", "unused"] : [])];
  try {
    writeFileSync(join(cwd, "config.yaml"), "sandboxLoginStore: true\n");
    mkdirSync(join(cwd, ".codemux"));
    writeFileSync(join(cwd, ".codemux/config.yaml"), "sandboxLoginStore: true\n");
    const project = await runCli(flags, { ...fake.env, ...env });
    expect(project.exitCode, project.stderr).toBe(0);
    expect(loginGrants(project.stdout)).toEqual([]);
    for (const denied of [false, true]) {
      writeFileSync(config, `sandboxLoginStore: true\nsandboxNoLoginStore: ${denied}\n`);
      const result = await runCli(flags, { ...fake.env, ...env });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(loginGrants(result.stdout).length > 0).toBe(process.platform === "darwin" && !denied);
      const cliDenied = await runCli([...flags, "--sandbox-no-login-store"], { ...fake.env, ...env });
      expect(cliDenied.exitCode, cliDenied.stderr).toBe(0);
      expect(loginGrants(cliDenied.stdout)).toEqual([]);
    }
    const configDenied = await runCli([...flags, "--sandbox-login-store"], { ...fake.env, ...env });
    expect(configDenied.exitCode, configDenied.stderr).toBe(0);
    expect(loginGrants(configDenied.stdout)).toEqual([]);
  } finally { fake.cleanup(); }
});

test.each([
  { args: ["agy", "--hermetic"] }, { args: ["agy", "--agy-isolation-probe", "login"] },
  { args: ["claude", "--hermetic", "--session"] },
])("managed canary still refuses unrelated policy overrides with opt-in: %j", async ({ args }) => {
  const result = await runCli(["check", "-a", ...args, "--sandbox-login-store", "--sandbox-no-net", "--no-quota-gate"]);
  expect(result.exitCode, result.stderr).toBe(64);
  expect(result.stderr).toMatch(/default.*scode|sandbox policy overrides/);
});
