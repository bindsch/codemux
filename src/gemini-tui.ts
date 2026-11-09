/** A TUI settings mirror lives until the interactive process finishes.
 * Both shared launch paths must call cleanup in finally; until wired,
 * GeminiAdapter.validateTuiRequest explicitly refuses settings requests. */
import type { GeminiAdapter } from "./adapters/gemini.js";
import type { AutonomyLevel, ReasoningEffort, RunRequest } from "./types.js";
import { UsageRefusalError } from "./validation.js";

export function prepareGeminiTuiLaunch(adapter: GeminiAdapter, input: {
  model?: string; cwd: string; autonomy: AutonomyLevel; effort?: ReasoningEffort;
  passthroughEnv?: readonly string[]; enablePlaywrightMcp?: boolean; sandboxed?: boolean; printOnly?: boolean;
}) {
  if (input.enablePlaywrightMcp && !input.sandboxed) throw new UsageRefusalError("--enable-playwright-mcp requires --sandbox");
  adapter.validateTuiSettingsRequest(input.model, input.cwd, input.autonomy, input.effort,
    input.passthroughEnv, input.enablePlaywrightMcp);
  const request: RunRequest = { agent: "gemini", prompt: "interactive launch", model: input.model,
    cwd: input.cwd, autonomy: input.autonomy, effort: input.effort, passthroughEnv: input.passthroughEnv,
    enablePlaywrightMcp: input.enablePlaywrightMcp, sandboxed: input.sandboxed };
  const context = adapter.prepareRun(request, undefined, undefined, { printOnly: input.printOnly });
  try {
    const command = adapter.buildRunCommand(request, context);
    if (command.at(-2) !== "-p" || command.at(-1) !== "") throw new Error("Gemini TUI requires the empty headless prompt suffix");
    command.splice(-2, 2);
    return { command, env: adapter.getRunEnv(request, context), playwrightCheck: context.playwrightMcpCheck,
      cleanup: () => adapter.cleanupRunSync(context) };
  } catch (error) { adapter.cleanupRunSync(context); throw error; }
}
