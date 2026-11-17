import { expect, test } from "bun:test";
import { alignClaudeSecureStorage, claudeLoginDirectory, claudeLoginPaths, claudeSecureStorageEnv } from "../src/claude-login.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { claudeCredentialTarget, claudeOauthObject } from "../src/credentials.js";
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { withTarget } from "./helpers/credentials.js";

test.each([
  [{}, ""],
  [{ HOME: "/synthetic" }, ""],
  [{ CLAUDE_CONFIG_DIR: "/profile" }, "/profile"],
  [{ CLAUDE_CONFIG_DIR: "" }, ""],
  [{ CLAUDE_CONFIG_DIR: "/profile", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/login" }, "/login"],
  [{ CLAUDE_CONFIG_DIR: "/profile", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }, ""],
] as const)("macOS preserves the native login namespace from %j", (environment, expected) => {
  const before = { ...environment };
  expect(claudeSecureStorageEnv(environment, "darwin")).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: expected });
  expect(environment).toEqual(before);
});

test.each(["linux", "win32"] as const)("%s adds no native storage override", (platform) => {
  expect(claudeSecureStorageEnv({ CLAUDE_CONFIG_DIR: "/profile", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/login" }, platform)).toEqual({});
});

test("file-only login resolution honors the explicit secure storage override", () => {
  expect(claudeLoginDirectory({ HOME: "/synthetic" })).toBe("/synthetic/.claude");
  expect(claudeLoginDirectory({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "/profile" })).toBe("/profile");
  expect(claudeLoginDirectory({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "/profile", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/login" })).toBe("/login");
  expect(claudeLoginDirectory({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "/profile", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" })).toBe("/synthetic/.claude");
  expect(claudeCredentialTarget("/synthetic")).toBe("/synthetic/.claude/.credentials.json");
});

test.each(["invalid", "null", "[]", "{}", '{"claudeAiOauth":null}', '{"claudeAiOauth":[]}', '{"claudeAiOauth":"token"}'])("OAuth parsing rejects %s", (text) => {
  expect(claudeOauthObject(text)).toBeNull();
});

test("OAuth parsing returns only the supplied OAuth object", () => {
  expect(claudeOauthObject('{"claudeAiOauth":{"accessToken":"synthetic","refreshToken":"refresh"},"mcpOAuth":{"secret":"other"}}'))
    .toEqual({ accessToken: "synthetic", refreshToken: "refresh" });
});

test("native lock grants follow Claude's canonical legacy path and relative storage root", () => {
  withTarget((_target, rawHome) => {
    const home = realpathSync(rawHome);
    const profile = join(home, "profile");
    mkdirSync(profile);
    const alias = join(home, "alias");
    symlinkSync(profile, alias);
    expect(claudeLoginPaths({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "alias" }, home)).toEqual([
      join(alias, ".oauth_refresh.lock"), join(alias, ".oauth_refresh.lock.owner"), `${profile}.lock`,
    ]);
    expect(claudeLoginPaths({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "absent" }, home)).toEqual([
      join(home, "absent", ".oauth_refresh.lock"), join(home, "absent", ".oauth_refresh.lock.owner"), join(home, "absent.lock"),
    ]);
  });
});

test("an empty CLAUDE_CONFIG_DIR selects the default directory, never the working directory", () => {
  expect(claudeLoginDirectory({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "" })).toBe("/synthetic/.claude");
  const paths = claudeLoginPaths({ HOME: "/synthetic", CLAUDE_CONFIG_DIR: "" }, "/synthetic/project");
  expect(paths).toEqual(["/synthetic/.claude/.oauth_refresh.lock", "/synthetic/.claude/.oauth_refresh.lock.owner",
    "/synthetic/.claude.lock"]);
  expect(paths.some((path) => path.startsWith("/synthetic/project"))).toBe(false);
});

test("a plain launch selects the login of the configuration the child reads", () => {
  // Review round 4, correctness 3: an exported but unforwarded CLAUDE_CONFIG_DIR picked that profile's Keychain item.
  const ambient = { HOME: "/synthetic", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/profile" };
  const align = (child: Record<string, string>, from: NodeJS.ProcessEnv = ambient) => { alignClaudeSecureStorage(child, from); return child; };
  // Not forwarded: the child reads ~/.claude, so the default item and the default grants.
  const plain = align({ HOME: "/synthetic", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/profile" });
  expect(plain.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
  expect(claudeLoginDirectory(plain)).toBe("/synthetic/.claude");
  // Forwarded with --pass-env, or redirected to a private directory: the profile's item.
  for (const config of ["/profile", "/synthetic/.claude/.codemux-hermetic/run"]) {
    expect(align({ CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/profile" }).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/profile");
  }
  // An explicit selection is kept; a child without the variable gains none.
  expect(align({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/login" }, { ...ambient, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/login" })
    .CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/login");
  expect(align({ HOME: "/synthetic" })).toEqual({ HOME: "/synthetic" });
  expect(readFileSync(join(import.meta.dir, "../docs/authentication.md"), "utf8"))
    .toContain("exported but not forwarded does not reach the child");
  // The launch's own environment builder applies it.
  const adapter = new ClaudeAdapter(ambient);
  const selected = (env: Record<string, string>) => env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const mac = process.platform === "darwin";
  const unforwarded = adapter.buildExecutionEnv({}, []);
  expect(unforwarded.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(selected(unforwarded)).toBe(mac ? "" : undefined);
  expect(selected(adapter.buildExecutionEnv({}, ["CLAUDE_CONFIG_DIR"]))).toBe(mac ? "/profile" : undefined);
  expect(selected(adapter.buildExecutionEnv({ CLAUDE_CONFIG_DIR: "/private", ...adapter.getEnv() }, []))).toBe(mac ? "/profile" : undefined);
});
