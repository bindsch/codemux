import { BaseAdapter } from "./base.js";
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
      effortLevels: ["low", "medium", "high"],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["-s", "read-only"];
      case "low":
        console.warn("Warning: codex does not support 'low' autonomy, using 'read-only'");
        return ["-s", "read-only"];
      case "medium":
        return ["-s", "workspace-write"];
      case "high":
        return ["-s", "danger-full-access"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    switch (level) {
      case "none":
        console.warn("Warning: codex does not support 'none' effort, using 'low'");
        return ["-c", 'model_reasoning_effort="low"'];
      case "low":
        return ["-c", 'model_reasoning_effort="low"'];
      case "medium":
        return ["-c", 'model_reasoning_effort="medium"'];
      case "high":
        return ["-c", 'model_reasoning_effort="high"'];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["codex", "exec", "--skip-git-repo-check"];

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

    cmd.push("-"); // read prompt from stdin

    return cmd;
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
