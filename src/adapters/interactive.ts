import type { BaseAdapter } from "./base.js";
import type { AutonomyLevel, ReasoningEffort } from "../types.js";
import { guardedWait } from "../process-runner.js";
import { assertExecutablesUnchanged } from "../executable-security.js";
import { launchRedirectCheck } from "../cli-runtime.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";

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
  if (enablePlaywrightMcp) {
    // This entry point never sandboxes, and the Playwright server rides
    // the sandbox-scoped carrier only (review round 147): refuse the
    // option outright, before anything is built or spawned. Without this
    // the launch ran unsandboxed, attached no MCP configuration, and for
    // claude and zai still selected the user settings source in place of
    // --safe-mode.
    throw new UsageRefusalError("--enable-playwright-mcp requires --sandbox");
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
  const prepared = this.prepareTuiEnvironment(model, effectiveAutonomy, effort, false, passthroughEnv);
  try {
  const env = this.buildExecutionEnv(
    prepared.env,
    passthroughEnv
  );

  // The redirect target (OPENCODE_BIN_PATH) the gate resolved and probed
  // is re-statted beside the command's own positions (review round 331,
  // item 5), as on every other launch path. The check reads `env`, the
  // environment the child is spawned with below — the one that decides
  // whether the launcher execs a redirect at all — and never process.env,
  // which for an adapter with its own environment view can disagree (a
  // redirect visible to the child but absent here escaped both the pin
  // and the gate; review round 338, item 13).
  const redirectCheck = launchRedirectCheck(this.id, env, workdir);
  assertExecutablesUnchanged(command, this.id, undefined, redirectCheck === null ? [] : [redirectCheck]);
  // The spawn rides the wait itself (review round 223): guardedWait
  // installs its signal handlers before running it, so a SIGTERM or SIGHUP
  // cannot land between the spawn and the handlers and orphan the child.
  return await guardedWait(() => Bun.spawn(command, {
    cwd: workdir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env,
  }));
  } finally { prepared.finalize(); }
}
