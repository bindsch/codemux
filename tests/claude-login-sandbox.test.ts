import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { nativeLoginPaths } from "../src/native-login-paths.js";
import { projectSettingsBlockedStatePaths } from "../src/claude-project-config.js";
import { withTarget } from "./helpers/credentials.js";

const grants = (command: string[]) => command.filter((_, index) => command[index - 1] === "--allow");
function onMac<T>(body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  try { return body(); } finally { Object.defineProperty(process, "platform", descriptor); }
}
function fixture(body: (home: string, root: string, expected: string[]) => void): void {
  withTarget((_target, rawHome) => {
    const home = realpathSync(rawHome);
    const root = join(home, ".claude");
    mkdirSync(root);
    const keychains = join(home, "Library/Keychains");
    const preferences = join(home, "Library/Preferences/com.apple.security.plist");
    mkdirSync(keychains, { recursive: true });
    mkdirSync(join(home, "Library/Preferences"), { recursive: true });
    writeFileSync(preferences, "native settings");
    writeFileSync(join(root, ".credentials.json"), "native plaintext fallback");
    body(home, root, [keychains, join(root, ".oauth_refresh.lock"),
      join(root, ".oauth_refresh.lock.owner"), `${root}.lock`, join(root, ".credentials.json")]);
  });
}
const build = (home: string, options: SandboxOptions = {}, env: NodeJS.ProcessEnv = {}) =>
  onMac(() => buildScodeCommand(["/bin/echo", "synthetic"], undefined, "low", { agentId: "claude", loginStore: true, ...options }, "scode", { HOME: home, ...env }, true));

test.each(["standard", "trusted"] as const)("%s Claude grants native storage and refresh locks without creating them", (trust) => {
  fixture((home, root, expected) => {
    const command = build(home, { trust });
    expect(command.slice(0, 2)).toEqual(["scode", "--no-credential-sync"]);
    expect(grants(command)).toEqual(expected);
    for (const lock of expected.slice(1, 4)) expect(existsSync(lock)).toBe(false);
    expect(command.filter((_, i) => command[i - 1] === "--allow-ro")).toEqual([join(home, "Library/Preferences/com.apple.security.plist")]);
    expect(readFileSync(join(root, ".credentials.json"), "utf8")).toBe("native plaintext fallback");
  });
});

test.each([
  { trust: "untrusted" as const }, { agentId: "zai" as const },
])("%j does not grant Claude native login access", (options) => {
  fixture((home) => expect(grants(build(home, options))).toEqual([]));
});

test.each([{ ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" }, { ANTHROPIC_AUTH_TOKEN: "synthetic" },
  { ANTHROPIC_API_KEY: "synthetic" }, { CLAUDE_CODE_OAUTH_TOKEN: "synthetic" }])(
  "provider environment %j grants no subscription login", (env) => {
    fixture((home) => expect(grants(build(home, {}, env))).toEqual([]));
  });

test("a captured profile selects only its native lock and fallback paths", () => {
  fixture((home, root, expected) => {
    const profile = join(home, "profile"); mkdirSync(profile);
    const profileFile = join(profile, ".credentials.json"); writeFileSync(profileFile, "profile login");
    const profileGrants = [...expected.slice(0, 1), join(profile, ".oauth_refresh.lock"),
      join(profile, ".oauth_refresh.lock.owner"), `${profile}.lock`, profileFile];
    expect(grants(build(home, {}, { CLAUDE_CONFIG_DIR: profile }))).toEqual(profileGrants);
    expect(grants(build(home, {}, { CLAUDE_CONFIG_DIR: root, CLAUDE_SECURESTORAGE_CONFIG_DIR: profile }))).toEqual(profileGrants);
    expect(grants(build(home, {}, { CLAUDE_CONFIG_DIR: profile, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }))).toEqual(expected);
  });
});

test("caller blocks conflicting with native login access refuse, while launcher isolation keeps exact grants", () => {
  fixture((home, root, expected) => {
    for (const block of [home, expected[0]!, join(expected[0]!, "login.keychain-db"), expected[2]!, root]) {
      expect(() => build(home, { blockPaths: [block] })).toThrow("--sandbox-block");
    }
    const command = build(home, { blockPaths: [root], callerBlockPaths: [] });
    expect(command).toContain("--block");
    expect(grants(command)).toEqual(expected);
    expect(grants(command)).not.toContain(root);
  });
});

test("native store discovery is read-only and absent off macOS", () => {
  fixture((home, _root, expected) => {
    expect(nativeLoginPaths(home, "darwin")).toEqual([expected[0]!, join(home, "Library/Preferences/com.apple.security.plist")]);
    expect(nativeLoginPaths(home, "linux")).toEqual([]);
    expect(nativeLoginPaths(join(home, "missing"), "darwin")).toEqual([]);
  });
});

test("hermetic blocks include captured nondefault configuration and secure storage roots", () => {
  expect(projectSettingsBlockedStatePaths({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "/profile", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/login" }))
    .toEqual(["/synthetic/.claude", "/synthetic/.claude.json", "/profile", "/login"]);
  expect(projectSettingsBlockedStatePaths({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "/synthetic/.claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }))
    .toEqual(["/synthetic/.claude", "/synthetic/.claude.json"]);
});
