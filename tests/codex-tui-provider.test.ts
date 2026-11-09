/**
 * The codex TUI provider override (declarations-tui.ts
 * tui.provider-override): prepareTuiEnvironment — which both TUI launch
 * paths (the sandboxed tui command and the plain interactive one) call and
 * finalize — creates the same private per-launch CODEX_HOME a plain
 * override run gets, the key rides the environment, and -m stays off.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { UsageRefusalError } from "../src/validation.js";

const OVERRIDE = {
  CODEMUX_CODEX_PROVIDER_BASE_URL: "https://codex.synthetic.invalid/v1",
  CODEMUX_CODEX_PROVIDER_API_KEY: "synthetic-tui-key",
  CODEMUX_CODEX_PROVIDER_MODEL: "synthetic-model",
};

function withHome(run: (home: string, adapter: CodexAdapter) => void): void {
  const parent = join(process.cwd(), "scratch", "fix", "codex-tui-provider");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "tui-"));
  const adapter = new CodexAdapter({ ...OVERRIDE, HOME: home }, home);
  try { run(home, adapter); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

describe("codex TUI provider lifecycle", () => {
  test("a private CODEX_HOME carries the override config and never the key", () => withHome((home, adapter) => {
    const prepared = adapter.prepareTuiEnvironment("synthetic-model", "read-only");
    const codexHome = prepared.env.CODEX_HOME!;
    try {
      expect(codexHome.startsWith(join(home, ".codex", ".codemux-provider"))).toBe(true);
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('[model_providers.codemux]');
      expect(config).toContain(OVERRIDE.CODEMUX_CODEX_PROVIDER_BASE_URL);
      expect(config).toContain('env_key = "CODEMUX_CODEX_PROVIDER_API_KEY"');
      expect(config).toContain('model = "synthetic-model"');
      // The key never lands on disk; the environment carries it.
      expect(config).not.toContain(OVERRIDE.CODEMUX_CODEX_PROVIDER_API_KEY);
      expect(prepared.env.CODEMUX_CODEX_PROVIDER_API_KEY).toBe(OVERRIDE.CODEMUX_CODEX_PROVIDER_API_KEY);
      // The operator's own home is untouched.
      expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
      prepared.finalize();
      prepared.finalize();
      expect(existsSync(codexHome)).toBe(false);
    } finally { prepared.finalize(); }
  }));

  test("two TUI preparations own independent homes", () => withHome((_home, adapter) => {
    const first = adapter.prepareTuiEnvironment("one", "read-only");
    const second = adapter.prepareTuiEnvironment("two", "read-only");
    try {
      expect(first.env.CODEX_HOME).not.toBe(second.env.CODEX_HOME);
      expect(readFileSync(join(first.env.CODEX_HOME!, "config.toml"), "utf8")).toContain('model = "one"');
      expect(readFileSync(join(second.env.CODEX_HOME!, "config.toml"), "utf8")).toContain('model = "two"');
    } finally { first.finalize(); second.finalize(); }
  }));

  test("the override model rides the config, never -m", () => withHome((_home, adapter) => {
    expect(adapter.buildTuiCommand("synthetic-model", "read-only"))
      .not.toContain("synthetic-model");
    const plain = new CodexAdapter({ HOME: _home }, _home);
    expect(plain.buildTuiCommand("gpt-5.5", "read-only")).toContain("gpt-5.5");
  }));

  test("a model-less override is refused at validation, before any home exists", () => withHome((home) => {
    const modelless = new CodexAdapter({
      CODEMUX_CODEX_PROVIDER_BASE_URL: OVERRIDE.CODEMUX_CODEX_PROVIDER_BASE_URL,
      CODEMUX_CODEX_PROVIDER_API_KEY: OVERRIDE.CODEMUX_CODEX_PROVIDER_API_KEY,
      HOME: home,
    }, home);
    expect(() => modelless.validateTuiRequest(undefined)).toThrow(UsageRefusalError);
    expect(() => modelless.validateTuiRequest(undefined))
      .toThrow("codex needs a model for the provider override");
    expect(existsSync(join(home, ".codex", ".codemux-provider"))).toBe(false);
    // With the model, validation passes.
    expect(() => adapter0(modelless).validateTuiRequest("synthetic-model")).not.toThrow();
    // The empty-override TUI environment still has nothing to prepare.
    const plain = new CodexAdapter({ HOME: home }, home);
    expect(plain.prepareTuiEnvironment("gpt-5.5", "read-only").env).toEqual({});
  }));
});

function adapter0(adapter: CodexAdapter): CodexAdapter { return adapter; }
