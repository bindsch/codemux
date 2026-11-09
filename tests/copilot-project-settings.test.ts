import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { applyCopilotProjectSandbox, validateCopilotProjectSettings, validateCopilotProjectSettingsRun } from "../src/copilot-project-settings.js";
import type { SandboxOptions } from "../src/sandbox.js";

const copilotProjectRequest = { agent: "copilot" as const, prompt: "fixture", hermetic: true,
  sandboxed: true, autonomy: "low" as const, experimentProjectSettings: true };

test("Copilot project settings require explicit isolation and observable permission rules", () => {
  const base = { agent: "copilot", cwd: tmpdir(), hermetic: true, sandbox: true, autonomy: "low" };
  expect(() => validateCopilotProjectSettings(base)).not.toThrow();
  expect(() => validateCopilotProjectSettings({ ...base, autonomy: "high", session: true })).not.toThrow();
  for (const [change, message] of [
    [{ hermetic: false }, "--hermetic"], [{ sandbox: false }, "scode sandbox"],
    [{ autonomy: "medium" }, "low or high"], [{ tools: "none" }, "--tools none"],
    [{ experimentMcp: "file" }, "--experiment-mcp"],
  ] as const) expect(() => validateCopilotProjectSettings({ ...base, ...change })).toThrow(message);
  for (const name of ["COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "CLAUDE_CONFIG_DIR"]) {
    expect(() => validateCopilotProjectSettings({ ...base, passthroughEnv: [name] })).toThrow(name);
  }
  expect(() => validateCopilotProjectSettingsRun({ ...copilotProjectRequest, cwd: tmpdir(), autonomy: undefined }))
    .toThrow("low or high");
});

test("Copilot allows fixture settings and refuses ancestor files, containers, and dangling links", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-project-"));
  try {
    const cwd = join(root, "fixture");
    mkdirSync(join(cwd, ".github", "copilot"), { recursive: true });
    writeFileSync(join(cwd, ".github", "copilot", "settings.json"), "{}");
    expect(() => validateCopilotProjectSettingsRun({ ...copilotProjectRequest, cwd })).not.toThrow();
    writeFileSync(join(root, "GEMINI.md"), "operator memory");
    expect(() => validateCopilotProjectSettingsRun({ ...copilotProjectRequest, cwd })).toThrow("ancestor project");
    rmSync(join(root, "GEMINI.md"));
    symlinkSync(join(root, "missing"), join(root, ".github"));
    expect(() => validateCopilotProjectSettingsRun({ ...copilotProjectRequest, cwd })).toThrow("ancestor project");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Copilot project preparation blocks operator state and opens only owned artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-project-"));
  const adapter = new CopilotAdapter({ HOME: root,
    CODEMUX_COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:1234", CODEMUX_COPILOT_PROVIDER_MODEL: "model",
    CODEMUX_COPILOT_PROVIDER_MAX_CONTEXT_TOKENS: "1000" });
  const request = { ...copilotProjectRequest, cwd: root, resultJson: true };
  try {
    expect(() => adapter.prepareRun(request)).toThrow("prepared sandbox options");
    const options: SandboxOptions = { blockPaths: ["/caller-block"], harnessStateDirs: ["/caller-state"] };
    const context = adapter.prepareRun(request, "standard", options);
    expect(options.blockPaths).toEqual(["/caller-block", join(root, ".copilot"), join(root, ".claude"), join(root, ".claude.json")]);
    expect(options.harnessStateDirs).toEqual(["/caller-state", context.copilotHermeticHome!.home,
      dirname(context.copilotUsageFile!.path), dirname(context.copilotProviderFile!.path)]);
    expect(adapter.buildRunCommand(request, context)).not.toContain("--no-custom-instructions");
    expect(adapter.buildRunCommand({ ...request, experimentProjectSettings: false }, context))
      .toContain("--no-custom-instructions");
    adapter.cleanupRunSync(context);
    expect(existsSync(context.copilotHermeticHome!.home)).toBe(false);
    const empty: SandboxOptions = {};
    applyCopilotProjectSandbox(empty, "/operator/.copilot", "/private");
    expect(empty.harnessStateDirs).toEqual(["/private"]);
    // The shared agent gate accepts copilot: the dispatch reaches the
    // copilot validator and passes the same fixture cwd.
    expect(() => adapter.validateRunRequest(request)).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
