import { describe, expect, test } from "bun:test";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";

const adapter = new OpenHandsAdapter();

describe("OpenHandsAdapter", () => {
  test("never emits --llm-approve at any level", () => {
    // It confirms only what an LLM predicts is high-risk. That is a different
    // mechanism from graded human approval, not a weaker form of it, so Codemux
    // does not present it as one of its levels.
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      expect(adapter.mapAutonomy(level)).not.toContain("--llm-approve");
      expect(adapter.buildTuiCommand(undefined, level)).not.toContain("--llm-approve");
      expect(adapter.buildRunCommand({ agent: "openhands", prompt: "x", autonomy: level }))
        .not.toContain("--llm-approve");
    }
  });

  test("headless runs carry no approval flag, because --headless auto-approves", () => {
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      const cmd = adapter.buildRunCommand({
        agent: "openhands",
        prompt: "x",
        autonomy: level,
      });
      expect(cmd).toContain("--headless");
      expect(cmd).not.toContain("--always-approve");
    }
  });

  test("interactive sessions map only high onto --always-approve", () => {
    expect(adapter.buildTuiCommand(undefined, "high")).toContain("--always-approve");
    for (const level of ["read-only", "low", "medium"] as const) {
      // Default always-ask; the levels are separated by the scode policy.
      expect(adapter.buildTuiCommand(undefined, level)).toEqual(["openhands"]);
    }
  });

  test("model selection goes through the environment override", () => {
    const withModel = adapter.buildRunCommand({
      agent: "openhands",
      prompt: "x",
      model: "anthropic/claude-sonnet-5",
    });
    expect(withModel).toContain("--override-with-envs");
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "x", model: "m" })).toEqual({
      LLM_MODEL: "m",
    });
    // Without a model the environment stays ignored, which is the CLI default.
    const withoutModel = adapter.buildRunCommand({ agent: "openhands", prompt: "x" });
    expect(withoutModel).not.toContain("--override-with-envs");
    expect(adapter.getRunEnv({ agent: "openhands", prompt: "x" })).toEqual({});
  });

  test("passes the task as argv and advertises no effort control", () => {
    expect(adapter.getStdinInput({ agent: "openhands", prompt: "x" })).toBeNull();
    const cmd = adapter.buildRunCommand({ agent: "openhands", prompt: "hello" });
    expect(cmd.slice(-2)).toEqual(["--task", "hello"]);
    expect(adapter.capabilities().supportsEffort).toBe(false);
  });

  test("requires the scode boundary below high", () => {
    for (const level of ["read-only", "low", "medium"] as const) {
      expect(adapter.requiresSandboxForAutonomy(level)).toBe(true);
    }
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });
});
