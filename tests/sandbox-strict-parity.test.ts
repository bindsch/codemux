import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import { PARITY } from "../src/parity/index.js";
import { buildScodeCommand } from "../src/sandbox.js";
import { parseSandboxPolicyOverrides } from "../src/cli-runtime/options.js";
import { resolveSandboxOptionsForAgent } from "../src/sandbox-policy.js";
import { lookupForResume, readRegistry, recordSessionStart } from "../src/session/registry.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { craftEntry, newRecord, probe, seedRegistry } from "./helpers/session-registry.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/strict-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Every harness is a fixture; no installed harness, login, or Keychain is used.
const versions = {
  claude: "2.1.317", codex: "codex-cli 0.166.0", zai: "2.1.317", agy: "1.5.3",
  aider: "aider 0.86.2", cline: "3.0.74", copilot: "Copilot binary version: 1.0.85",
  cursor: "2026.11.05", droid: "0.221.0", gemini: "0.60.0", goose: "1.50.1",
  kimi: "2.5.2", opencode: "1.19.5", openhands: "OpenHands CLI 1.16.0", pi: "0.85.1", qwen: "0.24.0",
};
const binary = (agent: string) => agent === "zai" ? "claude" : agent === "cursor" ? "cursor-agent" : agent;
const fixtureBinary = (version: string) =>
  `case "$1" in --version|--binary-version) printf '%s\\n' '${version}'; exit 0;; esac\nexit 99`;

describe.each([...AGENT_IDS])("%s strict sandbox parity", (agent) => {
  test.each(["run", "session", "tui", "check"] as const)("%s prints --strict with existing policy intact", async (mode) => {
    const dir = join(root, `${agent}-${mode}`), home = join(dir, "home"), cwd = join(dir, "project");
    mkdirSync(home, { recursive: true }); mkdirSync(cwd);
    mkdirSync(join(cwd, ".git"));
    const binaries = { [binary(agent)]: fixtureBinary(versions[agent]), scode: "exit 99" };
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"), ZAI_API_KEY: "synthetic", CODEMUX_NO_KEYCHAIN_SYNC: "1" };
    const flags = ["-a", agent, "--sandbox", "--sandbox-strict", "--sandbox-trust", "trusted",
      "--sandbox-no-net", "--sandbox-block", join(home, "unrelated"), "--cwd", cwd, "--print-sandbox"];
    const fake = createFakeBinaryEnv(binaries);
    try {
      const result = mode === "session"
        ? await runSessionCommand(flags, binaries, { env })
        : await runCli([mode, ...flags, ...(mode === "run" ? ["-p", "unused preview"] : [])], { ...fake.env, ...env });
      if ((agent === "agy" && (mode === "run" || mode === "check")) || (agent === "cline" && mode === "session")) {
        expect(result.exitCode, result.stderr).toBe(64);
        expect(result.stderr).toContain("strict sandbox cannot read env-wrapped executable");
        expect(result.stderr).not.toContain("harness state directory");
        return;
      }
      expect(result.exitCode, result.stderr).toBe(0);
      const argv = result.stdout.trimEnd().split("\n");
      const policy = argv.slice(0, argv.indexOf("--"));
      expect(policy.filter((arg) => arg === "--strict")).toHaveLength(1);
      expect(policy).toContain("trusted");
      expect(policy).toContain("--no-net");
      expect(policy).toContain(join(home, "unrelated"));
      expect(PARITY[agent][`${mode}.sandbox-strict`]).toBeDefined();
    } finally { fake.cleanup(); }
  });
});

test.each(["run", "session", "tui", "check"])("%s refuses strict without sandbox with exit 64", async (mode) => {
  const result = await runCli([mode, "-a", "claude", "--no-sandbox", "--auto", "high",
    "--sandbox-strict", ...(mode === "run" ? ["-p", "unused preview"] : [])]);
  expect(result.exitCode, result.stderr).toBe(64);
  expect(result.stderr).toContain("--sandbox-strict requires --sandbox");
});

test("hermetic OpenCode session reaches the nested-executable refusal, not its own isolation-block veto", async () => {
  const home = join(root, "nested-home"), cwd = join(root, "nested-project");
  mkdirSync(home); mkdirSync(cwd);
  const result = await runSessionCommand(["-a", "opencode", "--hermetic", "--sandbox", "--sandbox-strict",
    "--cwd", cwd, "--print-sandbox"], { opencode: fixtureBinary(versions.opencode), scode: "exit 99" },
    { env: { HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state") } });
  expect(result.exitCode, result.stderr).toBe(64);
  expect(result.stderr).toContain("env-wrapped executable");
  expect(result.stderr).toContain("opencode");
  expect(result.stderr).not.toContain("--sandbox-block");
});

test.each(["standard", "trusted", "untrusted"] as const)("strict composes with %s and preserves explicit grants", (trust) => {
  const overrides = parseSandboxPolicyOverrides({ sandbox: true, sandboxStrict: true, sandboxTrust: trust });
  const options = resolveSandboxOptionsForAgent("claude", "low", overrides);
  const argv = buildScodeCommand(["claude"], root, "low", {
    ...options, harnessStateDirs: [join(root, "private-state"), join(root, "relay.sock")],
  });
  expect(argv).toContain("--strict");
  expect(argv.slice(argv.indexOf("--trust"), argv.indexOf("--trust") + 2)).toEqual(["--trust", trust]);
  expect(argv).toContain(join(root, "private-state"));
  expect(argv).toContain(join(root, "relay.sock"));
  expect(argv).toContain(trust === "untrusted" ? "--ro" : "--rw");
});

test("strict cannot bypass the sandbox requirement through diagnostic parsing", () => {
  expect(() => parseSandboxPolicyOverrides({ sandbox: false, sandboxStrict: true }, true))
    .toThrow("--sandbox-strict requires --sandbox");
  expect(buildScodeCommand(["claude"])).not.toContain("--strict");
});

test.each([
  { agent: "agy", options: ["--hermetic"] }, { agent: "claude", options: ["--hermetic", "--session"] },
])("policy-managed check refuses strict instead of dropping it: %j", async ({ agent, options }) => {
  const result = await runCli(["check", "-a", agent, ...options, "--sandbox-strict"]);
  expect(result.exitCode, result.stderr).toBe(64);
  expect(result.stderr).toMatch(/default.*scode|sandbox policy overrides/);
});

test("registry persists strict and refuses either resume mismatch", () => {
  const path = join(root, "registry", "strict.json");
  const saved = recordSessionStart(path, newRecord({ sandboxed: true, sandbox_strict: true }));
  expect(saved.ok).toBe(true);
  expect(lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxStrict: true })).outcome).toBe("ok");
  const mismatch = lookupForResume(path, "sess-1", probe({ sandboxed: true }));
  expect(mismatch.outcome).toBe("refused");
  if (mismatch.outcome === "refused") expect(mismatch.reason).toContain("--sandbox-strict");
  seedRegistry(path, [craftEntry({ sandboxed: true })]);
  const legacy = readRegistry(path);
  expect(legacy.outcome).toBe("ok");
  if (legacy.outcome === "ok") expect(legacy.file.sessions[0]?.sandbox_strict).toBe(false);
  expect(lookupForResume(path, "sess-1", probe({ sandboxed: true })).outcome).toBe("ok");
  expect(lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxStrict: true })).outcome).toBe("refused");
  seedRegistry(path, [craftEntry({ sandbox_strict: "true" as unknown as boolean })]);
  expect(readRegistry(path).outcome).toBe("corrupt");
});
