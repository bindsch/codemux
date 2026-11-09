import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DroidAdapter } from "../src/adapters/droid.js";
import { AUTONOMY_EQUIVALENCE } from "../src/autonomy.js";
import type { RunRequest } from "../src/types.js";

// The TUI settings file must never land in the real brand home, so every
// test that triggers a write constructs the adapter over a scratch home.
const tuiScratch: string[] = [];
afterAll(() => {
  for (const dir of tuiScratch) rmSync(dir, { recursive: true, force: true });
});

function tuiAdapter(): DroidAdapter {
  const home = mkdtempSync(join(tmpdir(), "codemux-droid-tui-"));
  tuiScratch.push(home);
  return new DroidAdapter({}, home);
}

function tuiSettings(cmd: readonly string[]): Record<string, unknown> {
  const flag = cmd.indexOf("--settings");
  expect(flag).toBeGreaterThanOrEqual(0);
  return JSON.parse(readFileSync(cmd[flag + 1]!, "utf8")) as Record<string, unknown>;
}

describe("DroidAdapter", () => {
  const adapter = new DroidAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("droid");
    expect(adapter.binaryName).toBe("droid");
  });

  test("capabilities are correct", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsNonInteractive).toBe(true);
    expect(caps.supportsInteractive).toBe(true);
    expect(caps.supportsModel).toBe(true);
    expect(caps.supportsAutonomy).toBe(true);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.effortLevels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("buildRunCommand with prompt only", () => {
    const request: RunRequest = { agent: "droid", prompt: "test prompt" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec"]);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "droid", prompt: "test", model: "gpt-5.1" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "read-only" }))
      .toEqual(["droid", "exec"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "low" }))
      .toEqual(["droid", "exec", "--auto", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "medium" }))
      .toEqual(["droid", "exec", "--auto", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", autonomy: "high" }))
      .toEqual(["droid", "exec", "--auto", "high"]);
    // The read-only argv is empty because the default state IS read-only
    // ("DEFAULT (no flags)  Read-only mode", droid 0.221.0), so the
    // equivalence cell must say so rather than naming a flag.
    expect(AUTONOMY_EQUIVALENCE.droid.byLevel["read-only"]).toContain("read-only");
  });

  test("buildRunCommand with effort levels", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "none" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "off"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "low" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "low"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "medium" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "medium"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", effort: "high" }))
      .toEqual(["droid", "exec", "--reasoning-effort", "high"]);
  });

  test("uses the model-specific no-reasoning value", () => {
    expect(adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "gpt-5.6-sol",
      effort: "none",
    })).toContain("none");
    expect(adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "claude-opus-5",
      effort: "none",
    })).toContain("off");
  });

  test("the bare gpt-5.6 id is the none-spelling family too (review round 361)", () => {
    // A suffixed check alone sent an unsuffixed family id to the generic
    // `off`, which that family rejects.
    const cmd = adapter.buildRunCommand({
      agent: "droid",
      prompt: "t",
      model: "gpt-5.6",
      effort: "none",
    });
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.6", "--reasoning-effort", "none"]);
  });

  test("buildRunCommand with all options", () => {
    const request: RunRequest = {
      agent: "droid",
      prompt: "test",
      model: "gpt-5.1",
      autonomy: "medium",
      effort: "high",
    };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["droid", "exec", "-m", "gpt-5.1", "--auto", "medium", "--reasoning-effort", "high"]);
  });

  test("getStdinInput returns prompt", () => {
    const request: RunRequest = { agent: "droid", prompt: "my prompt" };
    expect(adapter.getStdinInput(request)).toBe("my prompt");
  });

  test("--no-web removes exactly the two web tools", () => {
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", web: false }))
      .toEqual(["droid", "exec", "--remove-tools", "WebSearch,FetchUrl"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "t", web: true }))
      .toEqual(["droid", "exec"]);
  });

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["droid"]);
    // Autonomy alone carries no settings file: nothing to select.
    expect(tuiAdapter().buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
  });

  test("buildTuiCommand with model", () => {
    const cmd = tuiAdapter().buildTuiCommand("gpt-5.1");
    expect(cmd).toHaveLength(3);
    expect([cmd[0], cmd[1]]).toEqual(["droid", "--settings"]);
    expect(tuiSettings(cmd)).toEqual({ sessionDefaultSettings: { model: "gpt-5.1" } });
  });

  test("buildTuiCommand composes model, autonomy, and effort", () => {
    const cmd = tuiAdapter().buildTuiCommand("gpt-5.1", "low", "medium");
    expect(cmd.slice(0, 2)).toEqual(["droid", "--settings"]);
    expect(cmd.slice(3)).toEqual(["--auto", "low"]);
    expect(tuiSettings(cmd)).toEqual({ sessionDefaultSettings: { model: "gpt-5.1", reasoningEffort: "medium" } });
  });

  test("buildTuiCommand with effort, none on the settings spelling off", () => {
    const cmd = tuiAdapter().buildTuiCommand(undefined, undefined, "none");
    expect(cmd.slice(0, 2)).toEqual(["droid", "--settings"]);
    expect(tuiSettings(cmd)).toEqual({ sessionDefaultSettings: { reasoningEffort: "off" } });
    const high = tuiAdapter().buildTuiCommand(undefined, undefined, "high");
    expect(tuiSettings(high)).toEqual({ sessionDefaultSettings: { reasoningEffort: "high" } });
  });

  test("the TUI selects model and effort (the settings file carries them)", () => {
    expect(adapter.supportsTuiModel()).toBe(true);
    expect(adapter.supportsTuiEffort()).toBe(true);
  });

  test("mapAutonomy returns correct flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual([]);
    expect(adapter.mapAutonomy("low")).toEqual(["--auto", "low"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto", "medium"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--auto", "high"]);
  });

  test("mapEffort returns correct flags", () => {
    expect(adapter.mapEffort("none")).toEqual(["--reasoning-effort", "off"]);
    expect(adapter.mapEffort("low")).toEqual(["--reasoning-effort", "low"]);
    expect(adapter.mapEffort("medium")).toEqual(["--reasoning-effort", "medium"]);
    expect(adapter.mapEffort("high")).toEqual(["--reasoning-effort", "high"]);
  });
});
