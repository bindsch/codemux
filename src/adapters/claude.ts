import { BaseAdapter } from "./base.js";
import { getPlaywrightSandboxMcpArgs } from "../mcp.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = "claude";
  readonly binaryName = "claude";

  override getEnv(): Record<string, string> {
    return { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--permission-mode", "plan"];
      case "low":
        return ["--permission-mode", "manual"];
      case "medium":
        return ["--permission-mode", "acceptEdits"];
      case "high":
        return ["--dangerously-skip-permissions"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return level === "none" ? [] : ["--effort", level];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = [
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
    ];

    cmd.push(...getPlaywrightSandboxMcpArgs(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(),
    }));

    if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string
  ): string[] {
    const cmd = enablePlaywrightMcp
      ? ["claude", "--setting-sources", "user", "--strict-mcp-config"]
      : ["claude", "--safe-mode"];
    cmd.push(...getPlaywrightSandboxMcpArgs(sandboxed, {
      enabled: enablePlaywrightMcp,
      forbiddenRoot: cwd ?? process.cwd(),
    }));
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
