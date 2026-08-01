import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoAiderProjectExecutionConfig,
  assertNoClineProjectExecutionConfig,
  assertNoCodexProjectExecutionConfig,
  assertNoCursorProjectExecutionConfig,
  assertNoDroidProjectExecutionConfig,
  assertNoGeminiProjectExecutionConfig,
  assertNoGooseProjectExecutionConfig,
  assertNoOpenCodeProjectExecutionConfig,
  assertNoCopilotProjectExecutionConfig,
} from "../src/project-safety.js";

describe("project execution configuration", () => {
  const cases = [
    [assertNoAiderProjectExecutionConfig, ".aider.model.settings.yml"],
    [assertNoAiderProjectExecutionConfig, ".aider.model.metadata.json"],
    [assertNoCopilotProjectExecutionConfig, join(".github", "hooks", "pre.sh")],
    [assertNoClineProjectExecutionConfig, join(".cline", "hooks", "pre.sh")],
    [assertNoClineProjectExecutionConfig, join(".clinerules", "hooks", "pre.sh")],
    [assertNoCodexProjectExecutionConfig, join(".codex", "config.toml")],
    [assertNoCodexProjectExecutionConfig, join(".codex", "rules", "default.rules")],
    [assertNoCursorProjectExecutionConfig, join(".cursor", "hooks.json")],
    [assertNoCursorProjectExecutionConfig, join(".cursor", "agents", "unsafe.md")],
    [assertNoDroidProjectExecutionConfig, join(".factory", "settings.json")],
    [assertNoDroidProjectExecutionConfig, join(".factory", "settings.local.json")],
    [assertNoDroidProjectExecutionConfig, join(".factory", "hooks.json")],
    [assertNoDroidProjectExecutionConfig, join(".factory", "droids", "unsafe.md")],
    [assertNoGeminiProjectExecutionConfig, join(".gemini", "settings.json")],
    [assertNoGeminiProjectExecutionConfig, join(".gemini", ".env")],
    [assertNoGeminiProjectExecutionConfig, join(".gemini", "sandbox.Dockerfile")],
    [assertNoGooseProjectExecutionConfig, join(".goose", "config.yaml")],
    [assertNoOpenCodeProjectExecutionConfig, join(".opencode", "tool", "unsafe.ts")],
    [assertNoOpenCodeProjectExecutionConfig, join(".opencode", "mode", "plan.md")],
  ] as const;

  for (const [assertSafe, relativePath] of cases) {
    test(`rejects ${relativePath} inherited from the repository root`, () => {
      const repo = mkdtempSync(join(tmpdir(), "codemux-project-safety-"));
      const nested = join(repo, "nested");
      mkdirSync(join(repo, ".git"));
      mkdirSync(nested);
      const unsafePath = join(repo, relativePath);
      mkdirSync(dirname(unsafePath), { recursive: true });
      writeFileSync(unsafePath, "{}");
      try {
        expect(() => assertSafe(nested))
          .toThrow("refuses repository executable configuration");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  test("does not mistake user configuration for a non-Git project", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "codemux-project-home-"));
    const workdir = join(fakeHome, "Downloads", "work");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(fakeHome, ".codex"));
    writeFileSync(join(fakeHome, ".codex", "config.toml"), "model = 'trusted'");
    try {
      const moduleUrl = pathToFileURL(
        join(import.meta.dir, "..", "src", "project-safety.ts")
      ).href;
      const script = [
        `import { assertNoCodexProjectExecutionConfig } from ${JSON.stringify(moduleUrl)};`,
        `assertNoCodexProjectExecutionConfig(${JSON.stringify(workdir)});`,
      ].join("\n");
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: fakeHome },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(
        result.exitCode,
        new TextDecoder().decode(result.stderr)
      ).toBe(0);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
