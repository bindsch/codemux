import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectSettingsRequest } from "./claude-project-settings.js";
import { UsageRefusalError } from "./validation.js";

// cli-v3.0.74, read 2026-11-09: project PreToolUse hooks can deny calls.
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/hooks/hook-file-config.ts#L17-L43
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/hooks/hook-file-hooks.ts#L577-L605
// Private HOME/config isolates global hooks while native project discovery stays on.
export function validateClineProjectSettings(request: ProjectSettingsRequest): void {
  const refuse = (reason: string): never => { throw new UsageRefusalError(`--experiment-project-settings ${reason}`); };
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  if (request.autonomy !== "low") refuse("requires --auto low for cline so native project hooks remain observable");
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  if (request.passthroughEnv?.some((name) => name.startsWith("CLINE_") || name === "HOME")) {
    refuse("cannot be combined with Cline storage or HOME passthrough overrides");
  }
  // main.ts resolves the workspace to the nearest repository root; require that
  // root to be the explicit fixture directory, so ancestor hooks cannot enter.
  // https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/utils/helpers.ts#L43-L54
  const cwd = realpathSync(request.cwd);
  let directory = cwd;
  for (;;) {
    if (lstatSync(join(directory, ".git"), { throwIfNoEntry: false })) {
      if (directory !== cwd) refuse("requires --cwd at the cline fixture repository root");
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
