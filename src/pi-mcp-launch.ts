import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "./run-context.js";
import type { RunRequest } from "./types.js";
import { buildPlaywrightSandboxMcp } from "./mcp.js";
import { createPiHermeticAgentDir, type PiProviderAgentDir } from "./pi-provider.js";
import { createPiMcpStdioTransport } from "./pi-mcp-stdio.js";
import { installPiMcpExtension } from "./pi-mcp-extension.js";
import type { PiExperimentRun } from "./pi-experiment-run.js";

export interface PiMcpRunContext extends RunContext {
  piMcpExtension?: { path: string; directory: PiProviderAgentDir };
  experimentPi?: PiExperimentRun;
}

/** Self-contained ESM: a compiled codemux executable does not depend on
 * TypeScript source files still existing beside it. */
export function piMcpExtensionSource(command: string, args: string[], name: string): string {
  return `import { spawn } from "node:child_process";\n` +
    `const createTransport = ${createPiMcpStdioTransport.toString()};\n` +
    `const install = ${installPiMcpExtension.toString()};\n` +
    `export default async function(pi) {\n` +
    `  const transport = createTransport(${JSON.stringify(command)}, ${JSON.stringify(args)}, spawn);\n` +
    `  await install(pi, transport, {name:${JSON.stringify(name)}, exclusive:false, record() {}});\n` +
    `}\n`;
}

export function preparePiPlaywright(
  request: RunRequest,
  context: PiMcpRunContext,
  realAgentDir: string,
  pathEnv: string,
  printOnly = false
): PiMcpRunContext {
  if (!request.enablePlaywrightMcp) return context;
  const mcp = buildPlaywrightSandboxMcp(request.sandboxed, {
    enabled: true, pathEnv, forbiddenRoot: request.cwd,
  });
  if (mcp.check === null) throw new Error("pi Playwright MCP requires a sandboxed trusted server");
  const config = JSON.parse(mcp.args[1]!) as { mcpServers: { playwright: { command: string; args: string[] } } };
  const directory = createPiHermeticAgentDir(realAgentDir, null, undefined, false, printOnly);
  try {
    const path = join(directory.path, "playwright.mjs");
    const server = config.mcpServers.playwright;
    if (!printOnly) writeFileSync(path, piMcpExtensionSource(server.command, server.args, "playwright"), { mode: 0o600 });
    return { ...context, piMcpExtension: { path, directory }, playwrightMcpCheck: mcp.check };
  } catch (error) { directory.finalize(); throw error; }
}
