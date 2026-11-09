import { limitation, supported } from "./features.js";

export const CODEX_SESSION_TOOLS = supported("tests/session-codex-catalog.test.ts",
  "Native tool config is reapplied on fresh/resumed threads. Writable autonomy requires verified Codex >=0.166.0, a local model descriptor, and a sandbox-readable lifetime-scoped model_catalog_json file.");
export const CODEX_SESSION_PROJECT = supported("tests/session-codex-parity.test.ts",
  "The private native config grants project trust, startup retains repository documents/hooks, and the driver records project-settings mode on fresh/resumed threads.");
export const CODEX_SESSION_PLAYWRIGHT = supported("tests/session-codex-playwright-pin.test.ts",
  "Requires sandbox and low autonomy; the trust-checked server rides the app-server -c overrides, the spawn re-stats its binary, and the record carries the flag for the resume probe.");

export const AIDER_SESSION_PROJECT = limitation(
  "Aider 0.86.2 project configuration supplies CLI options, but has no native per-tool permission-rule schema for a project-settings experiment.",
  "2026-11-09: aider-chat 0.86.2 aider/args.py get_parser defines configargparse options; aider/main.py passes args.yes_always to InputOutput; aider/io.py confirm_ask has no project allow or deny rule lookup.",
  "--experiment-project-settings applies to the", "tests/session-aider-refusals.test.ts",
);
export const AIDER_SESSION_MCP = limitation(
  "Aider 0.86.2 has no MCP client, server configuration, or MCP tool registry; its optional Playwright scraper is not an MCP server.",
  "2026-11-09: aider-chat 0.86.2 aider/args.py disable-playwright controls scraper installation; aider/commands.py cmd_web calls Scraper; aider/models.py send_completion builds tools only from coder functions.",
  "--enable-playwright-mcp is supported only by", "tests/session-aider-refusals.test.ts",
);
