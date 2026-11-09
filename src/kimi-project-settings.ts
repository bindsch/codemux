import type { ProjectSettingsRequest } from "./claude-project-settings.js";

/**
 * The kimi arm of `--experiment-project-settings` (the shared validator
 * in claude-project-settings.ts dispatches here): a hermetic run whose
 * repository loads. Kimi's project channels ride the working directory,
 * not the brand home, so the hermetic redirect (HOME and KIMI_CODE_HOME
 * pointed at the private home) never touched them — a plain hermetic run
 * refused the inputs instead (assertNoKimiHermeticProjectConfig,
 * kimi-project-safety.ts). This mode flips exactly that refusal: the
 * repository's own configuration loads inside the hermetic boundary.
 *
 * The channels (installed kimi-code 2.5.2 ~/.kimi-code/bin/kimi,
 * strings read 2026-11-09): the project root is the nearest `.git`
 * ancestor, else the working directory (findProjectRoot); instructions
 * load from `.kimi-code/AGENTS.md`, `AGENTS.md`, and `agents.md` in every
 * directory from the root down to the working directory (the
 * dirsRootToLeaf candidate list); skills from `<root>/.kimi-code/skills`
 * and `<root>/.agents/skills` (PROJECT_BRAND_DIRS); agents from
 * `<root>/.kimi-code/agents`; MCP servers from `<cwd>/.kimi-code/mcp.json`
 * and `<root>/.mcp.json`; and the workspace table
 * `<root>/.kimi-code/local.toml` (getProjectLocalConfigPath).
 *
 * What stays out: the operator's global channels resolve under the
 * redirected HOME (`~/.agents/AGENTS.md`, `~/.agents/skills`) and the
 * private brand home (config.toml filtered by the hermetic allowlist,
 * no skills directory), and the run drops its `--skills-dir` — that
 * option replaces "auto-discovered user and project directories"
 * (2.5.2 root option table), so keeping it would keep the repository's
 * own skills out of the run the flag exists to expose. Project
 * configuration can run code (an MCP server entry spawns a command at
 * session start), so the scode sandbox is required, exactly as every
 * other project-settings arm requires it.
 */
export function validateKimiProjectSettings(
  request: ProjectSettingsRequest,
  refuse: (reason: string) => never
): void {
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  // Headless kimi carries no native autonomy flag at all (2.5.2 refuses
  // --plan, --yolo, and --auto together with --prompt), so the level is
  // the scode boundary alone and the experiment keeps the standard one:
  // read-only denies the tool use the project's own channels shape, and
  // medium and high grant reach the observation never needs.
  if (request.autonomy !== "low") {
    refuse("requires --auto low for kimi: headless kimi has no native autonomy control, so the level is the scode boundary alone and the experiment keeps the standard one");
  }
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  if (request.passthroughEnv?.includes("KIMI_CODE_HOME")) {
    refuse("cannot be combined with --pass-env KIMI_CODE_HOME: the run gets its own private brand home");
  }
}
