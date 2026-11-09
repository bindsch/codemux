import { limitation } from "./features.js";

const AIDER_TEST = "tests/aider-run-parity.test.ts";
const AIDER_ANALYTICS_TEST = "tests/result-envelope-aider.test.ts";

export const AIDER_USAGE_EVIDENCE = "2026-11-09: aider-chat 0.86.2 aider/coders/base_coder.py show_usage_report emits prompt_tokens and completion_tokens without cache fields; calculate_and_show_tokens_and_cost handles provider cache semantics; aider/utils.py format_tokens rounds counts above 999.";

/** Installed aider-chat 0.86.2 source inspection, 2026-11-09. */
export const AIDER_RUN_LIMITATIONS = {
  served: limitation(
    "Aider 0.86.2 does not emit the provider response model; its banner and analytics name the configured model, with custom names redacted.",
    "2026-11-09: aider-chat 0.86.2 aider/analytics.py event sets main_model through _redact_model_name; aider/coders/base_coder.py send consumes content and usage without emitting completion.model.",
    "served_model: null", AIDER_ANALYTICS_TEST),
  budget: limitation(
    "Aider 0.86.2 records cost after each model response but exposes no dollar budget setting or pre-request spend-limit check.",
    "2026-11-09: aider-chat 0.86.2 aider/args.py get_parser has no dollar budget option; aider/coders/base_coder.py calculate_and_show_tokens_and_cost increments total_cost after send_completion.",
    "aider has no spend limit flag; --max-budget-usd is unsupported", AIDER_TEST),
  context: limitation(
    "Aider 0.86.2 max_input_tokens metadata is advisory: exceeding it asks whether to proceed, and yes-always bypasses that question. It cannot enforce a hard context-token cap.",
    "2026-11-09: aider-chat 0.86.2 aider/coders/base_coder.py check_tokens calls confirm_ask('Try to proceed anyway?'); aider/io.py confirm_ask returns the configured yes value; aider/models.py send_completion has no context-cap request parameter.",
    "CODEMUX_AIDER_PROVIDER_MAX_CONTEXT_TOKENS cannot be honored", AIDER_TEST),
  project: limitation(
    "Aider 0.86.2 project configuration supplies CLI options, but has no native per-tool permission-rule schema for a project-settings experiment.",
    "2026-11-09: aider-chat 0.86.2 aider/args.py get_parser defines configargparse options and yes-always; aider/main.py passes args.yes_always to InputOutput; aider/io.py confirm_ask has no project allow or deny rule lookup.",
    "--experiment-project-settings applies to the", AIDER_TEST),
  experimentMcp: limitation(
    "Aider 0.86.2 has no MCP client, server configuration, or MCP tool registry; its model functions come from the selected coder.",
    "2026-11-09: aider-chat 0.86.2 aider/args.py and aider/main.py expose no MCP carrier; aider/coders/base_coder.py functions defaults to None; aider/models.py send_completion builds tools only from coder functions.",
    "aider has no verified experiment MCP mechanism", AIDER_TEST),
  playwrightMcp: limitation(
    "Aider 0.86.2 has no MCP client, server configuration, or MCP tool registry; its optional Playwright scraper is not an MCP server.",
    "2026-11-09: aider-chat 0.86.2 aider/args.py disable-playwright controls scraper installation; aider/commands.py cmd_web calls Scraper; aider/models.py send_completion builds tools only from coder functions.",
    "--enable-playwright-mcp is supported only by", AIDER_TEST),
} as const;
