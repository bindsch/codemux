import type { BaseAdapter, RunContext } from "../adapters/base.js";
import type { ProviderOverride } from "../provider-override.js";
import { isCredentialEnvName, type SandboxOptions } from "../sandbox.js";
import type { AgentId, RunRequest } from "../types.js";
import { callerHarnessHomeAuthEnvironment } from "./harness-home.js";

/** Spawn preparation and every turn share this environment builder. */
export interface SessionEnvironmentBuilder {
  (context: RunContext | undefined): {
    runEnv: Record<string, string>;
    env: Record<string, string>;
  };
}

/** Resolve credentials after resume guards, using each launch's context. */
export function prepareSessionEnvironment({
  adapter, runLike, passthroughEnv, sandboxed, sandboxOptions, override, callerHomeAgent,
}: {
  adapter: BaseAdapter;
  runLike: RunRequest;
  passthroughEnv: string[];
  sandboxed: boolean;
  sandboxOptions: SandboxOptions | undefined;
  override: ProviderOverride | null;
  callerHomeAgent?: AgentId;
}): { needsKeepEnvPreflight: boolean; buildSessionEnvironment: SessionEnvironmentBuilder } {
  // Scrubbing must preserve both provider overrides and credentials the
  // adapter injects. Resolve them here, after resume guards, so a missing
  // credential cannot replace the policy refusal for a foreign session.
  const nativeAuth = callerHomeAgent === undefined ? {} : callerHarnessHomeAuthEnvironment(callerHomeAgent, process.env);
  const needsKeepEnvPreflight = sandboxed &&
    (sandboxOptions?.scrubEnv === true || sandboxOptions?.trust === "untrusted") &&
    (override !== null || Object.keys({ ...nativeAuth, ...adapter.getEnv() }).some(isCredentialEnvName));
  const buildSessionEnvironment: SessionEnvironmentBuilder = (context) => {
    const runEnv = { ...nativeAuth, ...adapter.getRunEnv(runLike, context) };
    return { runEnv, env: adapter.buildExecutionEnv(runEnv, passthroughEnv) };
  };
  return { needsKeepEnvPreflight, buildSessionEnvironment };
}
