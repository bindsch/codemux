import type { KimiAdapter } from "./adapters/kimi.js";
import type { AutonomyLevel, ReasoningEffort } from "./types.js";

/** Own the private MCP configuration for the complete interactive child. */
export function prepareKimiTuiLaunch(adapter: KimiAdapter, options: {
  model?: string; cwd: string; autonomy?: AutonomyLevel; effort?: ReasoningEffort;
  passthroughEnv?: readonly string[]; enablePlaywrightMcp: boolean; sandboxed: boolean; printOnly?: boolean;
}) {
  const request = { ...options, agent: "kimi" as const, prompt: "codemux tui" };
  const context = adapter.prepareRun(request, undefined, undefined, { printOnly: options.printOnly });
  try {
    adapter.buildRunCommand(request, context);
    const home = context.kimiHermeticHome;
    const command = adapter.buildTuiCommand(options.model, options.autonomy);
    return {
      command: home === undefined ? command : ["env", `KIMI_CODE_HOME=${home.kimiHome}`, ...command],
      env: adapter.getTuiEnv(options.model, options.autonomy, options.effort),
      playwrightCheck: context.playwrightMcpCheck ?? null,
      cleanup: () => adapter.cleanupRunSync(context),
    };
  } catch (error) { adapter.cleanupRunSync(context); throw error; }
}
