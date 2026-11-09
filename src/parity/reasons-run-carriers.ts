import { limitation, supported } from "./features.js";

/** A refused codemux carrier is OPEN when another native carrier remains possible. */
export const RUN_CARRIERS = {
  agyCwd: limitation(
    "Agy 1.5.3 walks up from the working directory to the repository root loading GEMINI.md, AGENTS.md, and .agents/rules/*.md as directory-based rules, with no suppression flag, so a hermetic run needs a clean directory owned by the run.",
    "2026-11-09: src/adapters/agy.ts validateRunRequest asserts the refusal; installed ~/.local/bin/agy (1.5.3) offsets 62105582 and 63285886: rule-discovery text 'The system automatically discovers and applies rules from' GEMINI.md/AGENTS.md 'placed directly in any directory' walked up 'to the repository root', plus .agents/rules/*.md",
    "agy --hermetic requires an explicit --cwd owned by this run", "tests/agy-isolation.test.ts"),
  aiderCwd: limitation(
    "Aider 0.86.2 reads configuration and environment files from the project and working directory without a switch to suppress those roots.",
    "2026-11-09: src/adapters/aider.ts capabilities; aider 0.86.2 main.py default_config_files, load_dotenv_files, generate_search_path_list",
    "aider --hermetic requires an explicit --cwd", "tests/new-adapters-aider.test.ts"),
  codexCwd: limitation(
    "Codex 0.166.0 discovers repository skills with no suppression switch: every `.agents/skills` directory between the working directory and the project root (found by the `.git` marker) and the project config folder's `.codex/skills` become skill roots, and the only opt-out feature, skip_host_skill_discovery, is a no-op on a stock install — the stock skills extension always registers the host provider whose presence disables both of the feature's gates — while `skills.config` rules disable individual skills by name or path only, so a hermetic run needs a clean directory owned by the run.",
    "2026-11-09: codex rust-v0.166.0 ext/skills/src/host_roots.rs repo_agents_skill_roots walk (dirs_between_project_root_and_cwd joining .agents/skills; default project-root markers [\".git\"]) and roots_from_layer_stack Project branch (.codex/skills); the feature's only two gates (core/src/session/session.rs:653 and core/src/session/turn_context.rs:1322) both require !requires_host_skill_discovery(), and ext/skills/src/extension.rs install() always builds with_host_provider; skills.config rules are name/path selectors (config/src/skills_config.rs SkillConfigRule); src/project-safety.ts assertNoCodexProjectSkills refuses .agents/skills and .codex/skills",
    "Codex refuses repository skills in a hermetic run", "tests/project-safety.test.ts"),
  geminiCwd: limitation(
    "OPEN: Gemini hermetic runs reject workspace context and settings; the current evidence does not exclude every native workspace suppression mechanism.",
    "2026-11-09: src/adapters/gemini.ts validateRunRequest; src/clean-cwd.ts",
    "gemini isolation requires an explicit --cwd", "tests/adapters-gemini.test.ts"),
  droidCwd: limitation(
    "Droid 0.221.0 loads project guideline files from the working directory and its ancestors with no suppression flag, so a hermetic run needs a clean directory owned by the run.",
    "2026-11-09: src/adapters/droid.ts validateRunRequest asserts the refusal; installed droid 0.221.0 bundle guideline resolver reads the files CLAUDE.md, Claude.md, AGENTS.md, Agents.md and agents.md and the directories .factory, .factory-dev, .agents and .agent from the cwd upward",
    "droid --hermetic requires an explicit --cwd owned by this run", "tests/droid-run-parity.test.ts"),
  gooseCwd: limitation(
    "Goose 1.50.1 loads .goosehints and AGENTS.md context files from the working directory and its ancestors up to the Git root with no suppression flag, so a hermetic run needs a clean directory owned by the run.",
    "2026-11-09: src/adapters/goose.ts validateRunRequest asserts the refusal; installed goose 1.50.1 load_hints.rs GOOSE_HINTS_FILENAME and AGENTS_MD_FILENAME resolution",
    "goose --hermetic requires an explicit --cwd owned by this run", "tests/adapters-goose.test.ts"),
  kimiCwd: limitation(
    "Kimi loads project instructions unconditionally: .kimi-code/AGENTS.md, AGENTS.md, and agents.md from every directory between the working directory and the Git root, with no flag, environment variable, or trust gate to stop them (project MCP servers are trust-gated; the instruction walk is not), so a hermetic run cannot suppress a repository's own configuration and needs a clean directory owned by the run.",
    "2026-11-09: kimi-code 2.5.2 bin/kimi instruction walk at byte 94153622 collects .kimi-code/AGENTS.md, AGENTS.md and agents.md with no trust/suppression input; project local config at byte 93988493 reads .kimi-code/local.toml. loadMcpServers has includeProject tied to trust, but the instruction/config walks do not. src/kimi-project-safety.ts rejects those inputs.",
    "kimi hermetic runs refuse project customization", "tests/kimi-hermetic.test.ts"),
  openhandsCwd: limitation(
    "OpenHands 1.16.0 loads workspace hooks and the project-skill tree from the working directory's .openhands (HookConfig.load reads {working_dir}/.openhands/hooks.json), a channel the private HOME cannot close, so a hermetic run needs a clean directory owned by the run.",
    "2026-11-09: src/adapters/openhands.ts validateRunRequest asserts the refusal; OpenHands 1.16.0 setup.py HookConfig.load searches exactly working_dir/.openhands/hooks.json and ~/.openhands/hooks.json",
    "openhands --hermetic requires an explicit --cwd owned by this run", "tests/openhands.test.ts"),
  codexOutput: limitation(
    "Codex 0.166.0 has no model output-token cap. The config schema and native ModelInfo catalog expose context/compaction limits and tool-output truncation, while the outbound ResponsesApiRequest and WebSocket request have no max_output_tokens field or arbitrary request-body override.",
    "2026-11-09: rust-v0.166.0 core/config.schema.json; protocol/src/openai_models.rs:390-491 ModelInfo; codex-api/src/common.rs:263-346 ResponsesApiRequest/ResponseCreateWsRequest. Catalog max_context_window and effective_context_window_percent bound context/input, not generated output.",
    "CODEMUX_CODEX_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored", "tests/provider-override-mappings-codex.test.ts"),
  cursorOutput: limitation(
    "Cursor 2026.11.05 exposes no output-token parameter in its model overrides, whose unsupported combinations are silently dropped.",
    "2026-11-09: src/adapters/cursor.ts validatedProvider; Cursor 2026.11.05 483.index.js sanitizeParametersForModelChange",
    "CODEMUX_CURSOR_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored", "tests/cursor-run-parity.test.ts"),
  cursorContext: limitation(
    "Cursor 2026.11.05 exposes model-specific context variants rather than a numeric context-token cap, and silently drops unsupported combinations.",
    "2026-11-09: src/adapters/cursor.ts validatedProvider; Cursor 2026.11.05 483.index.js sanitizeParametersForModelChange",
    "CODEMUX_CURSOR_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored", "tests/cursor-run-parity.test.ts"),
  droidContext: limitation(
    "Droid 0.221.0 BYOK customModels entries carry no context-window field; the schema's only token control is maxOutputTokens.",
    "2026-11-09: src/adapters/droid.ts validatedProvider; installed droid 0.221.0 bundle settings schema ne=o({sessionDefaultSettings, ..., customModels, ...}): the customModels entry fields (model, id, index, displayName, baseUrl, apiKey, provider, noImageSupport, maxOutputTokens) enumerate no context key",
    "CODEMUX_DROID_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored", "tests/provider-override-mappings-droid.test.ts"),
  openhandsOutput: limitation(
    "OpenHands 1.16.0's provider surface is exactly --override-with-envs, which reads only LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL, so no output-token cap can ride it.",
    "2026-11-09: src/adapters/openhands.ts validatedProvider asserts the refusal; openhands 1.16.0 agent_store.py LLMEnvOverrides.from_env reads exactly the LLM trio; the parser's full option list carries no other model-configuration flag",
    "CODEMUX_OPENHANDS_PROVIDER_MAX_OUTPUT_TOKENS cannot be honored", "tests/provider-override-mappings-openhands.test.ts"),
  openhandsContext: limitation(
    "OpenHands 1.16.0's provider surface is exactly --override-with-envs, which reads only LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL, so no context-token cap can ride it.",
    "2026-11-09: src/adapters/openhands.ts validatedProvider asserts the refusal; openhands 1.16.0 agent_store.py LLMEnvOverrides.from_env reads exactly the LLM trio; the parser's full option list carries no other model-configuration flag",
    "CODEMUX_OPENHANDS_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored", "tests/provider-override-mappings-openhands.test.ts"),
  piW3RunExperimentProjectSettings: limitation(
    "Pi project settings have no native tool permission-rule schema to observe. --approve selects project trust; it does not enable tool approval rules.",
    "2026-11-09: @earendil-works/pi-coding-agent 0.85.1 package.json; dist/cli/args.js:205-209 maps --approve/--no-approve to projectTrustOverride; dist/core/settings-manager.js:54-55 loads settings.json and .pi/settings.json; dist/core/settings-manager.d.ts Settings contains no permissions/rules field. Tool policy requires extension code through tool_call handlers, not native project permission rules.",
    "pi has no project setting source mapping", "tests/pi-w3-carriers.test.ts"),
  piW3SessionExperimentProjectSettings: limitation(
    "Pi project settings have no native tool permission-rule schema to observe. --approve selects project trust; it does not enable tool approval rules.",
    "2026-11-09: @earendil-works/pi-coding-agent 0.85.1 package.json; dist/cli/args.js:205-209 maps --approve/--no-approve to projectTrustOverride; dist/core/settings-manager.d.ts Settings contains no permissions/rules field. Tool policy requires extension code through tool_call handlers, not native project permission rules.",
    "--experiment-project-settings applies to the", "tests/pi-w3-carriers.test.ts"),
  piW3SessionPermissionPolicyDeny: limitation(
    "Pi's core tools have no permission-prompt channel or native deny-rule configuration. --no-approve controls project trust, not permission prompts. --no-tools removes tools instead of answering permission prompts.",
    "2026-11-09: pi 0.85.1 dist/cli/args.js:205-209 projectTrustOverride; dist/modes/rpc/rpc-mode.js handles prompt/steer/follow_up/abort, with extension_ui_request for arbitrary extension dialogs but no core tool permission request; dist/core/extensions/types.d.ts tool_call.block is executable extension policy, not a native permission prompt.",
    "--permission-policy deny is unavailable for 'pi'", "tests/pi-w3-carriers.test.ts"),
  geminiW3RunHermeticAnyCwd: limitation(
    "Gemini 0.60.0 always reads workspace settings outside its home and exposes no workspace-settings suppression switch; system override files require root ownership. Hermetic runs require a clean working directory.",
    "2026-11-09: @google/gemini-cli/package.json version 0.60.0; bundle/chunk-OCLZG6C5.js:16530 workspaceSettingsPath, :16611 load(workspaceSettingsPath), :16579 loadSystemFile/isFileAndDirectorySecureSync; bundle/gemini-LUNNHKPJ.js:8058-8258 flag schema has no workspace-settings suppression option.",
    "gemini isolation requires an explicit --cwd", "tests/adapters-gemini.test.ts"),
  geminiW3RunMaxBudgetUsd: limitation(
    "Gemini 0.60.0 exposes turn and token controls but no dollar spend limit or native dollar cost accounting.",
    "2026-11-09: @google/gemini-cli/package.json version 0.60.0; bundle/gemini-LUNNHKPJ.js:8058-8258 complete run option schema; bundle/chunk-OCLZG6C5.js:13330 modelConfigs settings; bundle/chunk-M6NSK26M.js:380563 convertToStreamStats returns token counts and tool_calls, without dollar fields.",
    "gemini has no spend limit flag; --max-budget-usd is unsupported", "tests/gemini-evidence.test.ts"),
  geminiW3RunProviderOverrideMaxContextTokens: limitation(
    "Gemini 0.60.0 computes context capacity from a hard-coded tokenLimit(model) table, without a numeric context-cap setting or environment input.",
    "2026-11-09: @google/gemini-cli/package.json version 0.60.0; bundle/chunk-M6NSK26M.js:332711 tokenLimit(model) returns 1048576 or GEMMA_4_TOKEN_LIMIT (256000); :346116 subtracts getLastPromptTokenCount from that table result.",
    "gemini cannot set provider max-context-tokens", "tests/gemini-policy.test.ts"),
  geminiW3RunCost: limitation(
    "Gemini 0.60.0 native JSON statistics report tokens and tool calls but no dollar cost; codemux returns null rather than inventing pricing.",
    "2026-11-09: @google/gemini-cli/package.json version 0.60.0; bundle/chunk-M6NSK26M.js:380563 convertToStreamStats and :380509 JsonFormatter.format add no cost field; telemetry ApiResponseEvent :276866-276874 usage and :276881-276908 toLogRecord contain tokens only. Raw response serialization :310987/:311050 includes native usageMetadata, responseId and modelVersion, without dollar amounts.",
    "cost_usd: null", "tests/gemini-evidence.test.ts"),
  copilotW3RunMaxBudgetUsd: limitation(
    "Copilot exposes a soft AI-credit ceiling, not a USD spend ceiling. Premium request multipliers and nano-AI units cannot be converted to USD without external prices.",
    "2026-11-09: installed @github/copilot 1.0.103 copilot.tgz/package/cli-main.js limits help: --max-ai-credits is a soft cap checked after a model response. copilot-sdk/generated/session-events.d.ts AssistantUsageData.cost is a model multiplier; AssistantUsageCopilotUsage.totalNanoAiu is nano-AI units. The 1.0.85 app.js also defines --max-ai-credits.",
    "copilot has no spend limit flag; --max-budget-usd is unsupported", "tests/copilot-parity.test.ts"),
  copilotW3RunServedModelEvidence: supported("tests/copilot-gemini-pi-run-launch.test.ts",
    "A --result-json run is the observed RPC session (src/launch.ts prepareCopilotModelRun): llmInference.setProvider routes provider responses through codemux, and served_model is the main-agent model named in successful response bytes (src/copilot-model-evidence.ts). A run without that evidence fails. Requires network access: --sandbox-no-net and --sandbox-trust untrusted refuse it."),
  copilotW3RunCost: limitation(
    "Copilot reports premium-request multipliers and nano-AI units, not USD. The result cost_usd remains null and is never computed from those values.",
    "2026-11-09: installed @github/copilot 1.0.103 copilot-sdk/generated/session-events.d.ts UsageGetMetricsResult.totalPremiumRequestCost is premium request cost; UsageMetricsModelMetricRequests.cost is a multiplier; totalNanoAiu is accumulated nano-AI units. cli-main.js Bbn reports premiumRequests. The 1.0.85 generated/rpc.d.ts uses the same token/request metric units.",
    "cost_usd is null; Copilot reports no USD-denominated cost", "tests/copilot-parity.test.ts"),
  cursorW4RunPlaywright: limitation(
    "Cursor resolves MCP servers only from configuration files, the account root's mcp.json and the project root's .cursor/mcp.json; the agent CLI names no per-run server flag or variable, so a Playwright server cannot ride one run.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offset 240051 resolves userConfigPath join(homedir(), \".cursor\", \"mcp.json\") and projectConfigPath join(s, \".cursor\", \"mcp.json\"); offset 251838 prints \"Configure servers in .cursor/mcp.json or ~/.cursor/mcp.json, or install a plugin that ships an MCP server\"; the option table has no server flag",
    "--enable-playwright-mcp is supported only by", "tests/cursor-run-parity.test.ts"),
  cursorW4RunExperimentMcp: limitation(
    "An experiment probe server must attach to one isolated run; Cursor resolves MCP servers only from the account and project mcp.json files a hermetic run excludes, and no flag names a server, so the probe cannot ride the command.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 240051 and 681435 (mcp.json file-only resolution); the option table has no server flag",
    "cursor has no verified experiment MCP mechanism", "tests/cursor-run-parity.test.ts"),
  cursorW4RunProject: limitation(
    "Cursor's project channels are instruction files and MCP servers (.cursor/rules, .cursor/commands, project mcp.json); its model overrides carry no per-tool permission rules, so there is no project setting source for codemux to pass through.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 178445 and 178703 read project and account .cursor/rules and .cursor/commands; 483.index.js sanitizeParametersForModelChange exposes model overrides without permission rules",
    "agents only; cursor has no project setting source mapping", "tests/cursor-run-parity.test.ts"),
  cursorW4RunServed: limitation(
    "Cursor's stream-json wire names no model on any event: assistant text deltas, per-call usage events, and the closing result line all omit a model field, so the served model cannot be observed.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offset 583967 result writer prints type result with session_id and usage but no model field; the per-call usage events carry model_call_id and token counters only (src/result-envelope/cursor.ts evidence)",
    "served_model: null", "tests/cursor-run-parity.test.ts"),
  cursorW4RunBudget: limitation(
    "Cursor enforces spend limits in the account backend; the agent CLI exposes no per-run spend flag.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offset 926579 renders spendLimitUsage individualLimit, limitType and pooledLimit values from the account; the option table carries no spend cap",
    "cursor has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  cursorW4RunCost: limitation(
    "Cursor's per-call usage events report token counters only; no event or result line carries a dollar cost, so cost_usd stays null.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js per-call usage events carry inputTokens, outputTokens, cacheReadTokens and cacheWriteTokens only (src/result-envelope/cursor.ts evidence); the result line adds no cost field",
    "cost_usd: null", "tests/cursor-run-parity.test.ts"),
  cursorW4CheckHermetic: limitation(
    "Cursor's instruction channels resolve from the account root under the real home and the project's .cursor tree; the paired check cannot plant an isolated channel set, so a hermetic instruction check cannot run.",
    "2026-11-09: src/hermetic-check-channels.ts cursor is channel-less; installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 178180 and 178445 read join(homedir(), \".cursor\", \"rules\") and join(homedir(), \".cursor\", \"commands\")",
    "cursor does not support a hermetic instruction check", "tests/check-hermetic-channels.test.ts"),
  cursorW4SessionInterrupt: limitation(
    "Cursor sessions run one --print process per turn with the prompt on stdin; the stream-json wire exposes no cancel or interrupt frame, so no verified channel reaches into a turn.",
    "2026-11-09: src/session/cursor-session.ts capability declaration; installed cursor-agent 2026.11.05-86047df 1706.index.js stream event vocabulary carries no interrupt request",
    "--turn-timeout requires an agent whose sessions support interrupt", "tests/cursor-session.test.ts"),
  cursorW4SessionPermissionPolicyDeny: limitation(
    "Cursor's headless loop answers interaction queries itself and exposes no permission-prompt channel or native deny-rule configuration, so a deny policy has nothing to bind.",
    "2026-11-09: src/session/cli-agents.ts cursor approvals note (ask-question \"Questions skipped in headless mode\", switch-mode \"Switch mode requires approval\", 1706.index.js offset 766086, 2026.11.05); no deny-rule schema in the settings surface",
    "--permission-policy deny is unavailable for 'cursor'", "tests/cursor-session.test.ts"),
  cursorW4SessionPlaywright: limitation(
    "Cursor resolves MCP servers only from the account and project mcp.json files; a session cannot carry a Playwright server its turns would load.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 240051 and 681435 (mcp.json file-only resolution)",
    "--enable-playwright-mcp is supported only by", "tests/cursor-session.test.ts"),
  cursorW4SessionProject: limitation(
    "Cursor's project channels are instruction files and MCP servers; there is no project permission-rule source for a session to pass through.",
    "2026-11-09: installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 178445 and 178703 (.cursor/rules and .cursor/commands reads); no permission-rule schema in the settings surface",
    "--experiment-project-settings applies to the", "tests/cursor-session.test.ts"),
  cursorW4SessionHermetic: limitation(
    "Cursor loads rules, commands and servers from the account root under the real home with no relocation carrier, so a session-lifetime private home cannot carry the harness state.",
    "2026-11-09: src/session/cli-agents.ts cursor hermetic note; installed cursor-agent 2026.11.05-86047df 1706.index.js offsets 178180, 178445 and 240051 (account-root channel reads)",
    "cursor has no verified hermetic mode for sessions", "tests/cursor-session.test.ts"),
  droidW4RunPlaywright: limitation(
    "Droid resolves MCP servers from watched configuration files; the settings schema has no MCP server key and the CLI names no per-run server flag, so a Playwright server cannot ride one run.",
    "2026-11-09: installed droid 0.221.0 bundle settings schema ne=o({sessionDefaultSettings, missionOrchestratorModel, ..., mcpPolicy, ...}) carries no mcpServers key; MCP servers resolve from the mcpConfigFilePaths watched files; the exec option table has no server flag",
    "--enable-playwright-mcp is supported only by", "tests/droid-run-parity.test.ts"),
  droidW4RunExperimentMcp: limitation(
    "An experiment probe server must attach to one isolated run; droid resolves MCP servers from operator configuration files a hermetic run excludes, and no flag names a server, so the probe cannot ride the command.",
    "2026-11-09: installed droid 0.221.0 bundle settings schema (no mcpServers key) and mcpConfigFilePaths watched-file resolution; the exec option table has no server flag",
    "droid has no verified experiment MCP mechanism", "tests/droid-run-parity.test.ts"),
  droidW4RunProject: limitation(
    "Droid's runtime settings select models and effort but carry no permission-rule schema, and its project channels are guideline files only, so there is no project setting source for codemux to pass through.",
    "2026-11-09: installed droid 0.221.0 bundle settings schema ne=o({...}) has no permissions key; the project guideline channels are the CLAUDE.md and AGENTS.md files and the .factory directories (src/adapters/droid.ts hermetic evidence)",
    "agents only; droid has no project setting source mapping", "tests/droid-run-parity.test.ts"),
  droidW4RunServed: limitation(
    "Droid's one JSON result object carries the answer, usage, and session id but no model name, so the served model cannot be observed.",
    "2026-11-09: installed droid 0.221.0 bundle offset 153812787 result builder {type:\"result\", ..., result:t.finalText, session_id:t.sessionId, usage:s} has no model field",
    "served_model: null", "tests/droid-run-parity.test.ts"),
  droidW4RunBudget: limitation(
    "Droid exposes no spend limit; the root and exec option tables and the settings schema carry no budget key, and the binary's strings contain no spend-limit surface.",
    "2026-11-09: installed droid 0.221.0 --help and exec --help option tables; settings schema ne=o({...}) without a budget key; bundle strings contain no budget or spend-limit reader",
    "droid has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  droidW4RunCost: limitation(
    "Droid's JSON result object reports token counters only; no cost field exists on the wire, so cost_usd stays null.",
    "2026-11-09: installed droid 0.221.0 bundle offset 153812787 result builder carries usage without a cost field",
    "cost_usd: null", "tests/droid-run-parity.test.ts"),
  droidW4SessionInterrupt: limitation(
    "Droid sessions run one exec process per turn with the prompt on stdin; no verified channel reaches into the process, and the one JSON result object carries no interrupt request.",
    "2026-11-09: src/session/droid-session.ts capability declaration; installed droid 0.221.0 exec result object (offset 153812787) and stream surface carry no interrupt frame",
    "--turn-timeout requires an agent whose sessions support interrupt", "tests/droid-session.test.ts"),
  droidW4SessionPermissionPolicyDeny: limitation(
    "Droid fixes autonomy at spawn through --auto and its one JSON result object carries no permission request, so a deny policy has no channel to bind.",
    "2026-11-09: src/session/cli-agents.ts droid approvals note (autonomy fixed at spawn via --auto, one json result object, droid 0.221.0); the settings schema has no deny-rule key",
    "--permission-policy deny is unavailable for 'droid'", "tests/droid-session.test.ts"),
  droidW4SessionPlaywright: limitation(
    "Droid resolves MCP servers from watched configuration files only; a session cannot carry a Playwright server its turns would load.",
    "2026-11-09: installed droid 0.221.0 bundle settings schema (no mcpServers key) and mcpConfigFilePaths watched-file resolution",
    "--enable-playwright-mcp is supported only by", "tests/droid-session.test.ts"),
  droidW4SessionProject: limitation(
    "Droid's runtime settings carry no permission-rule schema and its project channels are guideline files, so there is no project setting source for a session to pass through.",
    "2026-11-09: installed droid 0.221.0 bundle settings schema ne=o({...}) has no permissions key; project guideline channels are instruction files only",
    "--experiment-project-settings applies to the", "tests/droid-session.test.ts"),
  gooseW4RunNoWeb: limitation(
    "Goose gates its tools through permission rules in its configuration directory's permission.yaml; no run flag or environment variable denies the web tools for one run.",
    "2026-11-09: installed goose 1.50.1 run --help and session --help option tables carry no tool-denial flag; permission rules resolve only from the configuration directory's permission.yaml",
    "agents only; goose keeps its own web tools", "tests/adapters-goose.test.ts"),
  gooseW4RunProject: limitation(
    "Goose's project channel is its .goosehints guidance; permission rules live only in the configuration directory's permission.yaml, so there is no project setting source for codemux to pass through.",
    "2026-11-09: installed goose 1.50.1 load_hints.rs project hints; permission rules resolve only from the configuration directory's permission.yaml",
    "agents only; goose has no project setting source mapping", "tests/adapters-goose.test.ts"),
  gooseW4RunBudget: limitation(
    "Goose exposes no dollar spend limit; its run flags carry extensions and timeouts, and its configuration schema has no budget key.",
    "2026-11-09: installed goose 1.50.1 run --help option table; the configuration schema keys carry no spend cap",
    "goose has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  gooseW4SessionInterrupt: limitation(
    "Goose sessions run one run process per turn; GOOSE_MODE bounds the whole turn at spawn and the output object carries no interrupt request, so no verified channel reaches into a turn.",
    "2026-11-09: src/session/cli-agents.ts goose approvals note (GOOSE_MODE bounds the turn at spawn, run JSON output carries no request frame, 1.50.1)",
    "--turn-timeout requires an agent whose sessions support interrupt", "tests/goose-session.test.ts"),
  gooseW4SessionPermissionPolicyDeny: limitation(
    "Goose bounds every turn at spawn through GOOSE_MODE and its output object carries no permission request; the permission.yaml deny rules belong to the operator's configuration directory, which a session does not own.",
    "2026-11-09: src/session/cli-agents.ts goose approvals note (GOOSE_MODE bounds the turn, no request frame, 1.50.1); permission rules resolve only from the configuration directory's permission.yaml",
    "--permission-policy deny is unavailable for 'goose'", "tests/goose-session.test.ts"),
  gooseW4SessionProject: limitation(
    "Goose's project channel is .goosehints guidance and its permission rules live in the operator's configuration directory, so there is no project setting source for a session to pass through.",
    "2026-11-09: installed goose 1.50.1 load_hints.rs project hints; permission rules resolve only from the configuration directory's permission.yaml",
    "--experiment-project-settings applies to the", "tests/goose-session.test.ts"),
} as const;
