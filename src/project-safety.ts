import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageRefusalError } from "./validation.js";

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

const OPENHANDS_EXECUTABLE_CONFIG_FILES = [
  join(".openhands", "hooks.json"),
] as const;

// A repository can otherwise supply the skills, hooks, agent profiles, and
// microagent prompts that a session runs with.
const OPENHANDS_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".openhands", "agents"),
  join(".openhands", "hooks"),
  join(".openhands", "microagents"),
  join(".openhands", "plugins"),
  join(".openhands", "profiles"),
  join(".openhands", "skills"),
] as const;

const KIMI_EXECUTABLE_CONFIG_FILES = [
  join(".kimi-code", "config.toml"),
  join(".kimi-code", "mcp.json"),
] as const;

// Kimi auto-discovers skills and agent profiles from the project directory, so
// a repository can otherwise supply the prompts and tools a session runs with.
const KIMI_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".kimi-code", "agents"),
  join(".kimi-code", "skills"),
  join(".kimi-code", "mcp"),
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

// Codex discovers skills from `.agents/skills` in every directory between the
// project root and the working directory, and from the project config folder.
// A hermetic run redirects HOME and CODEX_HOME, which covers the user-level
// roots; these repository roots are refused instead of silently included.
const CODEX_PROJECT_SKILL_DIRECTORIES = [
  join(".agents", "skills"),
  join(".codex", "skills"),
] as const;

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

// Antigravity discovers project-level skills, rules, plugins, and subagents
// from `.agents/` between the working directory and the project root. The
// refusal list follows the binary's own strings, which name the four
// manifests (`.agents/{skills,rules,plugins,agents}.json`), the matching
// `.agents/{skills,rules,plugins,agents,workflows}/` directories, and
// `.agents/hooks.json` -- so a repository can otherwise supply the prompts,
// hooks, and tools a session runs with. `.gemini/.env` is refused for the
// same reason as the Gemini CLI's: agy shares the Gemini config lineage
// (its strings read an env auth store), and an env file the repository
// ships would inject credentials into the harness. The same strings read a
// whole `.gemini/config/` tree (plugins, skills, hooks.json,
// mcp_config.json, workflows), so that directory is refused too. The
// workspace directories agy itself writes -- `.gemini/antigravity/` for
// artifacts and the transcript, `.agents/teamwork/` for orchestration
// state -- are deliberately not refused.
const AGY_EXECUTABLE_CONFIG_FILES = [
  join(".agents", "skills.json"),
  join(".agents", "rules.json"),
  join(".agents", "plugins.json"),
  join(".agents", "agents.json"),
  join(".agents", "hooks.json"),
  join(".gemini", ".env"),
] as const;
const AGY_EXECUTABLE_CONFIG_DIRECTORIES = [
  join(".agents", "skills"),
  join(".agents", "rules"),
  join(".agents", "plugins"),
  join(".agents", "agents"),
  join(".agents", "workflows"),
  join(".gemini", "config"),
] as const;

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

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
  directories: readonly string[],
  reason = "refuses repository executable configuration",
  inspectHome = false,
  userHomeDirectory = homedir(),
  skipStartDirectory = false
): void {
  // Both ends of the walk are compared as real paths: the working directory
  // arrives canonicalized, and a HOME under a symlinked temp root (macOS
  // /var -> /private/var) must still be recognized as the home.
  let directory = realpathOr(cwd);
  const userHome = realpathOr(userHomeDirectory);
  cwd = directory;
  // An OpenCode --experiment-project-settings run exempts the working
  // directory itself (its own opencode.json/.opencode are the point) and
  // covers the ancestors with a dedicated refusal instead
  // (opencode-project-settings.ts); every other caller checks every level.
  let skip = skipStartDirectory;
  while (true) {
    // Harness user configuration is trusted input, not repository input. A
    // non-Git working directory below $HOME must never make the walker treat
    // ~/.<harness> as project configuration. Repository skills are the
    // exception: when $HOME is the working directory, or is itself a Git
    // root reached from below without another one in between, Codex treats
    // $HOME as the project root and finds ~/.agents/skills there, so that
    // walk inspects $HOME in those two cases and stops there otherwise.
    if (
      directory === userHome &&
      !(inspectHome && (directory === cwd || existsSync(join(directory, ".git"))))
    ) {
      return;
    }
    if (!skip) {
      // A refusal, not a crash: the caller asked for a launch this rule
      // forbids, so the exit is 64 through UsageRefusalError (review
      // round 10, contracts 7).
      for (const relativePath of files) {
        const path = join(directory, relativePath);
        if (existsSync(path)) {
          throw new UsageRefusalError(`${tool} ${reason}: ${path}`);
        }
      }
      for (const relativePath of directories) {
        const path = join(directory, relativePath);
        if (existsSync(path) && containsEntries(path)) {
          throw new UsageRefusalError(`${tool} ${reason}: ${path}`);
        }
      }
    }
    skip = false;

    if (directory === userHome || existsSync(join(directory, ".git"))) return;
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

/** `skipStartDirectory` exempts the working directory itself, for an
 * OpenCode `--experiment-project-settings` run whose own project config is
 * the point of the flag; the ancestors above it are still refused here
 * within this walk's bounds. */
export function assertNoOpenCodeProjectExecutionConfig(
  cwd: string,
  skipStartDirectory = false
): void {
  assertNoProjectExecutionConfig(
    cwd,
    "OpenCode",
    OPENCODE_EXECUTABLE_CONFIG_FILES,
    OPENCODE_EXECUTABLE_CONFIG_DIRECTORIES,
    "refuses repository executable configuration",
    false,
    homedir(),
    skipStartDirectory
  );
}

export function assertNoOpenHandsProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "OpenHands",
    OPENHANDS_EXECUTABLE_CONFIG_FILES,
    OPENHANDS_EXECUTABLE_CONFIG_DIRECTORIES
  );
}

export function assertNoKimiProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Kimi Code",
    KIMI_EXECUTABLE_CONFIG_FILES,
    KIMI_EXECUTABLE_CONFIG_DIRECTORIES
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

/** A hermetic Codex run must not pick up skills the repository ships.
 * `userHomeDirectory` is a test seam; Bun's homedir() ignores $HOME. */
export function assertNoCodexProjectSkills(
  cwd: string,
  userHomeDirectory = homedir()
): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Codex",
    [],
    CODEX_PROJECT_SKILL_DIRECTORIES,
    "refuses repository skills in a hermetic run",
    true,
    userHomeDirectory
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

export function assertNoAgyProjectExecutionConfig(cwd: string): void {
  assertNoProjectExecutionConfig(
    cwd,
    "Antigravity",
    AGY_EXECUTABLE_CONFIG_FILES,
    AGY_EXECUTABLE_CONFIG_DIRECTORIES
  );
}
