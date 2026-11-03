// Base-adapter request validation for the experiment-project-settings
// flag: it is a boolean like web, sandboxed, and hermetic, and the
// unmapped-agent refusal reads the validated value (review round 9,
// edges).
import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

describe("experimentProjectSettings request validation", () => {
  test("a non-boolean value is refused on an unmapped agent, not skipped", () => {
    const adapter = new CodexAdapter({});
    for (const value of ["yes", "true", 1, null, {}, []]) {
      expect(() =>
        adapter.validateRunRequest({
          agent: "codex",
          prompt: "p",
          experimentProjectSettings: value as unknown as boolean,
        })
      ).toThrow("experimentProjectSettings must be a boolean");
    }
  });

  test("a mapped agent hits the same type check", () => {
    const adapter = new ClaudeAdapter({});
    expect(() =>
      adapter.validateRunRequest({
        agent: "claude",
        prompt: "p",
        hermetic: true,
        experimentProjectSettings: "yes" as unknown as boolean,
      })
    ).toThrow("experimentProjectSettings must be a boolean");
  });

  test("boolean and omitted values pass the type check", () => {
    const adapter = new CodexAdapter({});
    for (const value of [false, undefined]) {
      expect(() =>
        adapter.validateRunRequest({
          agent: "codex",
          prompt: "p",
          experimentProjectSettings: value,
        })
      ).not.toThrow();
    }
  });
});
