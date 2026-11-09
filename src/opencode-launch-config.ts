import { buildPlaywrightSandboxMcp } from "./mcp.js";
import { UsageRefusalError } from "./validation.js";
import type { AutonomyLevel } from "./types.js";

/** A fresh primary agent prevents an operator's per-agent or deprecated mode
 * permissions from overriding the denial. Its rules merge after global rules.
 * Task is denied because a subagent has independent permission overrides. */
export function opencodeNoWebConfig(autonomy: AutonomyLevel = "read-only") {
  const agent = `codemux_noweb_${crypto.randomUUID().replaceAll("-", "")}`;
  const permission = {
    ...(autonomy === "read-only" ? { edit: "deny" } : {}),
    webfetch: "deny", websearch: "deny", task: "deny",
  };
  return { agent, config: { agent: { [agent]: { mode: "primary", permission } } } };
}

/** Reuse the shared binary trust check, then translate only the native MCP schema. */
export function opencodePlaywrightConfig(
  sandboxed: boolean | undefined,
  enabled: boolean | undefined,
  pathEnv: string,
  cwd?: string
) {
  const mcp = buildPlaywrightSandboxMcp(sandboxed, { enabled, pathEnv, forbiddenRoot: cwd });
  if (!mcp.check) return { config: {}, check: null };
  const source = JSON.parse(mcp.args[1]!) as {
    mcpServers: { playwright: { command: string; args: string[] } };
  };
  const server = source.mcpServers.playwright;
  if (/[{}]/.test(server.command)) {
    throw new UsageRefusalError("opencode Playwright MCP binary path cannot contain braces: native config substitutes {env:...} and {file:...}");
  }
  return {
    config: { mcp: { playwright: { type: "local", command: [server.command, ...server.args], enabled: true } } },
    check: mcp.check,
  };
}
