import type { BaseAdapter } from "./base.js";
import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import { guardedWait } from "../process-runner.js";
import { validateWorkingDirectory } from "../validation.js";

export async function runInteractive(
  this: BaseAdapter,
  model?: string,
  cwd?: string,
  autonomy?: AutonomyLevel,
  effort?: ReasoningEffort,
  sandboxed = false,
  passthroughEnv: readonly string[] = [],
  enablePlaywrightMcp = false
): Promise<number> {
  if (sandboxed) {
    throw new Error(
      "BaseAdapter.runInteractive cannot attest an external sandbox; use the sandbox runner"
    );
  }
  const effectiveAutonomy = autonomy ?? "read-only";
  this.validateTuiRequest(
    model,
    cwd,
    effectiveAutonomy,
    effort,
    passthroughEnv,
    enablePlaywrightMcp
  );
  if (this.requiresSandboxForTuiAutonomy(effectiveAutonomy)) {
    throw new Error(
      `${this.id} cannot enforce '${effectiveAutonomy}' autonomy without an external sandbox`
    );
  }
  this.beforeLaunch();
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  const command = this.resolveExecutionCommand(this.buildTuiCommand(
    model,
    effectiveAutonomy,
    effort,
    false,
    enablePlaywrightMcp,
    workdir
  ), workdir);
  const env = this.buildExecutionEnv(
    this.getTuiEnv(model, effectiveAutonomy, effort, false, passthroughEnv),
    passthroughEnv
  );

  const proc = Bun.spawn(command, {
    cwd: workdir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env,
  });

  return await guardedWait(proc);
}
