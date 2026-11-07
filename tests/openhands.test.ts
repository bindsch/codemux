import { describe, expect, test } from "bun:test";
import { OPENHANDS_NO_SETTINGS_MARKER, OpenHandsAdapter, openHandsRanNoTask } from "../src/adapters/openhands.js";

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

  test("a settings-missing exit 0 is a failed run, not a reply (live matrix 2026-11-07)", () => {
    const request = { agent: "openhands" as const, prompt: "Reply with OK" };
    const stdout = [
      "OpenHands CLI terminal UI may not work correctly in this environment",
      `\u001b[38;2;255;107;107m${OPENHANDS_NO_SETTINGS_MARKER}\u001b[0m`,
      "Please run: openhands to configure your settings before using --headless.",
      "Goodbye!",
      "",
    ].join("\n");
    const processed = adapter.processRunResult(
      { stdout, stderr: "", exitCode: 0, success: true },
      request
    );
    expect(processed.success).toBe(false);
    expect(processed.exitCode).toBe(1);
    expect(processed.stderr).toContain("headless mode requires existing settings");
    // A nonzero exit keeps its own code; a real reply passes untouched.
    expect(adapter.processRunResult({ stdout, stderr: "", exitCode: 2, success: false }, request).exitCode).toBe(2);
    const ok = { stdout: "OK\n", stderr: "", exitCode: 0, success: true };
    expect(adapter.processRunResult(ok, request)).toEqual(ok);
    // A reply that quotes the phrase, or carries the marker without the
    // instruction and farewell lines, is a reply (review round 334).
    for (const quoted of [
      `The CLI said "${OPENHANDS_NO_SETTINGS_MARKER}" once.\nGoodbye!\n`,
      `${OPENHANDS_NO_SETTINGS_MARKER}\nOK\n`,
      `${OPENHANDS_NO_SETTINGS_MARKER}\nPlease run: openhands to configure your settings before using --headless.\nOK\n`,
    ]) {
      expect(openHandsRanNoTask(quoted)).toBe(false);
      const reply = { stdout: quoted, stderr: "", exitCode: 0, success: true };
      expect(adapter.processRunResult(reply, request)).toEqual(reply);
    }
    expect(openHandsRanNoTask(stdout)).toBe(true);
  });

  test("requires the scode boundary below high", () => {
    for (const level of ["read-only", "low", "medium"] as const) {
      expect(adapter.requiresSandboxForAutonomy(level)).toBe(true);
    }
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });
});
