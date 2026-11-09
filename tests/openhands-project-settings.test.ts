import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenHandsAdapter } from "../src/adapters/openhands.js";
import { validateOpenhandsProjectSettings } from "../src/openhands-project-settings.js";
import {
  assertProjectSettingsAgent,
  validateProjectSettingsRequest,
} from "../src/claude-project-settings.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "codemux-openhands-projset-"));
}

// The openhands project-settings mode (run.experiment-project-settings):
// a hermetic run that loads the working directory's own .openhands —
// setup.py's HookConfig.load reads {working_dir}/.openhands/hooks.json at
// 1.16.0, read 2026-11-09 — instead of keeping the plain-run guard
// against it. The gates mirror the other arms: hermetic, scode, low
// autonomy, and no tool/MCP/env knob that would hide or steer the
// channel being observed.
describe("openhands project-settings gates", () => {
  const base = {
    agent: "openhands" as const,
    hermetic: true,
    autonomy: "low" as const,
    sandbox: true,
    cwd: "/repo",
  };

  test("the shared agent gate passes openhands", () => {
    expect(() => assertProjectSettingsAgent("openhands")).not.toThrow();
    expect(() => assertProjectSettingsAgent("aider")).toThrow(
      /no project setting source mapping/
    );
  });

  test("the validator requires hermetic, scode, and low autonomy", () => {
    expect(() => validateOpenhandsProjectSettings(base)).not.toThrow();
    expect(() => validateOpenhandsProjectSettings({ ...base, hermetic: false }))
      .toThrow("requires --hermetic");
    expect(() => validateOpenhandsProjectSettings({ ...base, sandbox: false }))
      .toThrow("requires the scode sandbox");
    expect(() => validateOpenhandsProjectSettings({ ...base, autonomy: "high" }))
      .toThrow("requires --auto low");
  });

  test("the validator refuses the conflicting flags", () => {
    expect(() => validateOpenhandsProjectSettings({ ...base, tools: "none" }))
      .toThrow("cannot be combined with --tools none");
    expect(() => validateOpenhandsProjectSettings({ ...base, experimentMcp: "spec.json" }))
      .toThrow("cannot be combined with --experiment-mcp");
    expect(() => validateOpenhandsProjectSettings({ ...base, passthroughEnv: ["HOME"] }))
      .toThrow("cannot be combined with --pass-env HOME");
  });

  test("the shared request validator dispatches to the openhands arm", () => {
    expect(() => validateProjectSettingsRequest(base)).not.toThrow();
    expect(() => validateProjectSettingsRequest({ ...base, autonomy: "medium" }))
      .toThrow("requires --auto low");
  });

  test("the mode loads the working directory's .openhands; a plain run still refuses it", () => {
    const dir = scratch();
    try {
      mkdirSync(join(dir, ".openhands"));
      writeFileSync(join(dir, ".openhands", "hooks.json"), "{}");
      const adapter = new OpenHandsAdapter({ HOME: "/h" });
      // The arm ran and passed — the project-execution guard did not fire —
      // so the first refusal left is the hermetic provider requirement,
      // which the test does not satisfy on purpose.
      expect(() => adapter.validateRunRequest({
        agent: "openhands", prompt: "p", cwd: dir,
        hermetic: true, sandboxed: true, autonomy: "low",
        experimentProjectSettings: true,
      })).toThrow("requires the provider override");
      // A plain run keeps the project-execution guard.
      expect(() => adapter.validateRunRequest({
        agent: "openhands", prompt: "p", cwd: dir, sandboxed: true,
      })).toThrow(/refuses repository executable configuration/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
