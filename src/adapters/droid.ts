import { BaseAdapter } from "./base.js";
import { assertNoDroidProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

// `--tools none`: droid's tool controls are `--only-tools`/`--add-tools`/
// `--remove-tools` with validated IDs ("Use only tool IDs or
// MCP:<server>[/<tool>] selectors", droid 0.186.0 `exec --help`; the flags
// are unchanged in the installed 0.221.0). An empty `--only-tools ""` is
// silently ignored -- every tool stays on -- and `--remove-tools` would
// have to name every ID, which varies with the model and the operator's
// MCP servers, so both fail open. `--only-tools ToolSearch` instead
// allowlists the one tool droid itself pins (a `--remove-tools` naming
// every other ID still leaves ToolSearch allowed): an unknown ID aborts
// the launch ("Unknown tool identifier(s)"), so a renamed tool fails
// closed, and the installed binary's free `--list-tools` inventory shows
// every Read, Edit, Execute and MCP tool blocked under it. The capability
// stays unclaimed until the live probe runs: droid's login was empty on
// 2026-09-17, so `Exec failed` answered before any model request.
const DROID_NO_TOOLS_ONLY_TOOL = "ToolSearch";

export class DroidAdapter extends BaseAdapter {
  readonly id: AgentId = "droid";
  readonly binaryName = "droid";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Implemented but not claimed: the capability probe needs a logged-in
      // droid (see docs/HERMETIC.md).
      supportsToolSelection: false,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return [];
      case "low":
        return ["--auto", "low"];
      case "medium":
        return ["--auto", "medium"];
      case "high":
        return ["--auto", "high"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return [
      "--reasoning-effort",
      level === "none" ? "off" : level,
    ];
  }

  private mapEffortForModel(
    level: ReasoningEffort,
    model?: string
  ): string[] {
    if (level === "none" && model?.startsWith("gpt-5.6-")) {
      return ["--reasoning-effort", "none"];
    }
    return this.mapEffort(level);
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["droid", "exec"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      cmd.push(...this.mapEffortForModel(request.effort, request.model));
    }

    if (request.tools === "none") {
      cmd.push("--only-tools", DROID_NO_TOOLS_ONLY_TOOL);
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    _model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["droid"];
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  override supportsTuiModel(): boolean {
    return false;
  }

  override supportsTuiEffort(): boolean {
    return false;
  }
}
