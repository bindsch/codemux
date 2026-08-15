import { BaseAdapter } from "./base.js";
import { assertNoKimiProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

/**
 * Kimi Code CLI (`kimi`), audited against 0.31.1.
 *
 * Autonomy maps onto three native switches in interactive sessions: the default
 * asks before acting, `--yolo` auto-approves tool calls while still asking
 * questions, `--auto` removes the questions too, and `--plan` is the read-only
 * equivalent. None of them may be combined with `--prompt`, so headless runs
 * carry no native control and depend on the scode boundary that every level
 * below `high` already requires.
 */
export class KimiAdapter extends BaseAdapter {
  readonly id: AgentId = "kimi";
  readonly binaryName = "kimi";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // 0.31.1 exposes no reasoning-effort or thinking-budget control.
      supportsEffort: false,
      effortLevels: [],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        // The default already prompts before each tool call.
        return [];
      case "medium":
        return ["--yolo"];
      case "high":
        return ["--auto"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["kimi"];

    if (request.model) {
      cmd.push("--model", request.model);
    }
    // 0.31.1 rejects --plan, --yolo, and --auto when combined with --prompt
    // ("Cannot combine --prompt with --plan"), verified against the installed
    // binary. Headless Kimi therefore has no native autonomy control at all,
    // and the level is enforced entirely by the scode boundary that every level
    // below `high` already requires. The flags below are interactive-only and
    // are applied in buildTuiCommand.

    // 0.31.1 has no stdin transport: the prompt is an argv value. BaseAdapter
    // bounds its length, the same as the other argv-only harnesses.
    cmd.push("--prompt", request.prompt);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoKimiProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: undefined,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    assertNoKimiProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel): string[] {
    const cmd = ["kimi"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
