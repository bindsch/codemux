// A login-store value the configuration file supplies is not a flag the
// caller typed: an unsandboxed launch must not warn about it on every run
// (review round 3). A typed flag still warns.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loginStoreCliOptions, parseSandboxPolicyOverrides } from "../src/cli-runtime/options.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/login-config-warning-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const WARNING = "sandbox policy flags require --sandbox, ignoring";

test("the option origin comes from commander's value source", () => {
  const source = (typed: string[]) => ({ getOptionValueSource: (name: string) => typed.includes(name) ? "cli" : "default" });
  expect(loginStoreCliOptions({ sandboxLoginStore: true }, source([])))
    .toEqual({ sandboxNoLoginStore: false, sandboxLoginStore: true, loginStoreTyped: false });
  expect(loginStoreCliOptions({ sandboxNoLoginStore: true }, source(["sandboxNoLoginStore"])))
    .toEqual({ sandboxNoLoginStore: true, sandboxLoginStore: false, loginStoreTyped: true });
});

test("configured login-store values do not warn without a sandbox; typed flags and other policy flags do", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const flags of [{ sandboxLoginStore: true }, { sandboxNoLoginStore: true }]) {
      parseSandboxPolicyOverrides({ sandbox: false, ...flags, loginStoreTyped: false });
      expect(warn).not.toHaveBeenCalled();
      parseSandboxPolicyOverrides({ sandbox: false, ...flags, loginStoreTyped: true });
      expect(warn).toHaveBeenCalledTimes(1);
      // A caller that states no origin keeps the warning.
      parseSandboxPolicyOverrides({ sandbox: false, ...flags });
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockClear();
    }
    parseSandboxPolicyOverrides({ sandbox: false, sandboxLoginStore: true, sandboxNoNet: true, loginStoreTyped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    // With a sandbox the configured value still takes effect.
    expect(parseSandboxPolicyOverrides({ sandbox: true, sandboxLoginStore: true, loginStoreTyped: false })?.loginStore).toBe(true);
  } finally { warn.mockRestore(); }
});

test.each(["sandboxLoginStore", "sandboxNoLoginStore"])("run --no-sandbox with %s: true in the user config prints no warning", async (key) => {
  const home = join(root, key);
  mkdirSync(join(home, ".config/codemux"), { recursive: true });
  writeFileSync(join(home, ".config/codemux/config.yaml"), `${key}: true\n`);
  const fake = createFakeBinaryEnv({ claude: "printf 'ran\\n'" });
  const env = { ...fake.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const flags = ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "--no-quota-gate", "-p", "test"];
  try {
    // The warning is decided while options are parsed, before the launch;
    // the stub harness's reply is not what this test is about.
    const configured = await runCli(flags, env);
    expect(configured.stderr).toContain("Running with claude");
    expect(configured.stderr).not.toContain(WARNING);
    const typed = await runCli([...flags, "--sandbox-login-store"], env);
    expect(typed.stderr).toContain(WARNING);
  } finally { fake.cleanup(); }
});
