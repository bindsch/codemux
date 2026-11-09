import { buildPlaywrightSandboxMcp, type PlaywrightMcpOptions, type PlaywrightSandboxMcp } from "./mcp.js";

/** Installed 1.0.103 cli-main.js n1t consumes additionalMcpConfig as
 * inline JSON or @file. Its stdio registry adapter emits
 * {type:"stdio",command,args,tools:["*"]} (read 2026-11-09). */
export function buildCopilotPlaywrightMcp(
  sandboxed: boolean | undefined,
  options: PlaywrightMcpOptions
): PlaywrightSandboxMcp {
  const built = buildPlaywrightSandboxMcp(sandboxed, options);
  if (built.args.length === 0) return built;
  const config = JSON.parse(built.args[1]!) as {
    mcpServers: { playwright: { command: string; args: string[] } };
  };
  return {
    check: built.check,
    args: ["--additional-mcp-config", JSON.stringify({
      mcpServers: { playwright: { ...config.mcpServers.playwright, type: "stdio", tools: ["*"] } },
    })],
  };
}
