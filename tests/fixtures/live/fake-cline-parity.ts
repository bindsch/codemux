// Synthetic Cline cli-v3.0.74 NDJSON; no provider or network access.
const prompt = await Bun.stdin.text();
const argv = process.argv.slice(2);
if (!argv.includes("--json") || argv.at(-1) !== " ") process.exit(23);
if (process.env.FIXTURE_TOOLS_NONE === "1") {
  const settings = await Bun.file(process.env.CLINE_GLOBAL_SETTINGS_PATH!).json();
  const mcp = await Bun.file(process.env.CLINE_MCP_SETTINGS_PATH!).json();
  if (!["run_commands", "editor", "spawn_agent", "skills", "fetch_web_content", "team_run_task"].every((name) => settings.disabledTools.includes(name)) ||
      settings.tools.web_search.enabled !== false || Object.keys(mcp.mcpServers).length !== 0 ||
      !argv.includes("codemux-override") || process.env.CLINE_SESSION_BACKEND_MODE !== "local") process.exit(24);
}
process.stdout.write(JSON.stringify({ type: "run_start", sessionId: "session_fixture" }) + "\n");
process.stdout.write(JSON.stringify({ type: "run_result", finishReason: "completed", text: prompt,
  model: { id: "configured-model", provider: "fixture" },
  usage: { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalCost: 0.25 },
}) + "\n");
