import { afterEach, describe, test, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GEMINI_SYSTEM_SETTINGS_PATH,
  GeminiAdapter,
  geminiSettingsHost,
  geminiSystemSettingsLoadable,
} from "../src/adapters/gemini.js";
import { GEMINI_NO_TOOLS_SETTINGS } from "../src/gemini-hermetic.js";
import { readFileSync } from "node:fs";
import type { RunRequest } from "../src/types.js";

/** Pretend every path on the settings file's chain is owned by `uid`. */
function ownChain(uid: number): void {
  spyOn(geminiSettingsHost, "platform").mockReturnValue("darwin");
  spyOn(geminiSettingsHost, "statSync").mockImplementation(
    (() => ({ uid })) as unknown as typeof geminiSettingsHost.statSync
  );
}

describe("GeminiAdapter", () => {
  const adapter = new GeminiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("gemini");
    expect(adapter.binaryName).toBe("gemini");
  });

  afterEach(() => {
    spyOn(geminiSettingsHost, "platform").mockRestore();
    spyOn(geminiSettingsHost, "statSync").mockRestore();
  });

  test("names the system settings file only where the Gemini CLI will load it (root-owned chain)", () => {
    ownChain(0);
    expect(geminiSystemSettingsLoadable()).toBe(true);
    expect(adapter.getEnv()).toEqual({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH,
    });
  });

  test("omits the settings variable on a user-owned prefix, where the CLI skips the file (live matrix 2026-11-07)", () => {
    ownChain(501);
    expect(geminiSystemSettingsLoadable()).toBe(false);
    expect(adapter.getEnv()).toEqual({});
  });

  test("an unreadable settings path is not loadable", () => {
    spyOn(geminiSettingsHost, "platform").mockReturnValue("darwin");
    spyOn(geminiSettingsHost, "statSync").mockImplementation((() => {
      throw new Error("ENOENT");
    }) as unknown as typeof geminiSettingsHost.statSync);
    expect(geminiSystemSettingsLoadable()).toBe(false);
  });

  test("refuses a repository .env when the settings layer cannot load, and accepts it when it can", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-gemini-env-"));
    try {
      writeFileSync(join(cwd, ".env"), "GEMINI_API_KEY=planted\n");
      const request: RunRequest = { agent: "gemini", prompt: "test", cwd };
      ownChain(501);
      expect(() => adapter.validateRunRequest(request)).toThrow(/refuses a repository \.env/);
      expect(() => adapter.validateTuiRequest(undefined, cwd, "high")).toThrow(/refuses a repository \.env/);
      spyOn(geminiSettingsHost, "statSync").mockRestore();
      ownChain(0);
      expect(() => adapter.validateRunRequest(request)).not.toThrow();
      expect(() => adapter.validateTuiRequest(undefined, cwd, "high")).not.toThrow();
      // Without a .env the user-owned prefix runs as before.
      rmSync(join(cwd, ".env"));
      spyOn(geminiSettingsHost, "statSync").mockRestore();
      ownChain(501);
      expect(() => adapter.validateRunRequest(request)).not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
    // Hermetic since the parity round: a private GEMINI_CLI_HOME closes
    // the home channels, the clean-cwd rule the workspace ones, and
    // `--tools none` rides the same private home's settings.json
    // (docs/isolation.md).
    expect(caps.supportsHermetic ?? false).toBe(true);
    expect(caps.supportsToolSelection ?? false).toBe(true);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "gemini", prompt: "test", model: "gemini-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro", "--output-format", "stream-json", "-p", ""]);
    expect(adapter.getStdinInput(request)).toBe("test");
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "read-only" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "plan", "--output-format", "stream-json", "-p", ""]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "low" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "default", "--output-format", "stream-json", "-p", ""]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "medium" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo", "--output-format", "stream-json", "-p", ""]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "high" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo", "--output-format", "stream-json", "-p", ""]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gemini-pro")).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "medium")).toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo"]);
  });

  test("mapAutonomy returns approval mode flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--approval-mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--approval-mode", "default"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--approval-mode", "yolo"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--approval-mode", "yolo"]);
  });

  test("requires an outer boundary for headless plan mode", () => {
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("low")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("medium")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
    // The TUI follows the same policy as headless: no level below `high` runs
    // without the boundary.
    expect(adapter.requiresSandboxForTuiAutonomy("read-only")).toBe(true);
  });
});

