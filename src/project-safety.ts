import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AIDER_EXECUTABLE_CONFIG_FILES = [
  ".aider.model.settings.yml",
  ".aider.model.metadata.json",
] as const;

const COPILOT_EXECUTABLE_CONFIG_FILES = [
  ".mcp.json",
  join(".github", "mcp.json"),
  join(".github", "copilot", "settings.json"),
  join(".github", "copilot", "settings.local.json"),
  join(".claude", "settings.json"),
  join(".claude", "settings.local.json"),
] as const;

const COPILOT_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".github", "hooks"),
  join(".github", "agents"),
  join(".claude", "agents"),
] as const;

const OPENCODE_EXECUTABLE_CONFIG_FILES = [
  "opencode.json",
  "opencode.jsonc",
  join(".opencode", "package.json"),
  join(".opencode", "opencode.json"),
  join(".opencode", "opencode.jsonc"),
] as const;

const OPENCODE_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".opencode", "agent"),
  join(".opencode", "agents"),
  join(".opencode", "mode"),
  join(".opencode", "modes"),
  join(".opencode", "plugin"),
  join(".opencode", "plugins"),
  join(".opencode", "tool"),
  join(".opencode", "tools"),
] as const;

const CURSOR_EXECUTABLE_CONFIG_FILES = [
  join(".cursor", "cli.json"),
  join(".cursor", "hooks.json"),
  join(".cursor", "mcp.json"),
] as const;
const CURSOR_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".claude", "agents"),
  join(".codex", "agents"),
  join(".cursor", "agents"),
  join(".cursor", "hooks"),
  join(".cursor", "plugins"),
] as const;

const CLINE_EXECUTABLE_CONFIG_FILES = [
  join(".cline", "mcp.json"),
  join(".cline", "settings.json"),
] as const;
const CLINE_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".cline", "hooks"),
  join(".cline", "plugins"),
  join(".clinerules", "hooks"),
] as const;

const CODEX_EXECUTABLE_CONFIG_FILES = [join(".codex", "config.toml")] as const;
const CODEX_EXECUTABLE_CONFIG_DIRECTORIES = [join(".codex", "rules")] as const;

const DROID_EXECUTABLE_CONFIG_FILES = [
  join(".factory", "hooks.json"),
  join(".factory", "mcp.json"),
  join(".factory", "settings.json"),
  join(".factory", "settings.local.json"),
] as const;
const DROID_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".factory", "droids"),
  join(".factory", "hooks"),
  join(".factory", "plugins"),
] as const;

const GEMINI_EXECUTABLE_CONFIG_FILES = [
  join(".gemini", ".env"),
  join(".gemini", "settings.json"),
] as const;
const GEMINI_EXECUTABLE_CONFIG_DIRECTORIES = [
  ".gemini",
  join(".gemini", "extensions"),
] as const;

const GOOSE_EXECUTABLE_CONFIG_FILES = [
  join(".goose", "config.yaml"),
  join(".goose", "config.yml"),
] as const;

function containsEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
}

function assertNoProjectExecutionConfig(
  cwd: string,
  tool: string,
  files: readonly string[],
  directories: readonly string[]
): void {
  let directory = cwd;
  const userHome = homedir();
  while (true) {
    // Harness user configuration is trusted input, not repository input. A
    // non-Git working directory below $HOME must never make the walker treat
    // ~/.<harness> as project configuration.
    if (directory === userHome) return;
    for (const relativePath of files) {
      const path = join(directory, relativePath);
      if (existsSync(path)) {
        throw new Error(
          `${tool} refuses repository executable configuration: ${path}`
        );
      }
    }
    for (const relativePath of directories) {
      const path = join(directory, relativePath);
      if (existsSync(path) && containsEntries(path)) {
        throw new Error(
          `${tool} refuses repository executable configuration: ${path}`
        );
      }
    }

    if (existsSync(join(directory, ".git"))) return;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export function assertNoCopilotProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Copilot",
    COPILOT_EXECUTABLE_CONFIG_FILES,
    COPILOT_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoAiderProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Aider",
    AIDER_EXECUTABLE_CONFIG_FILES,
    []
  );
}

export function assertNoOpenCodeProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "OpenCode",
    OPENCODE_EXECUTABLE_CONFIG_FILES,
    OPENCODE_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoCursorProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Cursor Agent",
    CURSOR_EXECUTABLE_CONFIG_FILES,
    CURSOR_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoClineProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Cline",
    CLINE_EXECUTABLE_CONFIG_FILES,
    CLINE_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoCodexProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Codex",
    CODEX_EXECUTABLE_CONFIG_FILES,
    CODEX_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoDroidProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Droid",
    DROID_EXECUTABLE_CONFIG_FILES,
    DROID_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoGeminiProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Gemini CLI",
    GEMINI_EXECUTABLE_CONFIG_FILES,
    GEMINI_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoGooseProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Goose",
    GOOSE_EXECUTABLE_CONFIG_FILES,
    []
  );
}
