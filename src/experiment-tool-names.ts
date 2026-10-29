/** Codex codex-mcp/src/mcp/mod.rs: sanitize_responses_api_tool_name. */
export function sanitizeCodexToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_") || "_";
}
