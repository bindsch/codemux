/**
 * `--experiment-project-settings`: a hermetic run that loads the
 * repository's own permission rules, so an experiment can observe the
 * harness's native permission system. This module is the shared entry
 * (validateProjectSettingsRequest) and holds the Claude-family rules;
 * the OpenCode rules and its ancestor refusal live in
 * opencode-project-settings.ts.
 *
 * On the Claude family, every other run passes `--setting-sources user`,
 * so a repository's settings never reach the run, and --safe-mode stands
 * in for hermetic isolation. Here the run gets a private Claude config
 * directory (claude-project-config.ts) and the project and local setting
 * sources in place of the user source and --safe-mode: the repository's
 * rules apply, while the operator's user memory, settings, skills, hooks,
 * and plugins — all of which live in the config directory — stay out.
 * Project settings can run hooks and set environment variables, so the
 * flag is an explicit opt-in for a repository the operator built, and
 * scode is required.
 *
 * One channel survives the private config directory, so it is refused
 * instead: with the project or local setting source on, Claude Code walks
 * every ancestor of the working directory and loads what it finds there as
 * project memory (assertNoAncestorProjectMemory below). A fixture under
 * the operator's home is refused in practice, because the home directory
 * normally carries `~/.claude/CLAUDE.md` as such an ancestor file.
 */
import { lstatSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { UsageRefusalError, validateWorkingDirectory } from "./validation.js";
import type { RunRequest } from "./types.js";
import {
  OPENCODE_PASSTHROUGH_REFUSALS,
  OPENCODE_RUN_AUTONOMIES,
  assertNoAncestorOpenCodeProjectConfig,
} from "./opencode-project-settings.js";

export interface ProjectSettingsRequest {
  agent: string;
  hermetic: boolean;
  autonomy: string;
  sandbox: boolean;
  cwd: string;
  tools?: string;
  experimentMcp?: string;
  passthroughEnv?: readonly string[];
  /** A persistent session rather than a one-shot run (the session CLI).
   * Sessions accept `--auto high` in addition to `low`, because the
   * session high is codemux's own grant list, never the bypass flag —
   * see SESSION_AUTONOMIES. */
  session?: boolean;
}

/** The autonomy levels each mode accepts, with the reason a session may
 * take high where a run may not: the session high is
 * `--permission-mode default` plus the Edit/Write/NotebookEdit/Bash
 * grants (claude-session.ts) — never `--dangerously-skip-permissions` —
 * so the repository's deny rules still bind. Medium hides the permission
 * channel behind a grant list and read-only forbids tool use entirely,
 * and a run keeps the low-only rule: its high is the bypass flag. */
export const RUN_AUTONOMIES = "low";
export const SESSION_AUTONOMIES = "low or high";

export const PROJECT_SETTING_SOURCES = "project,local";

/** The only agents with a project setting source mapping. Every other
 * adapter's validateRunRequest refuses the flag outright
 * (assertProjectSettingsAgent), so an --experiment-project-settings
 * request can never be silently ignored by an agent that loads nothing
 * for it. */
export const PROJECT_SETTINGS_AGENTS = ["claude", "zai", "opencode"] as const;

/** The unmapped-agent refusal base.ts validateRunRequest runs: a
 * project-settings request names a trade (the repository's rules in
 * place of hermetic isolation), so an agent with no mapping must fail
 * the request rather than run it under plain isolation. */
export function assertProjectSettingsAgent(agent: string): void {
  if (!(PROJECT_SETTINGS_AGENTS as readonly string[]).includes(agent)) {
    throw new UsageRefusalError(
      `--experiment-project-settings applies to the claude, zai, and opencode agents only; ${agent} has no project setting source mapping`
    );
  }
}

// The run supplies its own config directory, so an operator redirect of
// the binary's config root or project-state layout is a second hand on
// the same knob.
const PASSTHROUGH_REFUSALS = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME"];

// The names Claude Code's project-memory walk looks for in every ancestor
// of the working directory (verified against the installed bundle,
// 2026-10-30): <ancestor>/CLAUDE.md and <ancestor>/.claude/CLAUDE.md load
// as project memory, <ancestor>/.claude/rules as project rules, and
// <ancestor>/CLAUDE.local.md as local memory under the local setting
// source, which this flag always passes.
const ANCESTOR_MEMORY_NAMES = ["CLAUDE.md", "CLAUDE.local.md", join(".claude", "CLAUDE.md"), join(".claude", "rules")];

export function validateProjectSettingsRequest(request: ProjectSettingsRequest): void {
  // A usage refusal (exit 64) on every path that reaches it: a request
  // this validator refuses is a flag combination only the caller can
  // fix, so the run and session CLIs map it to 64 alike (the session's
  // asUsage wrapper keeps its 64; run's handleUnexpectedError reads the
  // same class instead of exiting 1).
  const refuse = (reason: string): never => {
    throw new UsageRefusalError(`--experiment-project-settings ${reason}`);
  };
  if (request.agent === "opencode") {
    validateOpencodeProjectSettingsRequest(request, refuse);
    return;
  }
  if (request.agent !== "claude" && request.agent !== "zai") {
    refuse(`applies to the claude, zai, and opencode agents only; ${request.agent} has no project setting source mapping`);
  }
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  // Medium grants every shell command and a run's high bypasses the rules,
  // so either would hide the permission system this flag exists to observe.
  // A session's high is different: codemux's own grant list, never the
  // bypass flag (claude-session.ts), so the project's deny rules still
  // bind and the level is observable.
  if (request.session === true) {
    if (request.autonomy !== "low" && request.autonomy !== "high") {
      refuse(
        `requires --auto ${SESSION_AUTONOMIES} for sessions: high is codemux's session high ` +
          "(--permission-mode default plus the Edit/Write/NotebookEdit/Bash grants, never " +
          "--dangerously-skip-permissions), so project deny rules still bind; medium grants " +
          "every shell command and read-only forbids the tool use there is to observe"
      );
    }
  } else if (request.autonomy !== "low") {
    refuse(`requires --auto ${RUN_AUTONOMIES}; higher levels override project rules`);
  }
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  for (const name of PASSTHROUGH_REFUSALS) {
    if (request.passthroughEnv?.includes(name)) {
      refuse(`cannot be combined with --pass-env ${name}: the run gets its own private config directory`);
    }
  }
  assertNoAncestorProjectMemory(request.cwd);
}

/** The run-mode check the project-settings adapters (claude, zai,
 * opencode) run at prepareRun, from the request's own fields: the CLI's
 * early check is a duplicate, never the only gate, so a programmatic
 * launchRunRequest or adapter.run caller that skips the CLI gets the
 * same refusal before any spawn — and before prepareRun itself creates
 * the private config directory. Derives `sandbox` from the request's
 * own `sandboxed` claim: a request that misstates its containment is
 * refused rather than run. */
export function validateProjectSettingsRunRequest(request: RunRequest): void {
  validateProjectSettingsRequest({
    agent: request.agent,
    hermetic: request.hermetic === true,
    autonomy: request.autonomy ?? "read-only",
    sandbox: request.sandboxed === true,
    cwd: request.cwd ?? process.cwd(),
    tools: request.tools,
    experimentMcp: request.experimentMcp,
    passthroughEnv: request.passthroughEnv,
  });
}

/** The OpenCode arm of the validator: the shared gates plus the levels,
 * passthrough names, and ancestor refusal from opencode-project-settings.
 * Runs only — the session CLI's project-settings mode is claude and zai
 * only. */
function validateOpencodeProjectSettingsRequest(
  request: ProjectSettingsRequest,
  refuse: (reason: string) => never
): void {
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  if (request.session === true) {
    refuse("for sessions is claude and zai only; an opencode session has no project-settings mode");
  }
  // Both accepted levels keep the project's rules observable: at low a
  // headless run rejects every ask while unlisted calls ride the build
  // agent's allow-all defaults, and at high --auto approves every ask;
  // a deny rule fails the call before the question is ever emitted
  // either way (OPENCODE_RUN_AUTONOMIES). Read-only's plan agent has no
  // tool use to observe, and medium is the same `--agent build` as low
  // with a broader scode grant — not a different OpenCode permission
  // behavior.
  if (request.autonomy !== "low" && request.autonomy !== "high") {
    refuse(`requires --auto ${OPENCODE_RUN_AUTONOMIES}`);
  }
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  for (const name of OPENCODE_PASSTHROUGH_REFUSALS) {
    if (request.passthroughEnv?.includes(name)) {
      refuse(`cannot be combined with --pass-env ${name}: the run's permission rules must be the project's own`);
    }
  }
  assertNoAncestorOpenCodeProjectConfig(request.cwd);
}

/**
 * Refuses the run when any directory above the working directory carries a
 * Claude project-memory file. That ancestor walk is Claude Code's own
 * project memory — the binary runs it whenever the project or local
 * setting source is on, whatever `CLAUDE_CONFIG_DIR` says — so an
 * ancestor's file cannot be kept out of the run, only the run refused.
 * Every directory entry of such a name refuses it: a file, a directory,
 * or a link, including a dangling one, and an ancestor that cannot be
 * inspected refuses it too. The walk covers every directory strictly
 * above the canonical working directory and stops at the filesystem
 * root, which the binary's walk also never visits; the working directory
 * itself is the fixture's own and may carry the names. The error names
 * the nearest offending path, starting from the immediate parent.
 */
export function assertNoAncestorProjectMemory(cwd: string): void {
  const start = validateWorkingDirectory(cwd) ?? process.cwd();
  const root = parse(start).root;
  for (let dir = dirname(start); dir !== root; dir = dirname(dir)) {
    for (const name of ANCESTOR_MEMORY_NAMES) {
      const candidate = join(dir, name);
      try {
        lstatSync(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw new UsageRefusalError(
          `--experiment-project-settings: cannot inspect ${candidate} (${code ?? "unknown error"}); ` +
            "an ancestor of the working directory that might carry project memory refuses the run"
        );
      }
      throw new UsageRefusalError(
        `--experiment-project-settings: ${candidate} would load as project memory. Claude Code walks every ` +
          "ancestor of the working directory for CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, and .claude/rules, " +
          "and the private config directory does not stop the walk (a home directory usually carries ~/.claude/CLAUDE.md, " +
          "so a fixture under it is refused). Place the fixture where no ancestor carries them; the working directory " +
          "itself may."
      );
    }
  }
}
