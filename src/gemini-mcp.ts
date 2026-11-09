import { buildPlaywrightSandboxMcp } from "./mcp.js";
import type { ExecutableCheck } from "./executable-security.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { experimentToolTimeoutSeconds } from "./experiment-mcp.js";

export interface GeminiMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/** The CLI's native settings.mcpServers carrier is passed unchanged to
 * discovery (Gemini 0.60.0 gemini-LUNNHKPJ.js loadCliConfig, 2026-11-09).
 * Trust checking uses the shared Playwright builder and keeps its exact
 * executable identity for the launcher's final check. */
export function geminiPlaywrightSettings(
  sandboxed: boolean | undefined,
  enabled: boolean | undefined,
  pathEnv: string,
  cwd?: string
): { servers: Record<string, GeminiMcpServer>; check: ExecutableCheck | null } {
  const result = buildPlaywrightSandboxMcp(sandboxed, { enabled, pathEnv, forbiddenRoot: cwd });
  if (result.check === null) return { servers: {}, check: null };
  const config = JSON.parse(result.args[1]!) as { mcpServers: Record<string, GeminiMcpServer> };
  return { servers: config.mcpServers, check: result.check };
}

/** Configuration only. Experiment recording additionally requires a relay
 * that verifies the model-bound content; this native server mapping alone
 * does not establish --experiment-mcp support. */
export function geminiExperimentServer(
  spec: ExperimentSpec,
  environment: NodeJS.ProcessEnv
): Record<string, GeminiMcpServer> {
  const env = Object.fromEntries(spec.env.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
  return { [spec.name]: {
    command: spec.command, args: [...spec.args], env,
    timeout: experimentToolTimeoutSeconds(spec) * 1000,
  } };
}
