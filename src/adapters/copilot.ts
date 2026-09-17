import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import {
  createCopilotHermeticHome,
  type CopilotHermeticHome,
} from "../copilot-hermetic.js";
import { assertNoCopilotProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

// Hermetic runs point COPILOT_HOME at a private, empty config directory (see
// copilot-hermetic.ts), which relocates the user settings, config, custom
// instructions, skills, agents, plugins, MCP config, memories and session
// state, and stops ~/.agents/skills loading; the keychain login is keyed by
// service name, not path, so it still works. The repo channels close with
// flags already carried by every run: --no-custom-instructions ("Disable
// loading of custom instructions from AGENTS.md and related files", 1.0.85
// --help) covers AGENTS.md, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md
// and .github/instructions/** (docs.github.com, "Add custom instructions"),
// and repo hooks, workspace MCP and repo extensions load in prompt mode only
// from a trusted folder (app.js at 1.0.85 gates them behind
// folderTrustIsTrusted / GITHUB_COPILOT_PROMPT_MODE_* env vars), while the
// trust state lives in the private home's config.json and starts empty. The
// built-in GitHub MCP server is an account-level integration, so a hermetic
// run disables it at every autonomy level.

// `--tools none`: --available-tools is the model-visible allowlist ("Only
// these tools will be available to the model", 1.0.85 --help; "These filters
// decide which tools the model can see", `copilot help permissions`). A bare
// flag with no values parses as an empty allowlist, and the native filter
// (runtime.node sessionFilterEnabledToolIndexesJson at 1.0.85, exercised
// first-hand) maps availableTools: [] to no enabled tool and treats only an
// absent value as "no filter" -- empty is a first-class none state.
const COPILOT_NO_TOOLS_FLAG = "--available-tools";

export class CopilotAdapter extends BaseAdapter {
  readonly id: AgentId = "copilot";
  readonly binaryName = "copilot";

  private hermeticHome: CopilotHermeticHome | null = null;
  // Every home this adapter created and has not disposed; earlier runs
  // through the same instance may still be using theirs.
  private readonly hermeticHomes: CopilotHermeticHome[] = [];

  // Seams so tests can point the real config directory at a scratch one.
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super();
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Both mappings below are implemented but not claimed: Copilot is not
      // installed on the release machine, so `codemux check --hermetic -a
      // copilot` and the capability probe are pending an install. See
      // docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        return ["--allow-tool", "read"];
      case "medium":
        return ["--allow-all-tools"];
      case "high":
        return ["--allow-all"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--effort", level];
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("copilot home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  /**
   * The config directory a plain run reads: ~/.copilot, or the operator's
   * COPILOT_HOME when they passed it through (the sanitized child
   * environment drops it otherwise). A hermetic run's private home is
   * created under this directory.
   */
  private realConfigDir(request: RunRequest): string {
    const passedThrough = request.passthroughEnv?.includes("COPILOT_HOME") ?? false;
    const configured = this.environment.COPILOT_HOME?.trim();
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("COPILOT_HOME must be an absolute path");
      }
      return configured;
    }
    return join(this.effectiveHome(), ".copilot");
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd: string[] = [];
    if (request.hermetic) {
      // The private home reaches Copilot through env(1), never through the
      // environment codemux hands to scode, and the assignment overrides any
      // COPILOT_HOME the sanitized child environment carries. A static
      // preview (`verify`) has no prepared home; the placeholder path does
      // not exist, and getRunEnv refuses a launch without one, so a command
      // built without prepareRun fails closed.
      const unprepared = join(this.realConfigDir(request), ".codemux-hermetic", "unprepared");
      const home = this.hermeticHome?.home ?? unprepared;
      cmd.push("env", `COPILOT_HOME=${home}`);
    }
    cmd.push(
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental"
    );
    if (request.tools === "none") {
      cmd.push(COPILOT_NO_TOOLS_FLAG);
    }
    if ((request.autonomy ?? "read-only") !== "high" || request.hermetic) {
      cmd.push("--disable-builtin-mcps");
    }
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    cmd.push(`--prompt=${request.prompt}`);
    cmd.push("--silent");
    return cmd;
  }

  override prepareRun(request: RunRequest): void {
    if (!request.hermetic) return;
    this.hermeticHome = createCopilotHermeticHome(this.realConfigDir(request));
    this.hermeticHomes.push(this.hermeticHome);
  }

  /** Finalizes every hermetic home of this adapter now rather than at exit. */
  disposeHermeticHome(): void {
    for (const home of this.hermeticHomes.splice(0)) home.finalize();
    this.hermeticHome = null;
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    // The hermetic environment rides inside the command; nothing here may
    // leak the private home into the environment scode itself runs with.
    if (request.hermetic && this.hermeticHome === null) {
      throw new Error("copilot hermetic home was not prepared before launch");
    }
    return {};
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCopilotProjectExecutionConfig(
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
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    assertNoCopilotProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = [
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
    ];
    if ((autonomy ?? "read-only") !== "high") {
      cmd.push("--disable-builtin-mcps");
    }
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
