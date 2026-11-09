import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectSettingsRequest } from "./claude-project-settings.js";
import type { RunRequest } from "./types.js";
import type { SandboxOptions } from "./sandbox.js";
import { UsageRefusalError, validateWorkingDirectory } from "./validation.js";

// Installed Copilot 1.0.85 app.js and 1.0.103 cli-main.js (2026-11-09):
// repo/local settings are .github/copilot/settings[.local].json. Help
// lists CLAUDE.md, GEMINI.md, AGENTS.md and .github instructions at cwd
// and git root. Refuse every ancestor config container conservatively.
const copilotAncestorNames = [".github", ".claude", ".mcp.json", "AGENTS.md", "CLAUDE.md", "GEMINI.md"];
const copilotProjectRedirects = ["COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "CLAUDE_CONFIG_DIR"];

export function validateCopilotProjectSettings(request: ProjectSettingsRequest): void {
  const refuse = (reason: string): never => {
    throw new UsageRefusalError(`--experiment-project-settings for copilot ${reason}`);
  };
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  if (request.autonomy !== "low" && request.autonomy !== "high") {
    refuse("requires --auto low or high; native deny rules take precedence over allow flags");
  }
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  for (const name of copilotProjectRedirects) {
    if (request.passthroughEnv?.includes(name)) refuse(`cannot be combined with --pass-env ${name}`);
  }
  const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
  for (let dir = dirname(cwd); ; dir = dirname(dir)) {
    for (const name of copilotAncestorNames) {
      const path = join(dir, name);
      try { lstatSync(path); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        refuse(`cannot inspect ancestor ${path}: ${code ?? "unknown error"}`);
      }
      refuse(`refuses ancestor project configuration at ${path}; only the working directory's project settings are authorized`);
    }
    if (dirname(dir) === dir) break;
  }
}

export function validateCopilotProjectSettingsRun(request: RunRequest): void {
  validateCopilotProjectSettings({
    agent: "copilot", hermetic: request.hermetic === true, sandbox: request.sandboxed === true,
    autonomy: request.autonomy ?? "read-only", cwd: request.cwd ?? process.cwd(),
    tools: request.tools, experimentMcp: request.experimentMcp, passthroughEnv: request.passthroughEnv,
  });
}

/** Block the operator's Copilot and compatibility config, then reallow
 * only this launch's home and provider/usage artifacts. The caller keeps
 * its existing blocks; the shared launch checks conflicts before spawn. */
export function applyCopilotProjectSandbox(
  options: SandboxOptions,
  sourceConfigDir: string,
  privateHome: string,
  artifactDirs: readonly string[] = []
): void {
  options.blockPaths = [...(options.blockPaths ?? []), sourceConfigDir,
    join(dirname(sourceConfigDir), ".claude"), join(dirname(sourceConfigDir), ".claude.json")];
  options.harnessStateDirs = [...(options.harnessStateDirs ?? []), privateHome, ...artifactDirs];
}
