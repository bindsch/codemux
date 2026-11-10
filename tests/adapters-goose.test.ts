import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GooseAdapter } from "../src/adapters/goose.js";
import type { RunRequest } from "../src/types.js";

describe("GooseAdapter", () => {
  const adapter = new GooseAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("goose");
    expect(adapter.binaryName).toBe("goose");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "low", "medium", "high", "max"]);
  });

  test("buildRunCommand", () => {
    const request: RunRequest = { agent: "goose", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    // The prompt rides stdin through the -i - carrier, never argv.
    expect(adapter.getStdinInput(request)).toBe("test prompt");
  });

  test("buildRunCommand with autonomy", () => {
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "read-only" }))
      .toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "low" }))
      .toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", autonomy: "high" }))
      .toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
  });

  test("buildTuiCommand", () => {
    expect(adapter.buildTuiCommand()).toEqual(["goose"]);
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["goose"]);
  });

  test("getRunEnv and getTuiEnv set goose mode from autonomy", () => {
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t" })).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", autonomy: "medium" }))
      .toEqual({ GOOSE_MODE: "smart_approve" });
    expect(adapter.getTuiEnv(undefined, undefined)).toEqual({ GOOSE_MODE: "chat" });
    expect(adapter.getTuiEnv(undefined, "high")).toEqual({ GOOSE_MODE: "auto" });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", model: "provider/model" }))
      .toEqual({ GOOSE_MODE: "chat", GOOSE_MODEL: "provider/model" });
  });

  test("mapAutonomy returns goose mode env", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual([]);
    expect(adapter.mapAutonomy("high")).toEqual([]);
  });
});

