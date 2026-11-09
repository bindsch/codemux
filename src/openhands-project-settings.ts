/**
 * The openhands arm of `--experiment-project-settings`: a hermetic run
 * that loads the repository's own `.openhands` (hooks.json at 1.16.0 —
 * `HookConfig.load` reads `{working_dir}/.openhands/hooks.json` before
 * `~/.openhands/hooks.json`, sdk/hooks/config.py, read 2026-11-09), so
 * an experiment can observe the project's hook automation.
 *
 * The isolation trade: the private HOME (src/openhands-hermetic.ts)
 * empties the operator's own `~/.openhands` — settings, agent specs,
 * hooks — and the clean-cwd rule (assertCleanInstructionFiles), which a
 * plain hermetic run enforces against the working directory's
 * `.openhands`, is skipped here so the project's directory loads. Hooks
 * run commands, so the flag is an explicit opt-in for a repository the
 * operator built, and scode is required.
 *
 * No ancestor walk: openhands reads the working directory's
 * `.openhands` and the home's, and nothing above the working directory
 * (HookConfig.load's two search paths are the whole discovery), so
 * unlike the claude-family and gemini validators there is no ancestor
 * channel to refuse.
 */
import type { ProjectSettingsRequest } from "./claude-project-settings.js";
import { UsageRefusalError } from "./validation.js";

export function validateOpenhandsProjectSettings(request: ProjectSettingsRequest): void {
  const refuse = (message: string): never => {
    throw new UsageRefusalError(`--experiment-project-settings ${message}`);
  };
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  // Low keeps the run inside the scode grant list the project's hooks
  // execute under; a run's higher levels are the headless auto-approve
  // the private home cannot scope down, which is not the behavior an
  // experiment observing project automation wants to ride.
  if (request.autonomy !== "low") {
    refuse("requires --auto low; higher levels auto-approve every action in headless mode");
  }
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  if (request.passthroughEnv?.includes("HOME")) {
    refuse("cannot be combined with --pass-env HOME: the run gets its own private home");
  }
}
