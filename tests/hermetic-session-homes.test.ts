/**
 * Unit tests for the hermetic SESSION home pieces: the two populate
 * functions the launcher calls at a private home's creation
 * (populateCodexHermeticSessionHome, populateKimiHermeticSessionHome), the
 * kimi session config generation (kimiSessionHermeticConfig and its
 * writer), the settled-path naming rule (private-home-key.ts), and the
 * codex session spawn prefix. The driver behaviors over these are
 * tests/session-codex-e2e-hermetic.test.ts and
 * tests/session-kimi-e2e-hermetic.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_SESSION_HERMETIC_CONFIG,
  populateCodexHermeticSessionHome,
} from "../src/hermetic-home.js";
import {
  kimiPrivateBrandHome,
  kimiPrivateSkillsDir,
  kimiSessionHermeticConfig,
  populateKimiHermeticSessionHome,
  writeKimiSessionHermeticConfig,
} from "../src/kimi-hermetic.js";
import {
  currentPrivateHomeDir,
  settledPrivateHomePath,
} from "../src/session/private-home-key.js";
import {
  buildCodexSessionCommand,
  codexSessionHermeticEnvPrefix,
} from "../src/session/codex-session.js";

const scratch: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "codemux-session-homes-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("populateCodexHermeticSessionHome", () => {
  test("writes the file-login config and hard-links the real auth.json", () => {
    const parent = dir();
    const sourceCodexHome = join(parent, "codex");
    mkdirSync(sourceCodexHome);
    writeFileSync(join(sourceCodexHome, "auth.json"), "{}");
    const home = join(parent, "run-1");
    mkdirSync(home);
    const { codexHome } = populateCodexHermeticSessionHome(home, sourceCodexHome);
    expect(codexHome).toBe(join(home, ".codex"));
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(CODEX_SESSION_HERMETIC_CONFIG);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(
      'cli_auth_credentials_store = "file"\n'
    );
    // The hard link shares the inode with the real login, so the
    // session's token rotations reach the operator's file.
    expect(statSync(join(codexHome, "auth.json")).ino).toBe(
      statSync(join(sourceCodexHome, "auth.json")).ino
    );
  });

  test("falls back to a symlink where the hard link cannot be made", () => {
    const parent = dir();
    const sourceCodexHome = join(parent, "codex");
    mkdirSync(sourceCodexHome);
    writeFileSync(join(sourceCodexHome, "auth.json"), "{}");
    const home = join(parent, "run-1");
    mkdirSync(home);
    populateCodexHermeticSessionHome(home, sourceCodexHome, false, {
      hard: () => {
        throw new Error("no hard links here");
      },
      symlink: (source, destination) => symlinkSync(source, destination),
    });
    const link = join(home, ".codex", "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("{}");
  });

  test("refuses a Keychain-only login with the run path's own message", () => {
    const parent = dir();
    const sourceCodexHome = join(parent, "codex");
    mkdirSync(sourceCodexHome);
    const home = join(parent, "run-1");
    mkdirSync(home);
    expect(() => populateCodexHermeticSessionHome(home, sourceCodexHome)).toThrow(
      /codex hermetic runs need a file login: .* does not exist/
    );
    // Nothing was left behind by the refusal.
    expect(readdirSync(home)).toEqual([]);
  });

  test("an API-key session carries the config and no login at all", () => {
    const parent = dir();
    const sourceCodexHome = join(parent, "codex");
    mkdirSync(sourceCodexHome);
    const home = join(parent, "run-1");
    mkdirSync(home);
    const { codexHome } = populateCodexHermeticSessionHome(home, sourceCodexHome, true);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(CODEX_SESSION_HERMETIC_CONFIG);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });
});

describe("kimi session hermetic config", () => {
  test("an operator-less source generates the session key alone", () => {
    const dest = join(dir(), "brand");
    mkdirSync(dest);
    const parsed = Bun.TOML.parse(kimiSessionHermeticConfig(null, dest)) as Record<string, any>;
    expect(Object.keys(parsed)).toEqual(["auto_session_title"]);
    expect(parsed.auto_session_title).toBe(false);
  });

  test("the consumer's pre-write wins allowlisted keys and keeps its permission table whole", () => {
    const parent = dir();
    const operator = join(parent, "operator");
    mkdirSync(operator);
    writeFileSync(
      join(operator, "config.toml"),
      [
        'default_model = "operator/model.v1"',
        'default_permission_mode = "auto"',
        "[permission]",
        "rules = []",
        "",
      ].join("\n")
    );
    const dest = join(parent, "brand");
    mkdirSync(dest);
    writeFileSync(
      join(dest, "config.toml"),
      ['default_model = "consumer/model.v2"', "[[permission.rules]]", 'tool = "Bash"', 'allow = "ls"', ""].join("\n")
    );
    const parsed = Bun.TOML.parse(kimiSessionHermeticConfig(operator, dest)) as Record<string, any>;
    expect(parsed.default_model).toBe("consumer/model.v2");
    expect(parsed.default_permission_mode).toBeUndefined();
    expect(parsed.permission).toEqual({ rules: [{ tool: "Bash", allow: "ls" }] });
    expect(parsed.auto_session_title).toBe(false);
  });

  test("the writer puts the generation in the brand home", () => {
    const parent = dir();
    const brand = join(parent, "brand");
    mkdirSync(brand);
    writeKimiSessionHermeticConfig(brand, null);
    expect(readFileSync(join(brand, "config.toml"), "utf8")).toBe(
      '"auto_session_title" = false\n'
    );
  });
});

describe("populateKimiHermeticSessionHome", () => {
  test("creates the brand home and skills dir, links credentials, and writes no config", () => {
    const parent = dir();
    const operator = join(parent, "operator");
    mkdirSync(join(operator, "credentials"), { recursive: true });
    writeFileSync(join(operator, "region"), "test-region");
    writeFileSync(join(operator, "device_id"), "test-device");
    const home = join(parent, "run-1");
    mkdirSync(home);
    const { brandHome, skillsDir } = populateKimiHermeticSessionHome(home, operator);
    expect(brandHome).toBe(kimiPrivateBrandHome(home));
    expect(skillsDir).toBe(kimiPrivateSkillsDir(home));
    expect(statSync(brandHome).mode & 0o777).toBe(0o700);
    expect(statSync(skillsDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(brandHome, "credentials")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(brandHome, "region"), "utf8")).toBe("test-region");
    expect(readFileSync(join(brandHome, "device_id"), "utf8")).toBe("test-device");
    // The config is the first turn's generation, never the populate's.
    expect(existsSync(join(brandHome, "config.toml"))).toBe(false);
    expect(readdirSync(skillsDir)).toEqual([]);
  });

  test("a print-only home creates the directories and nothing else", () => {
    const parent = dir();
    const home = join(parent, "run-1");
    mkdirSync(home);
    const { brandHome, skillsDir } = populateKimiHermeticSessionHome(home, null, true);
    expect(readdirSync(brandHome)).toEqual([]);
    expect(readdirSync(skillsDir)).toEqual([]);
  });
});

describe("the settled-path rule", () => {
  test("the key is the session id beside the run-shaped dir, idempotent once settled", () => {
    const parent = dir();
    const fresh = join(parent, "run-1");
    expect(settledPrivateHomePath(fresh, "abc")).toBe(join(parent, "session-abc"));
    const settled = settledPrivateHomePath(fresh, "abc");
    expect(settledPrivateHomePath(settled, "abc")).toBe(settled);
  });

  test("the current dir recomputes after settle for a respawning driver", () => {
    const parent = dir();
    const fresh = join(parent, "run-1");
    expect(currentPrivateHomeDir({ dir: fresh, settled: false }, "abc")).toBe(fresh);
    expect(currentPrivateHomeDir({ dir: fresh, settled: true }, "abc")).toBe(
      join(parent, "session-abc")
    );
  });
});

describe("the codex session hermetic spawn", () => {
  test("the prefix carries the private home as both HOME and CODEX_HOME", () => {
    expect(codexSessionHermeticEnvPrefix("/private/home-1")).toEqual([
      "HOME=/private/home-1",
      "CODEX_HOME=/private/home-1/.codex",
    ]);
  });

  test("the command wraps the prefix exactly like the run path", () => {
    expect(buildCodexSessionCommand()).toEqual(["codex", "app-server"]);
    const prefix = codexSessionHermeticEnvPrefix("/private/home-1");
    expect(buildCodexSessionCommand(prefix)).toEqual([
      "env",
      "HOME=/private/home-1",
      "CODEX_HOME=/private/home-1/.codex",
      "codex",
      "app-server",
    ]);
    // The bare spawn never carries a trailing env(1) wrapper.
    expect(buildCodexSessionCommand([])).toEqual(["codex", "app-server"]);
  });
});