describe("GooseAdapter run parity", () => {
  const OVERRIDE = {
    HOME: "/tmp/goose-parity-home",
    CODEMUX_GOOSE_PROVIDER_BASE_URL: "https://gw.example/v1",
    CODEMUX_GOOSE_PROVIDER_API_KEY: "k",
    CODEMUX_GOOSE_PROVIDER_MODEL: "gpt-x",
  } as const;

  test("effort rides GOOSE_THINKING_EFFORT, with none as goose's off", () => {
    const adapter = new GooseAdapter();
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", effort: "none" })).toEqual({
      GOOSE_MODE: "chat",
      GOOSE_THINKING_EFFORT: "off",
    });
    expect(adapter.getRunEnv({ agent: "goose", prompt: "t", effort: "max" })).toEqual({
      GOOSE_MODE: "chat",
      GOOSE_THINKING_EFFORT: "max",
    });
  });

  test("tools none rides --no-profile and every run rides --output-format stream-json", () => {
    const adapter = new GooseAdapter();
    expect(adapter.buildRunCommand({ agent: "goose", prompt: "t", tools: "none" })).toEqual([
      "goose",
      "run",
      "--no-profile",
      "--output-format",
      "stream-json",
      "-i",
      "-",
    ]);
    const json = adapter.buildRunCommand({ agent: "goose", prompt: "t", resultJson: true });
    expect(json).toEqual(["goose", "run", "--output-format", "stream-json", "-i", "-"]);
    const out = adapter.processRunResult(
      {
        stdout: JSON.stringify({ session_id: "20250921_143022", content: "done", usage: {} }),
        stderr: "",
        exitCode: 0,
        success: true,
      },
      { agent: "goose", prompt: "t", resultJson: true }
    );
    expect(out.success).toBe(true);
    expect(JSON.parse(out.stdout).codemux.session_id).toBe("20250921_143022");
  });

  test("a hermetic run refuses to launch without the provider override", () => {
    const work = mkdtempSync(join(tmpdir(), "goose-parity-"));
    try {
      const adapter = new GooseAdapter();
      expect(() =>
        adapter.validateRunRequest({ agent: "goose", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/requires the provider override/);
      expect(() =>
        adapter.prepareRun({ agent: "goose", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/requires the provider override/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a hermetic run with the override redirects XDG into the private home", () => {
    const home = mkdtempSync(join(tmpdir(), "goose-parity-"));
    const work = mkdtempSync(join(tmpdir(), "goose-work-"));
    try {
      const adapter = new GooseAdapter({ ...OVERRIDE, HOME: home });
      const context = adapter.prepareRun({ agent: "goose", prompt: "t", hermetic: true, cwd: work });
      const cmd = adapter.buildRunCommand({ agent: "goose", prompt: "t", hermetic: true, cwd: work }, context);
      expect(cmd[0]).toBe("env");
      // GOOSE_PATH_ROOT first: it owns the .agents home that the XDG trio
      // leaves in the real HOME (paths.rs get_dir, 1.50.1).
      const root = `GOOSE_PATH_ROOT=${join(home, ".config", "goose", ".codemux-hermetic", "run-")}`;
      expect(cmd[1]!.startsWith(root)).toBe(true);
      // The XDG config root sits inside that private root.
      expect(cmd[2]!.startsWith(`XDG_CONFIG_HOME=${cmd[1]!.slice("GOOSE_PATH_ROOT=".length)}/`)).toBe(true);
      expect(cmd[2]!.startsWith(`XDG_CONFIG_HOME=${join(home, ".config", "goose", ".codemux-hermetic", "run-")}`))
        .toBe(true);
      expect(cmd[5]).toBe("goose");
      adapter.cleanupRunSync(context);
      const preview = adapter.buildRunCommand({ agent: "goose", prompt: "t", hermetic: true, cwd: work });
      expect(preview.slice(1, 5)).toEqual([
        "GOOSE_PATH_ROOT=<unprepared>",
        "XDG_CONFIG_HOME=<unprepared>",
        "XDG_DATA_HOME=<unprepared>",
        "XDG_CACHE_HOME=<unprepared>",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a hermetic run requires an explicit clean --cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "goose-parity-"));
    const work = mkdtempSync(join(tmpdir(), "goose-work-"));
    try {
      const adapter = new GooseAdapter({ ...OVERRIDE, HOME: home });
      expect(() =>
        adapter.validateRunRequest({ agent: "goose", prompt: "t", hermetic: true })
      ).toThrow(/requires an explicit --cwd/);
      // The model requirement surfaces before the hermetic walk.
      const { CODEMUX_GOOSE_PROVIDER_MODEL: _model, ...noModel } = OVERRIDE;
      const modelless = new GooseAdapter({ ...noModel, HOME: home });
      expect(() =>
        modelless.validateRunRequest({ agent: "goose", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/needs a model/);
      writeFileSync(join(work, ".goosehints"), "operator text");
      expect(() =>
        adapter.validateRunRequest({ agent: "goose", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/clean working directory/);
      rmSync(join(work, ".goosehints"));
      // AGENTS.md is goose's second default hint name (load_hints.rs,
      // 1.50.1): a project file would ride into the hermetic run.
      writeFileSync(join(work, "AGENTS.md"), "operator text");
      expect(() =>
        adapter.validateRunRequest({ agent: "goose", prompt: "t", hermetic: true, cwd: work })
      ).toThrow(/clean working directory/);
      rmSync(join(work, "AGENTS.md"));
      expect(() =>
        adapter.validateRunRequest({ agent: "goose", prompt: "t", hermetic: true, cwd: work })
      ).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a whole override rides env with goose's openai endpoint pair", () => {
    const adapter = new GooseAdapter(OVERRIDE);
    const request: RunRequest = { agent: "goose", prompt: "t" };
    expect(adapter.getRunEnv(request)).toEqual({
      GOOSE_MODE: "chat",
      GOOSE_PROVIDER: "openai",
      OPENAI_HOST: "https://gw.example",
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_API_KEY: "k",
      GOOSE_MODEL: "gpt-x",
    });
    const requestModel: RunRequest = { agent: "goose", prompt: "t", model: "gpt-y", effort: "low" };
    expect(adapter.getRunEnv(requestModel)).toEqual({
      GOOSE_MODE: "chat",
      GOOSE_THINKING_EFFORT: "low",
      GOOSE_PROVIDER: "openai",
      OPENAI_HOST: "https://gw.example",
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_API_KEY: "k",
      GOOSE_MODEL: "gpt-y",
    });
  });
});
