import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import * as runtime from "../src/cli-runtime.js";
import * as executables from "../src/executable-security.js";
import {
  applyHarnessHomeSandboxBlocks,
  harnessHomeBlockedPaths,
} from "../src/launch/harness-home-sandbox.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { resolveSessionSandboxSpawn } from "../src/session/spawn.js";
import { UsageRefusalError } from "../src/validation.js";

// Every path inspected here belongs to this fixture. No harness or scode
// process runs, including in the print/spawn resolver test below.
const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/harness-home-sandbox-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function directory(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function valuesAfter(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((value, index) => value === flag ? [argv[index + 1] as string] : []);
}

describe("operator harness stores captured before HOME redirection", () => {
  test("blocks every default brand store and shared instruction store", () => {
    const home = directory("defaults");
    const paths = harnessHomeBlockedPaths({ HOME: home });
    for (const name of [
      ".claude", ".claude.json", ".codex", ".kimi-code", ".kimi", ".gemini",
      ".factory", ".cursor", ".cursor-agent", ".copilot", ".pi", ".agents",
      ".aider", ".aider.conf.yml", ".aider.model.settings.yml", ".aider.model.metadata.json",
      ".qwen", ".openhands", ".cline", ".goose", ".opencode", ".zai",
    ]) expect(paths).toContain(join(home, name));
    for (const base of [".config", ".local/share", ".local/state", ".cache"]) {
      for (const store of ["goose", "opencode", "cline", "github-copilot"]) {
        expect(paths).toContain(join(home, base, store));
      }
    }
    expect(paths).not.toContain(home);
    expect(paths).toEqual([...new Set(paths)].sort());
  });

  test("retains default stores beside alternate directories and config files", () => {
    const home = directory("alternate-home");
    const env: Record<string, string> = { HOME: home };
    const names = [
      "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR",
      "COPILOT_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "GOOSE_PATH_ROOT",
      "GOOSE_CONFIG_DIR", "GOOSE_CONFIG_FILE", "GOOSE_DATA_DIR", "GOOSE_CACHE_DIR",
      "GOOSE_STATE_DIR", "CURSOR_CONFIG_DIR", "CLINE_DIR",
      "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
      "QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
    ];
    for (const name of names) env[name] = join(root, "alternate", name);
    const paths = harnessHomeBlockedPaths(env);
    for (const name of names) expect(paths).toContain(env[name] as string);
    expect(paths).toContain(join(home, ".claude"));
    expect(paths).toContain(join(home, ".codex"));
    expect(paths).toContain(join(home, ".agents"));
  });

  test("home-base redirects append the brand directory instead of blocking the whole home", () => {
    const home = directory("bases-home");
    const gemini = directory("bases-gemini");
    const factory = directory("bases-factory");
    const paths = harnessHomeBlockedPaths({ HOME: home, GEMINI_CLI_HOME: gemini, FACTORY_HOME_OVERRIDE: factory });
    expect(paths).toContain(join(gemini, ".gemini"));
    expect(paths).toContain(join(factory, ".factory"));
    expect(paths).not.toContain(gemini);
    expect(paths).not.toContain(factory);
  });

  test("captures each alternate XDG base without allowing it to replace the defaults", () => {
    const home = directory("xdg-home");
    const env: Record<string, string> = { HOME: home };
    for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"]) env[`XDG_${kind}_HOME`] = join(root, "xdg", kind);
    const paths = harnessHomeBlockedPaths(env);
    for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"]) {
      for (const store of ["goose", "opencode", "cline", "github-copilot"]) {
        expect(paths).toContain(join(env[`XDG_${kind}_HOME`] as string, store));
      }
    }
    expect(paths).toContain(join(home, ".config", "opencode"));
  });

  test("captures explicit, environment, and USERPROFILE homes together", () => {
    const actual = directory("actual-home");
    const home = directory("env-home");
    const profile = directory("profile-home");
    const paths = harnessHomeBlockedPaths({ HOME: home, USERPROFILE: profile }, actual);
    for (const base of [actual, home, profile]) expect(paths).toContain(join(base, ".claude"));
  });

  test("empty optional variables are absent and path whitespace is preserved", () => {
    const home = directory("empty-home");
    const paths = harnessHomeBlockedPaths({
      HOME: home, USERPROFILE: "", CODEX_HOME: "", XDG_CONFIG_HOME: "",
      FACTORY_HOME_OVERRIDE: "", QWEN_HOME: "", CLAUDE_CONFIG_DIR: join(root, "padded "),
    });
    expect(paths).toContain(join(root, "padded "));
    expect(paths).not.toContain(join(root, "padded"));
  });

  test("relative QWEN_HOME resolves from the launch cwd", () => {
    const home = directory("qwen-home");
    const cwd = directory("qwen-cwd");
    expect(harnessHomeBlockedPaths({ HOME: home, QWEN_HOME: "relative-store" }, home, cwd))
      .toContain(join(cwd, "relative-store"));
    expect(harnessHomeBlockedPaths({ HOME: home, QWEN_HOME: join(root, "absolute-qwen") }, home, cwd))
      .toContain(join(root, "absolute-qwen"));
    expect(() => harnessHomeBlockedPaths({ HOME: home, QWEN_HOME: "bad\0value" }, home, cwd))
      .toThrow("QWEN_HOME must not contain NUL bytes");
  });

  test.each(["HOME", "USERPROFILE", "CODEX_HOME", "XDG_DATA_HOME", "GEMINI_CLI_HOME"])(
    "refuses an ambiguous relative %s instead of omitting its store",
    (name) => {
      expect(() => harnessHomeBlockedPaths({ HOME: directory("invalid-home"), [name]: "relative" }))
        .toThrow(UsageRefusalError);
    }
  );

  test("canonicalizes existing and dangling aliases, missing descendants, and duplicate stores", () => {
    const home = directory("symlink-home");
    const target = directory("operator-claude");
    symlinkSync(target, join(home, ".claude"));
    symlinkSync(join(root, "future-codex"), join(home, ".codex"));
    const alias = join(root, "operator-alias");
    symlinkSync(target, alias);
    const paths = harnessHomeBlockedPaths({ HOME: home, CLAUDE_CONFIG_DIR: `${alias}/`, CODEX_HOME: join(alias, "missing") });
    expect(paths.filter((path) => path === target)).toHaveLength(1);
    expect(paths).toContain(join(root, "future-codex"));
    expect(paths).toContain(join(target, "missing"));
    expect(paths).not.toContain(join(home, ".claude"));
  });

  test("refuses a cyclic operator alias", () => {
    const home = directory("cyclic-home");
    symlinkSync(".claude", join(home, ".claude"));
    expect(() => harnessHomeBlockedPaths({ HOME: home })).toThrow(UsageRefusalError);
  });

  test("a captured snapshot stays tied to operator stores after HOME changes", () => {
    const home = directory("snapshot-operator");
    const privateHome = directory("snapshot-private");
    const env = { HOME: home, CODEX_HOME: join(home, "custom-codex") };
    const paths = harnessHomeBlockedPaths(env);
    env.HOME = privateHome;
    env.CODEX_HOME = join(privateHome, ".codex");
    const options: SandboxOptions = {};
    applyHarnessHomeSandboxBlocks(options, privateHome, paths);
    expect(options.blockPaths).toContain(join(home, ".codex"));
    expect(options.blockPaths).toContain(join(home, "custom-codex"));
    expect(options.blockPaths).not.toContain(join(privateHome, ".codex"));
    expect(options.harnessStateDirs).toEqual([privateHome]);
  });
});

