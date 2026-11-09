/**
 * Qwen's tool-removal carrier: the `--exclude-tools` flag over the
 * full built-in tool registry (qwen 0.24.0).
 *
 * Wire facts, read 2026-11-09 from the installed
 * /opt/homebrew/lib/node_modules/@qwen-code/qwen-code bundle:
 *
 * - chunks/chunk-ERIBG3BX.js:15400-15470 defines ToolNames. The shorter
 *   static CORE_TOOLS list omits tools that createToolRegistry registers
 *   at chunk-SNPYTKXI.js:170643-171039, including get_goal, update_goal,
 *   agent, skill, tool_search, report_findings, and worktree tools.
 * - `--exclude-tools` ("Tools to exclude from the default set",
 *   chunks/chunk-BSIOCNDK.js option table) merges into the deny list
 *   UNCONDITIONALLY: the settings merge empties `settings.tools.exclude`
 *   under safe mode (`bareMode || safeMode ? [] : ...`), but
 *   `argv.excludeTools` joins `mergedDeny` afterwards whatever the mode
 *   (chunks/chunk-HWKWZSZY.js, byte 2063354's neighborhood), and
 *   `getPermissionsDeny` merges that list into every permission check.
 * - The deny match is exact string equality against the tool name
 *   (execution_denied), so excluding the whole CORE_TOOLS list removes
 *   every built-in tool definition from the model's set — the gemini
 *   deny-rule semantics (src/gemini-policy.ts) without needing a policy
 *   file, because the carrier is argv and rides every spawn.
 * - `--max-tool-calls 0` is NOT a carrier: RunBudgetEnforcer's
 *   tickToolCall ABORTS the run when the budget is exhausted, so it
 *   would fail every turn instead of denying tool use.
 */

/** Every static built-in name in Qwen 0.24.0's ToolNames table, including
 * optional tools. Native experiment evidence checks the resulting set. */
export const QWEN_CORE_TOOLS: readonly string[] = [
  "read_file",
  "zoom_image",
  "write_file",
  "edit",
  "notebook_edit",
  "glob",
  "grep_search",
  "run_shell_command",
  "list_directory",
  "read_mcp_resource",
  "web_fetch",
  "web_search",
  "todo_write",
  "save_memory",
  "lsp",
  "cron_create",
  "cron_list",
  "cron_delete",
  "loop_wakeup",
  "create_sub_session",
  "monitor",
  "exec", "agent", "skill", "exit_plan_mode", "enter_plan_mode", "image_gen",
  "ask_user_question", "list_agents", "task_stop", "task_create", "task_update",
  "task_list", "team_create", "team_delete", "team_plan_approval", "request_shutdown",
  "send_message", "structured_output", "tool_search", "enter_worktree", "exit_worktree",
  "workflow", "artifact", "record_artifact", "record_source", "report_findings", "get_goal", "update_goal",
  "omni_downsample_image", "omni_downscale_video", "omni_downsample_audio", "omni_extract_keyframes",
  "omni_extract_audio", "omni_clip_video", "omni_convert_image", "omni_transcribe_audio",
  "omni_clip_image", "omni_clip_audio", "omni_caption_image", "omni_caption_audio",
  "omni_ocr_image", "omni_understand_video_segments", "omni_recall_media_memory", "propose_goal", "display_image",
];

/** The built-in tools whose only job is web access (CORE_TOOLS members;
 * excluding both removes qwen's web reach while shell networking stays
 * governed by the sandbox, the claude `--no-web` rule). */
export const QWEN_WEB_TOOLS: readonly string[] = ["web_search", "web_fetch"];

/** The argv that removes every built-in tool definition. */
export function qwenNoToolsArgs(): string[] {
  return ["--exclude-tools", QWEN_CORE_TOOLS.join(",")];
}

/** The argv that removes qwen's built-in web tools for a --no-web run. */
export function qwenNoWebArgs(): string[] {
  return ["--exclude-tools", QWEN_WEB_TOOLS.join(",")];
}