describe("GeminiAdapter run parity", () => {
  // A controlled HOME keeps the private home inside the test tree.
  const makeAdapter = (home: string): GeminiAdapter => new GeminiAdapter({ HOME: home });

  test("a hermetic run routes the harness through the private home; a static preview uses the placeholder", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-parity-"));
    try {
      const adapter = makeAdapter(home);
      const context = adapter.prepareRun({ agent: "gemini", prompt: "t", hermetic: true });
      const cmd = adapter.buildRunCommand({ agent: "gemini", prompt: "t", hermetic: true }, context);
      expect(cmd[0]).toBe("env");
      expect(cmd[1]!.startsWith(`GEMINI_CLI_HOME=${join(home, ".gemini", ".codemux-hermetic", "run-")}`))
        .toBe(true);
      expect(cmd[2]).toBe("gemini");
      expect(cmd.slice(3)).toEqual(["--sandbox=false", "--output-format", "stream-json", "-p", ""]);
      adapter.cleanupRunSync(context);
      // The static preview (verify, no launch context) still names a path
      // inside the trusted parent: never the operator's real home.
      const preview = adapter.buildRunCommand({ agent: "gemini", prompt: "t", hermetic: true });
      expect(preview[1]).toBe(
        `GEMINI_CLI_HOME=${join(home, ".gemini", ".codemux-hermetic", "unprepared")}`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prepareRun writes the deny-all settings only for --tools none, and cleanup removes the home", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-parity-"));
    try {
      const adapter = makeAdapter(home);
      const noneContext = adapter.prepareRun({ agent: "gemini", prompt: "t", hermetic: true, tools: "none" });
      const settings = join(noneContext.geminiHermeticHome!.geminiDir, "settings.json");
      expect(readFileSync(settings, "utf-8")).toBe(GEMINI_NO_TOOLS_SETTINGS);
      adapter.cleanupRunSync(noneContext);
      expect(existsSync(noneContext.geminiHermeticHome!.home)).toBe(false);
      const hermeticOnly = adapter.prepareRun({ agent: "gemini", prompt: "t", hermetic: true });
      expect(existsSync(join(hermeticOnly.geminiHermeticHome!.home, "settings.json"))).toBe(false);
      adapter.cleanupRunSync(hermeticOnly);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("getRunEnv refuses to launch a hermetic run whose home was never prepared", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-parity-"));
    try {
      const adapter = makeAdapter(home);
      expect(() => adapter.getRunEnv({ agent: "gemini", prompt: "t", hermetic: true })).toThrow(
        /was not prepared/
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("validateRunRequest guards the isolation channels", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-parity-"));
    const work = mkdtempSync(join(tmpdir(), "gemini-work-"));
    const adapter = makeAdapter(home);
    try {
      expect(() => adapter.validateRunRequest({ agent: "gemini", prompt: "t", hermetic: true }))
        .toThrow(/requires an explicit --cwd/);
      expect(() =>
        adapter.validateRunRequest({
          agent: "gemini",
          prompt: "t",
          hermetic: true,
          cwd: work,
          passthroughEnv: ["GEMINI_CLI_HOME"],
        })
      ).toThrow(/owns GEMINI_CLI_HOME/);
      expect(() =>
        adapter.validateRunRequest({ agent: "gemini", prompt: "t", tools: "none", cwd: work })
      ).not.toThrow();
      writeFileSync(join(work, "GEMINI.md"), "operator text");
      expect(() =>
        adapter.validateRunRequest({ agent: "gemini", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/clean working directory/);
      rmSync(join(work, "GEMINI.md"));
      expect(() =>
        adapter.validateRunRequest({ agent: "gemini", prompt: "t", hermetic: true, cwd: work })
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a half-configured provider override is refused; a whole one rides env and -m", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-parity-"));
    try {
      const partial = new GeminiAdapter({
        HOME: home,
        CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://gw.example",
        CODEMUX_GEMINI_PROVIDER_API_KEY: "k",
      });
      expect(() => partial.validateRunRequest({ agent: "gemini", prompt: "t" })).toThrow(
        /needs a model for the provider override/
      );
      expect(() => partial.validateTuiRequest(undefined)).toThrow(/needs a model/);
      const whole = new GeminiAdapter({
        HOME: home,
        CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://gw.example",
        CODEMUX_GEMINI_PROVIDER_API_KEY: "k",
        CODEMUX_GEMINI_PROVIDER_MODEL: "gemini-2.5-pro",
      });
      const request: RunRequest = { agent: "gemini", prompt: "t" };
      expect(() => whole.validateRunRequest(request)).not.toThrow();
      expect(whole.getRunEnv(request)).toEqual({
        GOOGLE_GEMINI_BASE_URL: "https://gw.example",
        GEMINI_API_KEY: "k",
      });
      expect(whole.buildRunCommand(request)).toEqual([
        "gemini",
        "--sandbox=false",
        "-m",
        "gemini-2.5-pro",
        "--output-format",
        "stream-json",
        "-p",
        "",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--result-json reads the stream-json wire and rewrites the envelope", () => {
    const home = mkdtempSync(join(tmpdir(), "gemini-parity-"));
    try {
      const adapter = makeAdapter(home);
      const request: RunRequest = { agent: "gemini", prompt: "t", resultJson: true };
      expect(adapter.buildRunCommand(request)).toEqual([
        "env", `GEMINI_CLI_HOME=${join(home, ".gemini", ".codemux-hermetic", "unprepared")}`,
        "gemini",
        "--sandbox=false",
        "--output-format",
        "stream-json",
        "-p",
        "",
      ]);
      const envelope = JSON.stringify({ response: "done", stats: { input_tokens: 3, output_tokens: 1, cached: 0 } });
      const out = adapter.processRunResult(
        {
          stdout: envelope,
          stderr: "",
          exitCode: 0,
          success: true,
        },
        request
      );
      expect(out.success).toBe(true);
      expect(JSON.parse(out.stdout).codemux.usage.input_tokens).toBe(3);
      const plain: RunRequest = { agent: "gemini", prompt: "t" };
      const untouched = { stdout: "raw", exitCode: 0, success: true } as const;
      expect(adapter.processRunResult(
        { stdout: untouched.stdout, stderr: "", exitCode: 0, success: true },
        plain
      ).stdout).toBe("raw");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
