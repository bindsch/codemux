import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UsageRefusalError } from "./validation.js";

// Cline cli-v3.0.74, inspected 2026-11-09:
// sdk/packages/core/src/extensions/tools/constants.ts:12-37,
// extensions/tools/runtime.ts:43-111, extensions/tools/team/team-tools.ts:197-216.
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/extensions/tools/constants.ts#L12-L37
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/extensions/tools/runtime.ts#L43-L111
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/extensions/tools/team/team-tools.ts#L197-L216
// The global filter uses exact names. "*" is not a wildcard.
export const CLINE_DISABLED_NATIVE_TOOLS = [
  "read_files", "search_codebase", "run_commands", "fetch_web_content", "apply_patch", "editor", "skills", "ask_question", "submit_and_exit",
  "spawn_agent", "tasks", "web_search", "team_spawn_teammate", "team_shutdown_teammate", "team_status", "team_task", "team_run_task",
  "team_cancel_run", "team_list_runs", "team_await_runs", "team_send_message", "team_broadcast", "team_read_mailbox", "team_mission_log",
  "team_cleanup", "team_create_outcome", "team_attach_outcome_fragment", "team_review_outcome_fragment", "team_finalize_outcome", "team_list_outcomes",
] as const;

export function assertClineToolVersion(version: string | null | undefined): void {
  if (version !== "3.0.74") throw new UsageRefusalError("cline --tools none requires verified Cline 3.0.74 for its native tool inventory");
}

export function clineToolsNoneSettings(settings: Record<string, unknown> = {}): Record<string, unknown> {
  const disabled = settings.disabledTools;
  const tools = settings.tools;
  if ((disabled !== undefined && (!Array.isArray(disabled) || disabled.some((name) => typeof name !== "string"))) ||
      (tools !== undefined && (tools === null || typeof tools !== "object" || Array.isArray(tools)))) {
    throw new UsageRefusalError("cline --tools none requires valid disabledTools and tools settings");
  }
  return { ...settings, disabledTools: [...new Set([...(disabled as string[] | undefined ?? []), ...CLINE_DISABLED_NATIVE_TOOLS])],
    tools: { ...(tools as Record<string, unknown> | undefined), web_search: { enabled: false } } };
}

/** Independent of plugin hooks: all ordinary tools are removed by settings,
 * all dynamic tool sources are absent, and the private custom provider has
 * no native model-tool manifest. Rules remain available in nonhermetic runs.
 * Call before installing the single codemux-owned plugin in configDir.
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L480-L492
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L618-L639 */
export function assertClineToolIsolation(options: { cwd: string; home: string; configDir: string; providerId: string; checkGlobal?: boolean }): void {
  if (options.providerId !== "codemux-override") throw new UsageRefusalError("cline --tools none requires an explicit custom provider override");
  const paths = new Set(options.checkGlobal === false ? [] : [join(resolve(options.configDir), "plugins"), join(resolve(options.configDir), "agents"),
    join(resolve(options.home), "Documents", "Cline", "Plugins"), join(resolve(options.home), ".agents", "plugins")]);
  let directory = realpathSync(options.cwd);
  for (;;) {
    paths.add(join(directory, ".cline", "plugins")); paths.add(join(directory, ".cline", "agents"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const path of paths) if (lstatSync(path, { throwIfNoEntry: false })) {
    throw new UsageRefusalError(`cline --tools none requires no unowned plugin or configured-agent channel: ${path}`);
  }
}
