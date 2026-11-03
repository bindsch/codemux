import { describe, test, expect } from "bun:test";
import {
  GEMINI_SYSTEM_SETTINGS_PATH,
  GeminiAdapter,
} from "../src/adapters/gemini.js";
import type { RunRequest } from "../src/types.js";

describe("GeminiAdapter", () => {
  const adapter = new GeminiAdapter();

  test("has correct id and binary name", () => {
    expect(adapter.id).toBe("gemini");
    expect(adapter.binaryName).toBe("gemini");
  });

  test("disables repository .env loading with authoritative settings", () => {
    expect(adapter.getEnv()).toEqual({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH,
    });
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
    // Refused on live evidence (0.60.0, exercised live 2026-09-17):
    // nothing closes the workspace context channels for --hermetic, and
    // the tools.core allowlist rides a system-settings layer that never
    // loads from a user-owned prefix (docs/isolation.md).
    expect(caps.supportsHermetic ?? false).toBe(false);
    expect(caps.supportsToolSelection ?? false).toBe(false);
  });

  test("buildRunCommand with model", () => {
    const request: RunRequest = { agent: "gemini", prompt: "test", model: "gemini-pro" };
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toEqual(["gemini", "--sandbox=false", "-m", "gemini-pro", "-p", "test"]);
  });

  test("buildRunCommand with autonomy levels", () => {
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "read-only" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "plan", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "low" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "default", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "medium" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo", "-p", "t"]);
    expect(adapter.buildRunCommand({ agent: "gemini", prompt: "t", autonomy: "high" }))
      .toEqual(["gemini", "--sandbox=false", "--approval-mode", "yolo", "-p", "t"]);
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
