import { describe, test, expect } from "bun:test";
import { DroidAdapter } from "../src/adapters/droid.js";
import type { RunRequest } from "../src/types.js";

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

  test("buildTuiCommand basic", () => {
    expect(adapter.buildTuiCommand()).toEqual(["droid"]);
  });

  test("buildTuiCommand with model", () => {
    expect(adapter.buildTuiCommand("gpt-5.1")).toEqual(["droid"]);
  });

  test("buildTuiCommand with autonomy", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toEqual(["droid", "--auto", "high"]);
    expect(adapter.buildTuiCommand("gpt-5.1", "low")).toEqual(["droid", "--auto", "low"]);
  });

  test("buildTuiCommand with effort", () => {
    expect(adapter.buildTuiCommand(undefined, undefined, "high")).toEqual(["droid"]);
    expect(adapter.buildTuiCommand("gpt-5.1", undefined, "medium")).toEqual(["droid"]);
  });

  test("TUI rejects unsupported model and effort flags", () => {
    expect(adapter.supportsTuiModel()).toBe(false);
    expect(adapter.supportsTuiEffort()).toBe(false);
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
