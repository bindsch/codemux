import type { ClineAdapter } from "./adapters/cline.js";
import type { RunRequest } from "./types.js";
import type { SandboxOptions } from "./sandbox.js";

/** The native CLINE_MCP_SETTINGS_PATH carrier is shared with headless runs.
 * The caller retains this build's executable identity until the child starts.
 * cli-v3.0.74 config loader, read 2026-11-09:
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/mcp/config-loader.ts#L63-L105
 */
export function prepareClineTuiLaunch(adapter: ClineAdapter, input: Omit<RunRequest, "agent" | "prompt"> & { printOnly?: boolean }, sandbox?: SandboxOptions) {
  const request: RunRequest = { ...input, agent: "cline", prompt: "codemux tui" };
  if (!input.enablePlaywrightMcp || !input.sandboxed) throw new Error("cline MCP TUI preparation requires sandboxed Playwright");
  if (input.printOnly) sandbox = structuredClone(sandbox);
  const context = adapter.prepareRun(request, sandbox?.trust, sandbox, { printOnly: input.printOnly });
  try {
    const command = adapter.buildTuiCommand(input.model, input.autonomy, input.effort, true);
    return { command, env: adapter.getRunEnv(request, context), playwrightCheck: context.playwrightMcpCheck, sandboxOptions: sandbox,
      cleanup: () => adapter.cleanupRunSync(context) };
  } catch (error) { adapter.cleanupRunSync(context); throw error; }
}
