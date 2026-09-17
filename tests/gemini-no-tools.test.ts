import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GeminiAdapter,
  GEMINI_SYSTEM_SETTINGS_PATH,
} from "../src/adapters/gemini.js";
import { writeGeminiNoToolsSettings } from "../src/gemini-no-tools.js";

// Gemini's `--tools none` mapping is implemented but not claimed: the
// capability probe needs an installed gemini, and the release machine has
// none (docs/HERMETIC.md). `--hermetic` has no mechanism at all.

describe("tools none: gemini", () => {
  const scratch: string[] = [];
  const adapters: GeminiAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeNoToolsSettings();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const geminiAdapter = (
    env: NodeJS.ProcessEnv = {}
  ): { adapter: GeminiAdapter; home: string } => {
    const home = mkdtempSync(join(tmpdir(), "codemux-gemini-home-"));
    scratch.push(home);
    const adapter = new GeminiAdapter(env, home);
    adapters.push(adapter);
    return { adapter, home };
  };
  const noTools = { agent: "gemini" as const, prompt: "p", tools: "none" as const };

  test("gemini refuses --hermetic and --tools none until a probe runs", () => {
    const adapter = new GeminiAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-gemini-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ ...noTools, cwd }))
        .toThrow("cannot remove its built-in tools");
      expect(() => adapter.validateRunRequest({
        agent: "gemini",
        prompt: "p",
        cwd,
        hermetic: true,
      })).toThrow("no verified hermetic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("--tools none overrides the settings variable with a file pinning tools.core: []", () => {
    const { adapter, home } = geminiAdapter();
    adapter.prepareRun(noTools);
    const env = adapter.getRunEnv(noTools);
    const path = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    expect(path.startsWith(join(home, ".gemini", ".codemux") + "/")).toBe(true);
    expect(dirname(path).endsWith(".codemux")).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      advanced: { ignoreLocalEnv: true },
      tools: { core: [] },
    });
  });

  test("runs without --tools none keep the packaged settings variable and create nothing", () => {
    const { adapter, home } = geminiAdapter();
    adapter.prepareRun({ agent: "gemini", prompt: "p" });
    expect(adapter.getRunEnv({ agent: "gemini", prompt: "p" })).toEqual({});
    expect(adapter.getEnv()).toEqual({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH,
    });
    expect(existsSync(join(home, ".gemini", ".codemux"))).toBe(false);
  });

  test("each run gets a fresh file; dispose removes them all", () => {
    const { adapter } = geminiAdapter();
    adapter.prepareRun(noTools);
    const first = adapter.getRunEnv(noTools).GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    adapter.prepareRun(noTools);
    const second = adapter.getRunEnv(noTools).GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    adapter.disposeNoToolsSettings();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(() => adapter.getRunEnv(noTools))
      .toThrow("was not prepared before launch");
  });

  test("an unprepared --tools none run fails closed", () => {
    const { adapter } = geminiAdapter();
    expect(() => adapter.getRunEnv(noTools))
      .toThrow("was not prepared before launch");
  });

  test("packaged pins beyond the current one carry into the generated file", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-gemini-home-"));
    const packaged = join(home, "packaged.json");
    scratch.push(home);
    writeFileSync(
      packaged,
      JSON.stringify({ advanced: { ignoreLocalEnv: true, futurePin: 1 } })
    );
    const file = writeGeminiNoToolsSettings(join(home, ".gemini"), packaged);
    scratch.push(file.path);
    expect(JSON.parse(readFileSync(file.path, "utf-8"))).toEqual({
      advanced: { ignoreLocalEnv: true, futurePin: 1 },
      tools: { core: [] },
    });
    file.finalize();
  });

  test("a missing or malformed packaged settings file refuses the launch", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-gemini-home-"));
    scratch.push(home);
    const geminiDir = join(home, ".gemini");
    expect(() => writeGeminiNoToolsSettings(geminiDir, join(home, "absent.json")))
      .toThrow("cannot read codemux gemini settings");
    const malformed = join(home, "malformed.json");
    writeFileSync(malformed, "{nope");
    expect(() => writeGeminiNoToolsSettings(geminiDir, malformed))
      .toThrow("cannot read codemux gemini settings");
  });

  test("a passed-through GEMINI_CLI_HOME relocates the generated file", () => {
    const env: NodeJS.ProcessEnv = {};
    const passed = { ...noTools, passthroughEnv: ["GEMINI_CLI_HOME"] };
    const home = mkdtempSync(join(tmpdir(), "codemux-gemini-passed-"));
    scratch.push(home);
    const dropped = new GeminiAdapter(env, home);
    adapters.push(dropped);
    expect(() => dropped.prepareRun(passed)).not.toThrow();
    const droppedPath = dropped.getRunEnv(passed).GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    expect(droppedPath.startsWith(home)).toBe(true);

    env.GEMINI_CLI_HOME = join(home, "elsewhere");
    const honoring = new GeminiAdapter(env, home);
    adapters.push(honoring);
    honoring.prepareRun(passed);
    const honoredPath = honoring.getRunEnv(passed).GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
    expect(honoredPath.startsWith(join(home, "elsewhere", ".gemini"))).toBe(true);

    env.GEMINI_CLI_HOME = "relative/path";
    const relative = new GeminiAdapter(env, home);
    adapters.push(relative);
    expect(() => relative.prepareRun(passed))
      .toThrow("passed-through GEMINI_CLI_HOME must be an absolute path");
  });

  test("files from dead codemux processes are swept once stale", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-gemini-home-"));
    scratch.push(home);
    const parent = join(home, ".gemini", ".codemux");
    mkdirSync(parent, { recursive: true });
    const stale = join(parent, "no-tools-999999999-deadbeefcafe.json");
    writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(stale, old, old);
    const fresh = join(parent, `no-tools-999999999-${"a".repeat(12)}.json`);
    writeFileSync(fresh, "{}");
    writeGeminiNoToolsSettings(
      join(home, ".gemini"),
      GEMINI_SYSTEM_SETTINGS_PATH
    ).finalize();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("a symlinked .codemux parent is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-gemini-home-"));
    scratch.push(home);
    const target = mkdtempSync(join(tmpdir(), "codemux-gemini-target-"));
    scratch.push(target);
    const geminiDir = join(home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    symlinkSync(target, join(geminiDir, ".codemux"));
    expect(() => writeGeminiNoToolsSettings(geminiDir, GEMINI_SYSTEM_SETTINGS_PATH))
      .toThrow("must be a directory owned by the current user");
  });
});
