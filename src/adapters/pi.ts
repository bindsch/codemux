import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class PiAdapter extends BaseAdapter {
  readonly id: AgentId = "pi";
  readonly binaryName = "pi";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Implemented but unclaimed: pi is not installed on the release
      // machine, so the capability probe is pending an install. Hermetic
      // has no mechanism for the global SYSTEM.md channel; see
      // docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--no-extensions", "--tools", "read,grep,find,ls"];
      case "low":
        return [
          "--no-extensions",
          "--tools",
          "read,grep,find,ls,edit,write",
        ];
      case "medium":
        console.warn("Warning: pi has no dedicated 'medium' approval mode, using default tool-enabled mode");
        return [];
      case "high":
        console.warn("Warning: pi has no dedicated 'high' approval mode, using default tool-enabled mode");
        return [];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--thinking", level === "none" ? "off" : level];
  }

  /**
   * The autonomy flags a run carries. Under `--tools none` the `--tools`
   * allowlist must not ride along: pi resolves an explicit allowlist over
   * `--no-tools` (`options.tools ?? (options.noTools === "all" ? [] : …)`,
   * core/sdk.js at 0.85.1), so the allowlist would re-enable exactly those
   * tools.
   */
  private autonomyFlagsFor(request: RunRequest): string[] {
    if (!request.autonomy) return [];
    const flags = this.mapAutonomy(request.autonomy);
    if (request.tools !== "none") return flags;
    const kept: string[] = [];
    let i = 0;
    while (i < flags.length) {
      const flag = flags[i];
      if (flag === undefined) break;
      if (flag === "--tools") {
        i += 2;
        continue;
      }
      kept.push(flag);
      i++;
    }
    return kept;
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["pi", "--print", "--no-session", "--no-approve"];

    if (request.model) {
      cmd.push("--model", request.model);
    }

    cmd.push(...this.autonomyFlagsFor(request));
    if (request.tools === "none") {
      // "Disable all tools by default (built-in and extension)" (0.85.1
      // --help): the empty allowlist keeps every built-in, extension and
      // custom tool out of the registry, so the model is offered none.
      cmd.push("--no-tools");
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
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["pi", "--no-approve"];
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
