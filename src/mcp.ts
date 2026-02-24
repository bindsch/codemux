export const PLAYWRIGHT_NO_SANDBOX_MCP_CONFIG = JSON.stringify({
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest", "--no-sandbox"],
  },
});

export function getPlaywrightSandboxMcpArgs(sandboxed?: boolean): string[] {
  if (!sandboxed) {
    return [];
  }

  if (process.env.CODEMUX_DISABLE_PLAYWRIGHT_NO_SANDBOX === "1") {
    return [];
  }

  return ["--mcp-config", PLAYWRIGHT_NO_SANDBOX_MCP_CONFIG];
}
