import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeOwnedSync } from "./fs-durable.js";
import type { ProjectSettingsRequest } from "./claude-project-settings.js";

/**
 * The codex arm of `--experiment-project-settings` (the shared validator
 * in claude-project-settings.ts dispatches here): a hermetic run whose
 * repository loads. Codex's project channel is a trust-gated config
 * layer, so the mode's carrier is a trust entry, not an argv flag: the
 * run keeps its private CODEX_HOME (hermetic-home.ts) and that home's
 * config.toml marks the repository trusted (`[projects."<root>"
 * trust_level = "trusted"]`), which is the only key the home's config
 * carries. The launch drops `--ignore-user-config` (which would skip
 * that file) and the AGENTS.md suppression flags, and the hermetic guard
 * that refuses the repository's own inputs (assertNoCodexProjectSkills
 * and the `.codex` executable-config guard, project-safety.ts) flips.
 *
 * The channels (codex rust-v0.166.0, read 2026-11-09): a `.codex`
 * directory in every directory between the working directory and the
 * project root (found by the `.git` marker, the default
 * project_root_markers) contributes its config.toml as a full Project
 * config layer and its `skills/` as a Repo-scope skill root
 * (config/src/loader/mod.rs discover_project_layers; ext/skills/
 * src/host_roots.rs), `.agents/skills` directories on the same walk
 * contribute skill roots, and AGENTS.md loads as the project doc. A
 * directory without its own trust entry inherits the project root's
 * (decision_for_dir falls back to the root key), so one entry covers
 * the whole walk; an untrusted layer is skipped, which is what a plain
 * hermetic run effectively does (the private home has no entries).
 *
 * What stays out: the operator's config.toml, skills, plugins, and login
 * resolve under the real CODEX_HOME, which the private home replaces,
 * and the account-level surfaces stay disabled (the rest of
 * CODEX_HERMETIC_FLAGS). Project configuration can run code (hooks and
 * MCP server entries spawn commands), so the scode sandbox is required,
 * exactly as every other project-settings arm requires it. Medium and
 * high autonomy are refused: a run's sandboxed launch passes codex's
 * bypass flag, so anything above low would trade away the standard
 * boundary the observation needs (the claude family's rule).
 */

/** The trust entry the private home's config.toml carries in this mode:
 * the project root (the nearest `.git` ancestor, else the working
 * directory — codex's default project_root_markers is exactly [".git"],
 * config/src/project_root_markers.rs at rust-v0.166.0) marked trusted,
 * which every directory under it inherits. */
export function codexProjectTrustTable(projectRoot: string): string {
  const key = JSON.stringify(projectRoot);
  return `[projects.${key}]\ntrust_level = "trusted"\n`;
}

/** The project root codex itself would find: the nearest ancestor of
 * `cwd` containing `.git` (a worktree's `.git` file counts — codex's
 * probe is a metadata check, not a directory test), else `cwd`. */
export function codexProjectRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/** The mode's one write into the run's private home: config.toml carrying
 * the credential-store key and the project-root trust entry, nothing
 * else (the run reads it because the mode drops --ignore-user-config).
 * Called at prepareRun, after the mode's gates have passed. */
export function writeCodexProjectSettingsConfig(codexHome: string, cwd: string, preserveProvider = false): void {
  const base = preserveProvider
    ? readFileSync(join(codexHome, "config.toml"), "utf8")
    : 'cli_auth_credentials_store = "file"\n';
  writeOwnedSync(
    join(codexHome, "config.toml"),
    `${base}${base.endsWith("\n") ? "" : "\n"}${codexProjectTrustTable(codexProjectRoot(cwd))}`,
    0o600
  );
}

export function validateCodexProjectSettings(
  request: ProjectSettingsRequest,
  refuse: (reason: string) => never
): void {
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  // A sandboxed codex run passes the bypass flag regardless of level, so
  // the level only names how far the run could go without the sandbox;
  // the mode keeps the family's low-only rule for runs. A session's high
  // is codemux's own grant list (the claude family's rule), so both
  // levels bind there.
  if (request.session === true) {
    if (request.autonomy !== "low" && request.autonomy !== "high") {
      refuse("requires --auto low or high for codex sessions: high is codemux's session grant list, and medium grants every shell command");
    }
  } else if (request.autonomy !== "low") {
    refuse("requires --auto low for codex; higher levels override project rules");
  }
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  if (request.passthroughEnv?.includes("CODEX_HOME")) {
    refuse("cannot be combined with --pass-env CODEX_HOME: the run gets its own private home");
  }
}
