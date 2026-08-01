import { resolveTrustedExecutable } from "./executable-security.js";

export interface PlaywrightMcpOptions {
  enabled?: boolean;
  binaryPath?: string | null;
  forbiddenRoot?: string;
}

export function getPlaywrightSandboxMcpArgs(
  sandboxed?: boolean,
  options: PlaywrightMcpOptions = {}
): string[] {
  const enabled = options.enabled ?? false;
  if (!sandboxed || !enabled) {
    return [];
  }

  const binaryPath = options.binaryPath !== undefined
    ? options.binaryPath
    : Bun.which("playwright-mcp", { PATH: process.env.PATH });
  if (!binaryPath) {
    throw new Error(
      "--enable-playwright-mcp requires a locally installed playwright-mcp binary"
    );
  }
  const resolvedBinary = resolveTrustedExecutable(
    binaryPath,
    "playwright-mcp",
    options.forbiddenRoot
  );

  const config = JSON.stringify({
    mcpServers: {
      playwright: {
        command: resolvedBinary,
        args: [],
      },
    },
  });
  return ["--mcp-config", config];
}
