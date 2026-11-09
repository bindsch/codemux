import { limitation } from "./features.js";
import { AGY_EXPERIMENT_LIMITATION } from "../agy-experiment-run.js";
import { OPENHANDS_EXPERIMENT_LIMITATION } from "../openhands-experiment-run.js";

/** Closed harness limitations for the W2 agents (openhands, qwen, agy),
 * each with dated upstream evidence and the refusal that fires today. */

const OPENHANDS_ARGPARSE =
  "openhands 1.16.0 (openhands-1.16.0.dist-info/METADATA, uv tools) " +
  "openhands_cli/argparsers/main_parser.py: the parser's full option list " +
  "is --version/-v, -t/--task, -f/--file, the resume args, --headless, " +
  "--json, the confirmation group, --exit-without-confirmation, and the " +
  "env-override args";

export const W2_RUN_LIMITATIONS = {
  openhandsExperiment: limitation(OPENHANDS_EXPERIMENT_LIMITATION.reason, OPENHANDS_EXPERIMENT_LIMITATION.evidence,
    OPENHANDS_EXPERIMENT_LIMITATION.refusal, "tests/openhands-experiment-run.test.ts"),
  agyExperiment: limitation(AGY_EXPERIMENT_LIMITATION.reason, AGY_EXPERIMENT_LIMITATION.evidence,
    AGY_EXPERIMENT_LIMITATION.refusal, "tests/agy-experiment-run.test.ts"),
  openhandsTools: limitation(
    "OpenHands 1.16.0 headless mode has no tool selection surface: the parser carries no tool flag, and --headless itself selects the NeverConfirm policy (textual_app.py: headless or always_approve), so every headless run auto-approves every action with no tool allowlist to restore.",
    `2026-11-09: ${OPENHANDS_ARGPARSE}; openhands_cli/tui/textual_app.py NeverConfirm selection`,
    "openhands cannot remove its built-in tools", "tests/openhands.test.ts"),
  openhandsServed: limitation(
    "OpenHands 1.16.0's --json event stream names no served model on any event: the JSONL vocabulary reports conversation and action events, and the model identity exists only as the requested LLM_MODEL the environment carried. The result envelope keeps served_model null.",
    `2026-11-09: ${OPENHANDS_ARGPARSE} (--json streams JSONL events); src/result-envelope/openhands.ts parses the event stream and no event carries a model field`,
    "served_model: null", "tests/openhands.test.ts"),
  openhandsUsage: limitation(
    "OpenHands 1.16.0 keeps token usage and cost accounting in the remote ConversationState, and the CLI's --json event stream exposes none of it, so the result envelope reports no usage block rather than inventing one.",
    "2026-11-09: openhands 1.16.0 openhands_cli --json JSONL event stream carries no usage or cost event; ConversationState stats resolve server-side (openhands_cli stores); src/result-envelope/openhands.ts",
    "usage: omitted (OpenHands reports no tokens on the local wire)", "tests/result-envelope-parity.test.ts"),
  openhandsCost: limitation(
    "OpenHands 1.16.0 reports no dollar cost on the local wire: usage and cost accounting live in the remote ConversationState, and the JSONL event stream carries neither.",
    "2026-11-09: openhands 1.16.0 --json JSONL event stream (no cost event); ConversationState stats resolve server-side; src/result-envelope/openhands.ts",
    "cost_usd: null", "tests/result-envelope-parity.test.ts"),
  openhandsBudget: limitation(
    "OpenHands 1.16.0 exposes no spend limit: the parser's whole option list carries no budget flag, and the env-override surface reads only the LLM trio.",
    `2026-11-09: ${OPENHANDS_ARGPARSE}; agent_store.py LLMEnvOverrides.from_env reads exactly LLM_API_KEY, LLM_BASE_URL, LLM_MODEL`,
    "openhands has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  qwenCost: limitation(
    "Qwen 0.24.0's stream-json wire reports usage as usageMetadata token counters only; no event or result frame carries a dollar cost, and the package contains no cost symbol, so cost_usd stays null.",
    "2026-11-09: @qwen-code/qwen-code 0.24.0 package (package.json); the result frames carry usageMetadata token counts; grep over every chunk for total_cost, cost_usd, totalCost, and costUSD finds no symbol",
    "cost_usd: null", "tests/qwen-run-parity.test.ts"),
  qwenBudget: limitation(
    "Qwen 0.24.0 exposes no dollar spend limit: the CLI option table and the settings schema carry no budget key, and the only budget strings in the package are an internal build-test wall-clock budget and --mcp-client-budget, a tool-call time budget.",
    "2026-11-09: @qwen-code/qwen-code 0.24.0 chunk-BSIOCNDK.js option table (no spend flag); settings schema in chunk-VPFKSRAB.js carries no budget key; chunk-HWKWZSZY.js --budget strings belong to the internal build-test command (wall-clock seconds)",
    "qwen has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  qwenProject: limitation(
    "Qwen 0.24.0's safe mode — which codemux always passes, as the whole isolation claim — empties every settings-sourced permission rule (permissions.deny and tools.exclude are dropped at merge), so a Workspace-scope settings file cannot reach a run codemux launches. Codemux never launches qwen outside safe mode, so no project-settings passthrough exists to observe.",
    "2026-11-09: @qwen-code/qwen-code 0.24.0 chunk-HWKWZSZY.js offset 2085997: mergedDeny spreads bareMode||safeMode ? [] : settings.permissions?.deny and the same for settings.tools?.exclude, while argv excludeTools still merge; SettingScope.Workspace exists (chunk-VPFKSRAB.js) but its rules cannot survive safe mode; src/adapters/qwen.ts always passes --safe-mode",
    "qwen has no project setting source mapping", "tests/experiment-project-settings.test.ts"),
  agyNoneEffort: limitation(
    "Agy's reasoning-effort vocabulary is low, medium, high, xhigh, and max; no none level exists, so an explicit none request is refused while an omitted effort stays the harness default.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) offset 61283926: 'Reasoning effort for the current CLI session (low|medium|high|xhigh|max)'; src/adapters/base-validate.ts effort gate",
    "agy does not support reasoning effort 'none'", "tests/cli-runtime-options.test.ts"),
  agyServed: limitation(
    "Agy's print-mode result envelope carries status, response, error, and usage token counts — no model field on the envelope or any stream frame, so the served model cannot be observed.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) result envelope field set pinned by the official headless docs and the binary's JSON tags (src/result-envelope/agy.ts); no model key on any frame",
    "served_model: null", "tests/result-envelope-agy.test.ts"),
  agyPlaywright: limitation(
    "The carrier is in-tree: every sandboxed run's private probe home carries the planted ~/.gemini/config/mcp_config.json with the trust-checked Playwright stdio server (src/agy-playwright-mcp.ts, tests/agy-playwright-mcp.test.ts), and the adapter refuses the flag without scode. The shared activation — the PLAYWRIGHT_MCP_AGENTS entry and the run-command gate — rides scratch/fix/w2-playwright.patch; until it lands, the CLI keeps refusing the flag for agy.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) strings 'Global Configuration: ~/.gemini/config/mcp_config.json' and the mcp subcommands note ('managing MCP servers in your user-level mcp_config.json', stdio and HTTP both); src/adapters/agy.ts prepareRun planting and the no-sandbox refusal; src/mcp.ts PLAYWRIGHT_MCP_AGENTS omits agy",
    "--enable-playwright-mcp is supported only by", "tests/agy-playwright-mcp.test.ts"),
  openhandsPlaywright: limitation(
    "The carrier is in-tree: a hermetic run's private persistence dir carries the planted mcp.json with the trust-checked Playwright stdio server (src/openhands-mcp.ts, tests/openhands-mcp.test.ts), the env prefix pins OPENHANDS_PERSISTENCE_DIR at that dir, and the adapter refuses the flag without --hermetic (a plain run shares the operator's persistence dir, and planting there would outlive the run). The shared activation — the PLAYWRIGHT_MCP_AGENTS entry and the hermetic-combination gate's exception — rides scratch/fix/w2-playwright.patch.",
    "2026-11-09: openhands 1.16.0 openhands_cli/locations.py MCP_CONFIG_FILE='mcp.json' and mcp/mcp_utils.py _get_mcp_config_path (get_persistence_dir()/mcp.json; the agent's own error help names ~/.openhands/mcp.json); src/adapters/openhands.ts prepareRun planting and the non-hermetic refusal; src/mcp.ts PLAYWRIGHT_MCP_AGENTS omits openhands and src/run-command.ts:240 refuses hermetic+playwright generically",
    "--enable-playwright-mcp is supported only by", "tests/openhands-mcp.test.ts"),
  agyCost: limitation(
    "Agy's result envelope reports token counters only; the only cost symbol in the binary is an internal telemetry protobuf (jetski_cortex_pb CostCategory.estimated_cost_usd) that the stream wire never emits, so cost_usd stays null.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) result envelope usage fields (input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens; src/result-envelope/agy.ts); estimated_cost_usd appears only in .exa.jetski_cortex_pb descriptors (offset 65075991), never on the CLI wire",
    "cost_usd: null", "tests/result-envelope-agy.test.ts"),
  agyBudget: limitation(
    "Agy 1.5.3 exposes no dollar spend limit: the flag surface (--model, --effort, --mode, --input-format, --output-format, --plugin) carries no budget flag, and the binary's budget strings are a thinking config field and an internal rules-engine token budget.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) flag surface (usage strings, offset 58711175); thinking_budget (offset 59500178) and rules-token-budget (offset 59664559) are the only budget symbols — neither is a spend cap",
    "agy has no spend limit flag; --max-budget-usd is unsupported", "tests/cli-run-budget.test.ts"),
  agyProvider: limitation(
    "Agy authenticates through a Google account and a fixed provider set; the binary's provider enums are Google Vertex, Google Gemini, and OpenAI Vertex, and no base-url or api-key flag exists for the agent's model — the only baseUrl and api_key fields belong to MCP server definitions.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) offset 60213882 (API_PROVIDER_GOOGLE_VERTEX, API_PROVIDER_GOOGLE_GEMINI, API_PROVIDER_OPENAI_VERTEX), offset 58614308 (api-key/api_key/baseUrl as MCP server fields); the auth token lives at .gemini/antigravity-cli/antigravity-oauth-token",
    "agy does not support a provider override", "tests/provider-override.test.ts"),
  agyOutputCap: limitation(
    "Agy has no provider override surface at all — its model providers are the fixed Google-account set — so no output-token cap can ride one.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) provider enums (offset 60213882); no base-url or api-key flag for the agent's model",
    "agy does not support a provider override", "tests/provider-override.test.ts"),
  agyContextCap: limitation(
    "Agy has no provider override surface at all — its model providers are the fixed Google-account set — so no context-token cap can ride one.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) provider enums (offset 60213882); no base-url or api-key flag for the agent's model",
    "agy does not support a provider override", "tests/provider-override.test.ts"),
  agyWeb: limitation(
    "Agy's web tools are core tools with no per-run denial flag: the flag surface carries no tool or web switch, so a run cannot deny web_search for itself.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) flag surface (--model, --effort, --mode, --input-format, --output-format, --plugin; usage strings offset 58711175); web_search is a core tool (offset 58908552)",
    "agents only; agy keeps its own web tools", "tests/cli-run-refusals.test.ts"),
  agyProject: limitation(
    "Agy's project channels are instruction rule files only — GEMINI.md, AGENTS.md, and .agents/rules/*.md walked up to the repository root — and its settings (modelProvider, mcpServers, hooks, rules.json) resolve under ~/.gemini in the operator's home, so there is no project setting source for codemux to pass through.",
    "2026-11-09: installed ~/.local/bin/agy (1.5.3) offsets 62105582 and 63285886 (rule-discovery text: Directory-Based Rules GEMINI.md/AGENTS.md and .agents/rules/*.md walked up from the working directory); settings.json and ~/.gemini/config resolution (offsets 59231159, 59574146); no home-relocation variable exists (grep for GEMINI_CLI_HOME, AGY_HOME, ANTIGRAVITY_HOME: no hits)",
    "agy has no project setting source mapping", "tests/experiment-project-settings.test.ts"),
} as const;
