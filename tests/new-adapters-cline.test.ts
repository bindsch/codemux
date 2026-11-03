import { describe, expect, test } from "bun:test";
import { ClineAdapter } from "../src/adapters/cline.js";

describe("ClineAdapter", () => {
  const adapter = new ClineAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("cline");
    expect(adapter.binaryName).toBe("cline");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high", "xhigh"],
      // Both refusals verified live at 3.0.62; see docs/isolation.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    });
  });

  test("builds a one-task headless command", () => {
    expect(adapter.buildRunCommand({
      agent: "cline",
      prompt: "fix the tests",
      model: "claude-sonnet-4",
      autonomy: "medium",
      effort: "high",
    })).toEqual([
      "cline",
      "--model",
      "claude-sonnet-4",
      "--auto-approve",
      "true",
      "--thinking",
      "high",
      "--",
      "fix the tests",
    ]);
  });

  test("uses explicit TUI and plan modes", () => {
    expect(adapter.buildTuiCommand(undefined, "read-only", "none"))
      .toEqual(["cline", "--tui", "--plan", "--thinking", "none"]);
  });

  test("maps approval levels", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--plan"]);
    expect(adapter.mapAutonomy("low")).toEqual(["--auto-approve", "false"]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto-approve", "true"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--auto-approve", "true"]);
  });
});
