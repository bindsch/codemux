import { describe, expect, test } from "bun:test";
import { KimiAdapter } from "../src/adapters/kimi.js";

const adapter = new KimiAdapter();

describe("KimiAdapter", () => {
  test("advertises no effort control, because 0.31.1 has none", () => {
    const caps = adapter.capabilities();
    expect(caps.supportsEffort).toBe(false);
    expect(caps.effortLevels).toEqual([]);
    expect(caps.autonomyLevels).toEqual(["read-only", "low", "medium", "high"]);
  });

  test("headless runs carry no autonomy flag at any level", () => {
    // Verified against the installed binary: --prompt rejects --plan, --yolo,
    // and --auto with "Cannot combine --prompt with ...". Emitting one would
    // make every headless run fail.
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      const cmd = adapter.buildRunCommand({
        agent: "kimi",
        prompt: "hello",
        autonomy: level,
      });
      expect(cmd).not.toContain("--plan");
      expect(cmd).not.toContain("--yolo");
      expect(cmd).not.toContain("--auto");
      expect(cmd).toContain("--prompt");
    }
  });

  test("interactive sessions do map autonomy natively", () => {
    expect(adapter.buildTuiCommand(undefined, "read-only")).toContain("--plan");
    expect(adapter.buildTuiCommand(undefined, "medium")).toContain("--yolo");
    expect(adapter.buildTuiCommand(undefined, "high")).toContain("--auto");
    // `low` is the CLI default: it prompts before each tool call.
    expect(adapter.buildTuiCommand(undefined, "low")).toEqual(["kimi"]);
  });

  test("passes the prompt as argv, since 0.31.1 has no stdin transport", () => {
    expect(adapter.getStdinInput({ agent: "kimi", prompt: "hello" })).toBeNull();
    const cmd = adapter.buildRunCommand({ agent: "kimi", prompt: "hello" });
    expect(cmd.slice(-2)).toEqual(["--prompt", "hello"]);
  });

  test("forwards model selection", () => {
    const cmd = adapter.buildRunCommand({
      agent: "kimi",
      prompt: "hello",
      model: "k2",
    });
    expect(cmd).toContain("--model");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("k2");
  });

  test("requires the scode boundary below high, like every other harness", () => {
    for (const level of ["read-only", "low", "medium"] as const) {
      expect(adapter.requiresSandboxForAutonomy(level)).toBe(true);
      expect(adapter.requiresSandboxForTuiAutonomy(level)).toBe(true);
    }
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });
});