describe("caller-managed harness home sandbox policy", () => {
  test("preserves policy, canonicalizes paths, deduplicates, and allows a private home under read-only autonomy", () => {
    const privateHome = directory("allowed-private");
    const alias = join(root, "allowed-alias");
    symlinkSync(privateHome, alias);
    const operator = directory("allowed-operator");
    const blocked = join(operator, ".claude");
    const callerBlock = join(root, "caller-block");
    const options: SandboxOptions = {
      trust: "untrusted", fsMode: "ro", noNet: true, scrubEnv: true,
      blockPaths: [callerBlock], harnessStateDirs: [alias],
    };
    applyHarnessHomeSandboxBlocks(options, privateHome, [blocked, blocked]);
    expect(options).toEqual({
      trust: "untrusted", fsMode: "ro", noNet: true, scrubEnv: true,
      blockPaths: [callerBlock, blocked], harnessStateDirs: [privateHome],
    });
    const argv = buildScodeCommand(["synthetic-harness"], root, "read-only", options);
    expect(argv).toContain("--ro");
    expect(valuesAfter(argv, "--block")).toEqual([callerBlock, blocked]);
    expect(valuesAfter(argv, "--allow")).toEqual([privateHome]);
  });

  test.each(["equal", "inside", "ancestor"])("refuses a private home %s to an operator store", (relation) => {
    const store = directory(`overlap-${relation}/store`);
    const privateHome = relation === "equal" ? store : relation === "inside" ? join(store, "private") : join(store, "..");
    const options: SandboxOptions = { trust: "standard" };
    expect(() => applyHarnessHomeSandboxBlocks(options, privateHome, [store])).toThrow("overlaps the operator's harness store");
    expect(options).toEqual({ trust: "standard" });
  });

  test("checks all existing allows and accepts sibling names without false prefix matches", () => {
    const store = directory("existing-store");
    const privateHome = directory("existing-private");
    expect(() => applyHarnessHomeSandboxBlocks({ harnessStateDirs: [join(store, "session")] }, privateHome, [store]))
      .toThrow("overlaps the operator's harness store");
    const options: SandboxOptions = {};
    applyHarnessHomeSandboxBlocks(options, `${store}-private`, [store]);
    expect(options.harnessStateDirs).toEqual([`${store}-private`]);
  });

  test("refuses overlaps through existing and dangling symlink aliases", () => {
    const store = directory("alias-store");
    const alias = join(root, "alias-store-link");
    symlinkSync(store, alias);
    expect(() => applyHarnessHomeSandboxBlocks({}, join(alias, "private"), [store])).toThrow("overlaps");
    const dangling = join(root, "dangling-private");
    symlinkSync(join(store, "future"), dangling);
    expect(() => applyHarnessHomeSandboxBlocks({}, dangling, [store])).toThrow("overlaps");
    expect(() => applyHarnessHomeSandboxBlocks({}, store, [alias])).toThrow("overlaps");
  });

  test.each(["equal", "inside", "ancestor", "root"])("refuses caller blocks %s to the private directory without changing options", (relation) => {
    const privateHome = directory(`caller-${relation}/private`);
    const block = relation === "equal" ? privateHome : relation === "inside" ? join(privateHome, "credentials.json")
      : relation === "root" ? "/" : join(privateHome, "..");
    const options: SandboxOptions = { blockPaths: [block] };
    expect(() => applyHarnessHomeSandboxBlocks(options, privateHome, [join(root, "caller-operator")]))
      .toThrow("--sandbox-block");
    expect(options).toEqual({ blockPaths: [block] });
  });

  test("refuses caller blocks through aliases and against pre-existing allows", () => {
    const privateHome = directory("caller-alias-private");
    const other = directory("caller-other-state");
    const alias = join(root, "caller-alias");
    symlinkSync(privateHome, alias);
    expect(() => applyHarnessHomeSandboxBlocks({ blockPaths: [alias] }, privateHome, [join(root, "operator")]))
      .toThrow("--sandbox-block");
    expect(() => applyHarnessHomeSandboxBlocks({ blockPaths: [other], harnessStateDirs: [other] }, privateHome, [join(root, "operator")]))
      .toThrow("--sandbox-block");
  });

  test("refuses an empty operator snapshot, invalid paths, and root allows or blocks", () => {
    const privateHome = directory("invalid-private");
    const store = join(root, "invalid-operator");
    expect(() => applyHarnessHomeSandboxBlocks({}, privateHome, [])).toThrow("requires the operator's harness stores");
    expect(() => applyHarnessHomeSandboxBlocks({}, "relative", [store])).toThrow("absolute path");
    expect(() => applyHarnessHomeSandboxBlocks({}, privateHome, ["bad\0path"])).toThrow("without NUL bytes");
    expect(() => applyHarnessHomeSandboxBlocks({ blockPaths: ["relative"] }, privateHome, [store])).toThrow("absolute path");
    expect(() => applyHarnessHomeSandboxBlocks({ harnessStateDirs: ["/"] }, privateHome, [store])).toThrow("overlaps");
    expect(() => applyHarnessHomeSandboxBlocks({}, privateHome, ["/"])).toThrow("overlaps");
  });

  test("print and spawn resolution carry identical blocks and allows without launching a process", async () => {
    const operatorHome = directory("resolver-operator");
    const privateHome = directory("resolver-private");
    const sandboxOptions: SandboxOptions = { fsMode: "ro" };
    const paths = harnessHomeBlockedPaths({ HOME: operatorHome });
    applyHarnessHomeSandboxBlocks(sandboxOptions, privateHome, paths);
    const spies = [
      spyOn(runtime, "assertNoProjectScodePolicy").mockImplementation(() => {}),
      spyOn(runtime, "resolveScodeExecutableForEnv").mockReturnValue("/synthetic/scode"),
      spyOn(runtime, "assertCompatibleScode").mockResolvedValue(undefined),
      spyOn(runtime, "resolveKeepEnvSandboxOptions").mockResolvedValue(sandboxOptions),
      spyOn(executables, "executableCheck").mockReturnValue(null),
      spyOn(executables, "resolveTrustedCommand").mockImplementation((command) => [...command]),
      spyOn(executables, "trustCheckedCommandPaths").mockReturnValue([]),
      spyOn(executables, "trustCheckedCommandChecks").mockReturnValue([]),
    ];
    try {
      const command = ["synthetic-harness"];
      const result = await resolveSessionSandboxSpawn(command, { HOME: operatorHome, PATH: "" }, {
        sandboxed: true, autonomy: "read-only", sandboxOptions,
      }, root);
      expect(result.scodeCmd).toEqual(buildScodeCommand(command, root, "read-only", sandboxOptions, "/synthetic/scode"));
      expect(valuesAfter(result.scodeCmd, "--block")).toEqual(paths);
      expect(valuesAfter(result.scodeCmd, "--allow")).toEqual([privateHome]);
      expect(result.sandboxEnv.HOME).toBe(operatorHome);
      expect(result.scodeCmd).toContain("--ro");
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  });
});
