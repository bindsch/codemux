// Hermetic runs get a private HOME and CODEX_HOME (see hermetic-home.ts),
// which removes everything Codex reads from disk. These overrides remove what
// the working directory and the account would still contribute. A feature key
// Codex no longer knows only logs a warning, so a removed key cannot break a
// launch.
export const CODEX_HERMETIC_FLAGS = [
  // The login is the linked auth.json; the Keychain entry is keyed by the
  // real CODEX_HOME path and would not be found from the private one.
  "-c", 'cli_auth_credentials_store="file"',
  // A zero budget skips AGENTS.md discovery entirely (agents_md.rs).
  "-c", "project_doc_max_bytes=0",
  "-c", "project_doc_fallback_filenames=[]",
  // Account-level app connectors add instructions and tools of their own.
  "-c", "include_apps_instructions=false",
  "--disable", "apps",
  "--disable", "plugins",
  "--disable", "remote_plugin",
  "--disable", "recommended_plugins",
  "--disable", "hooks",
  "--disable", "memories",
  "--disable", "goals",
  "--disable", "skill_mcp_dependency_install",
  // The shell snapshot sources the operator's shell profile.
  "--disable", "shell_snapshot",
  // Not disabled: Codex's bundled system skills (imagegen, openai-docs,
  // plugin-creator, skill-creator, skill-installer at 0.154), which it
  // extracts into any home. They ship with the harness, like its base
  // prompt. `skip_host_skill_discovery` does not remove them and only
  // adds an under-development warning.
] as const;

// `--tools none`: every tool Codex 0.154 registers that reaches the machine,
// the network, or another agent, except `apply_patch`, which Codex ties to
// the model rather than to a feature (tools/spec_plan.rs). The adapter
// therefore accepts `--tools none` only at read-only autonomy, where the
// sandbox denies writes to the working directory (locations scode keeps
// writable, such as harness state and temp, remain reachable). The plan
// tool remains; it has no effect outside the conversation.
export const CODEX_NO_TOOLS_FLAGS = [
  "--disable", "shell_tool",
  "--disable", "unified_exec",
  "--disable", "view_image",
  "--disable", "multi_agent",
  "--disable", "multi_agent_v2",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "image_generation",
  "--disable", "tool_suggest",
  // The top-level mode; a boolean `tools.web_search` is silently dropped.
  "-c", 'web_search="disabled"',
  "-c", "tools.view_image=false",
] as const;

// Disable configurable native tools. Catalog overrides also remove native-tool
// settings selected by model metadata.
export const CODEX_EXPERIMENT_FLAGS = [
  "-c", "features.non_prefixed_mcp_tool_names=false",
  "--disable", "code_mode",
  "--disable", "code_mode_host",
  "--disable", "sleep_tool",
  "--disable", "send_message_to_user_async",
  "--disable", "request_permissions_tool",
  "--disable", "token_budget",
  "--disable", "deferred_executor",
  "--disable", "current_time_reminder",
  "-c", "multi_agent_v2.disable_native_tools=true",
  "-c", "tools.update_plan.enabled=false",
  "-c", "tools.experimental_request_user_input.enabled=false",
] as const;

// The file's name inside its per-run directory (or the private hermetic
// home): the directory gives the run its uniqueness, so the file itself
// needs none.
export const LAST_MESSAGE_BASENAME = "last-message";

// Where a plain run's per-run fallback directory lives: inside the real
// CODEX_HOME, harness state scode keeps writable on every platform (its
// Linux sandbox mounts a fresh /tmp that would hide a temp-root file from
// the parent). The private hermetic home follows the same rule for the
// same reason (see hermetic-home.ts).
export const SCRATCH_PARENT_DIR_NAME = ".codemux-scratch";
