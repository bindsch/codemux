import type { BaseAdapter } from "./adapters/base.js";
import { runSandboxedWithStdin } from "./cli-runtime.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import type { AutonomyLevel, RunRequest, RunResult } from "./types.js";

export interface LaunchOptions {
  sandbox: boolean;
  sandboxPolicyOverrides?: SandboxPolicyOverrides;
  /** The autonomy the caller asked for; it selects the scode policy. */
  requestedAutonomy: AutonomyLevel;
  passthroughEnv: readonly string[];
  timeoutMs?: number;
  cwd?: string;
}

/**
 * Runs one validated request either under scode or directly, the way `run`
 * and `check` both do. The sandboxed path attests the boundary itself, so
 * it never goes through BaseAdapter.run.
 */
export async function launchRunRequest(
  adapter: BaseAdapter,
  request: RunRequest,
  options: LaunchOptions
): Promise<RunResult> {
  if (!options.sandbox) {
    return adapter.run(request);
  }
  const sandboxOptions = resolveSandboxOptionsForAgent(
    request.agent,
    options.requestedAutonomy,
    options.sandboxPolicyOverrides
  );
  adapter.validateRunRequest(request);
  adapter.beforeLaunch();
  adapter.prepareRun(request);
  adapter.prepareSandbox({
    sandboxTrust: sandboxOptions.trust,
    passthroughEnv: options.passthroughEnv,
  });
  const envArg = adapter.buildExecutionEnv(
    adapter.getRunEnv(request),
    options.passthroughEnv
  );
  return runSandboxedWithStdin(
    adapter.buildRunCommand(request),
    adapter.getStdinInput(request),
    options.cwd,
    envArg,
    options.requestedAutonomy,
    sandboxOptions,
    options.timeoutMs,
    adapter.getEnvOmissions()
  );
}
