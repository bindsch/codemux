import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCodeTurnCommand } from "../src/session/opencode-command.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import { assertExecutablesUnchanged, type ExecutableCheck } from "../src/executable-security.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const home: SessionPrivateHome = { dir: "/fixture/private", settled: true, resumed: false,
  blockedPaths: [], settle() {}, remove: () => true };

test("plain turns and previews share model, effort, and native resume arguments", () => {
  expect(buildOpenCodeTurnCommand({ autonomy: "low", model: "native/model", effort: "none", resumeSessionId: "ses_example12345" }))
    .toEqual(["opencode", "--pure", "run", "--format", "json", "--model", "native/model",
      "--agent", "build", "--variant", "none", "--session", "ses_example12345"]);
});

test("tool removal applies on every resumed turn and refuses config overrides", () => {
  for (const resumeSessionId of [undefined, "ses_example12345"]) {
    const command = buildOpenCodeTurnCommand({ autonomy: "high", tools: "none", privateHome: home, resumeSessionId });
    expect(command).toContain('OPENCODE_PERMISSION={"*":"deny"}');
    expect(command).toContain('OPENCODE_CONFIG_CONTENT={"permission":"deny"}');
    expect(command).toContain("XDG_DATA_HOME=/fixture/private/.local/share");
  }
  expect(() => buildOpenCodeTurnCommand({ autonomy: "low", tools: "none" })).toThrow("requires --hermetic");
  expect(() => buildOpenCodeTurnCommand({ autonomy: "low", tools: "none", privateHome: home, projectSettings: true }))
    .toThrow("without --experiment-project-settings");
});

test("Playwright captures executable identity and refuses replacement before spawn", () => {
  // Executable checks record the canonical path (macOS tmpdir is a symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemux-opencode-mcp-")));
  roots.push(root);
  const bin = join(root, "bin"), cwd = join(root, "work");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(cwd);
  const binary = join(bin, "playwright-mcp");
  writeFileSync(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const executableChecks: ExecutableCheck[] = [];
  const command = buildOpenCodeTurnCommand({ autonomy: "low", playwrightMcp: true, sandboxed: true,
    pathEnv: bin, cwd, resumeSessionId: "ses_example12345", executableChecks });
  expect(executableChecks.map((check) => check.path)).toEqual([binary]);
  writeFileSync(binary, "#!/bin/sh\nexit 98\n", { mode: 0o700 });
  expect(() => assertExecutablesUnchanged(command, "session", [binary], executableChecks)).toThrow("changed");
  expect(() => buildOpenCodeTurnCommand({ autonomy: "low", playwrightMcp: true, pathEnv: bin, cwd }))
    .toThrow("requires --sandbox");
});

test("deny removes automatic permission grants and merges with the config carrier", () => {
  expect(() => buildOpenCodeTurnCommand({ autonomy: "high", permissionPolicy: "deny" }))
    .toThrow("requires --hermetic");
  const command = buildOpenCodeTurnCommand({ autonomy: "high", permissionPolicy: "deny", privateHome: home });
  expect(command).not.toContain("--auto");
  expect(command).toContain('OPENCODE_PERMISSION={"*":"deny"}');
});
