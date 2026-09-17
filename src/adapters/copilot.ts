import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import {
  createCopilotHermeticHome,
  type CopilotHermeticHome,
} from "../copilot-hermetic.js";
import { assertNoCopilotProjectExecutionConfig } from "../project-safety.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
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

// `--tools none` has no mapping: `--available-tools` is the documented
// model-visible allowlist ("Only these tools will be available to the model",
// 1.0.85 --help), but no argv spelling of an empty allowlist disarms the
// tools — verified live at 1.0.85 through the provider override, where a
// bare `--available-tools`, `--available-tools=`, and `--available-tools ""`
// all left the read and shell tools armed (the probes produced the planted
// secret and a true byte count under every spelling). See docs/HERMETIC.md.

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
      // Both refusals verified live at 1.0.85 through the provider
      // override: the control probe cannot leak the planted code word
      // (--no-custom-instructions rides every run), and no argv spelling
      // of an empty --available-tools allowlist disarms the tools.
      // See docs/HERMETIC.md.
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

  /**
   * The provider override, validated: Copilot's BYOK delivery needs a base
   * URL and a key (the model may come from `--model` instead of the
   * variable).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("copilot", this.environment);
    if (override === null) return null;
    return requireProviderOverride("copilot", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model the override routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "copilot needs a model for the provider override; pass --model or set CODEMUX_COPILOT_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /**
   * The provider override rides Copilot's documented BYOK environment group
   * (docs.github.com, "Use bring-your-own-key models with Copilot CLI":
   * `COPILOT_PROVIDER_BASE_URL` is "required to activate BYOK", the type
   * "openai" covers "any other OpenAI Chat Completions API-compatible
   * endpoint", and `COPILOT_MODEL` — also settable through `--model` — names
   * the model; the wire API defaults to completions). The group activates
   * before any GitHub authentication in 1.0.85's startup (app.js returns
   * from provider initialization before the GitHub directory and login flow
   * run), so the key travels through the environment codemux provides,
   * never argv and never an operator file, and the override survives
   * `--hermetic` unchanged.
   */
  private providerEnv(model: string | undefined): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    const resolved = this.modelFor(model);
    return {
      COPILOT_PROVIDER_BASE_URL: override.baseUrl,
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_API_KEY: override.apiKey,
      ...(resolved ? { COPILOT_MODEL: resolved } : {}),
    };
  }

  override mapEffort(level: ReasoningEffort): string[] {
    // Renamed from --effort upstream between 1.0.77 and 1.0.85; the value
    // set is unchanged (none through max, the levels this adapter advertises).
    return ["--reasoning-effort", level];
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
    return this.providerEnv(request.model);
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCopilotProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: copilot's configured default would otherwise
    // silently answer through the operator's provider.
    this.modelFor(request.model);
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
    this.modelFor(model);
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

  override getTuiEnv(
    model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): Record<string, string> {
    return this.providerEnv(model);
  }
}
