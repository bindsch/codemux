import { BaseAdapter } from "./base.js";
import { assertNoCodexProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = "codex";
  readonly binaryName = "codex";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["-s", "read-only", "-a", "never"];
      case "low":
        return ["-s", "workspace-write", "-a", "untrusted"];
      case "medium":
        return ["-s", "workspace-write", "-a", "never"];
      case "high":
        return ["-s", "danger-full-access", "-a", "never"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["-c", `model_reasoning_effort="${level}"`];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["codex"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    if (request.sandboxed) {
      // codemux is already enforcing scode sandbox boundaries.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    cmd.push("exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-");

    return cmd;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCodexProjectExecutionConfig(
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
    assertNoCodexProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed = false
  ): string[] {
    const cmd = ["codex"];
    if (model) {
      cmd.push("-m", model);
    }
    if (sandboxed) {
      // codemux is already enforcing scode sandbox boundaries.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
