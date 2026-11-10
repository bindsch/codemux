/** Pi launch artifacts whose lifetime belongs to the caller. */
import { isAbsolute, join, resolve } from "node:path";
import { mkdirSync, symlinkSync } from "node:fs";
import type { PiAdapter } from "./adapters/pi.js";
import type { ExecutableCheck } from "./executable-security.js";
import type { AutonomyLevel, ReasoningEffort, RunRequest } from "./types.js";
import type { ProviderOverride } from "./provider-override.js";
import { PI_AGENT_DIR_ENV, PI_PROVIDER_KEY_ENV, writePiProviderAgentDir } from "./pi-provider.js";

/** Matches pi 0.85.1 dist/core/session-manager.js getDefaultSessionDirPath.
 * Read 2026-11-09: `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`.
 * --session-dir keeps plain override transcripts in the normal native store,
 * even though models.json lives in a different private directory each turn. */
export function piNativeSessionDir(agentDir: string, cwd: string): string {
  if (!isAbsolute(agentDir) || !isAbsolute(cwd)) {
    throw new Error("pi session paths must be absolute");
  }
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", encoded);
}

/** The native session manager selects its cwd subdirectory beneath this
 * link. Finalization removes the private link, never the transcript store. */
export function preparePiTuiProviderEnvironment(
  realAgentDir: string,
  override: ProviderOverride & { baseUrl: string; apiKey: string },
  model: string
): { env: Record<string, string>; finalize: () => void } {
  const directory = writePiProviderAgentDir(realAgentDir, override, model);
  try {
    const sessions = join(realAgentDir, "sessions");
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    symlinkSync(sessions, join(directory.path, "sessions"), "dir");
    return {
      env: { [PI_AGENT_DIR_ENV]: directory.path, [PI_PROVIDER_KEY_ENV]: override.apiKey },
      finalize: directory.finalize,
    };
  } catch (error) {
    directory.finalize();
    throw error;
  }
}

export interface PiTuiLaunch {
  command: string[];
  env: Record<string, string>;
  playwrightCheck?: ExecutableCheck | null;
  cleanup(): void;
}

/** Uses the run path's private models.json without keeping adapter-global
 * state. Both interactive launch paths must call cleanup in their finally. */
export function preparePiTuiLaunch(
  adapter: PiAdapter,
  input: {
    model?: string;
    cwd: string;
    autonomy: AutonomyLevel;
    effort?: ReasoningEffort;
    passthroughEnv?: readonly string[];
    enablePlaywrightMcp?: boolean;
    sandboxed?: boolean;
  }
): PiTuiLaunch {
  const request: RunRequest = {
    agent: "pi",
    prompt: "interactive launch",
    model: input.model,
    cwd: input.cwd,
    autonomy: input.autonomy,
    effort: input.effort,
    passthroughEnv: input.passthroughEnv,
    enablePlaywrightMcp: input.enablePlaywrightMcp,
    sandboxed: input.sandboxed,
  };
  adapter.validateRunRequest(request);
  const context = adapter.prepareRun(request);
  try {
    const command = adapter.buildRunCommand(request, context);
    command.splice(1, 2); // Remove the fixed --print/--no-session prefix only.
    // Print runs read the json wire (lane AN1); the TUI keeps its own screen.
    const mode = command.findIndex((arg, index) => arg === "--mode" && command[index + 1] === "json");
    if (mode !== -1) command.splice(mode, 2);
    if (adapter.providerOverrideActive()) {
      command.push("--session-dir", adapter.nativeSessionDirectory(input.cwd, input.passthroughEnv));
    }
    return {
      command,
      env: adapter.getRunEnv(request, context),
      playwrightCheck: context.playwrightMcpCheck,
      cleanup: () => adapter.cleanupRunSync(context),
    };
  } catch (error) {
    adapter.cleanupRunSync(context);
    throw error;
  }
}
