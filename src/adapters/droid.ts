import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import { assertNoDroidProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import {
  writeDroidProviderSettings,
  droidProviderModelId,
  DROID_PROVIDER_KEY_ENV,
  type DroidProviderSettings,
} from "../droid-provider.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
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
// every Read, Edit, Execute and MCP tool blocked under it.
const DROID_NO_TOOLS_ONLY_TOOL = "ToolSearch";

/**
 * Factory's Droid CLI (`droid`), audited against 0.186.0.
 *
 * A provider override rides droid's BYOK settings: one `customModels` entry
 * in a per-run settings file passed as the root-level `--settings <path>`
 * ("merged for this process only"), with the key referenced as
 * `${CODEMUX_DROID_PROVIDER_API_KEY}` and delivered through the environment
 * codemux provides (see src/droid-provider.ts for the grounding). The
 * override needs no Factory login: the entry's own key authenticates every
 * request, which is what made the capability probe possible on a machine
 * whose stored login droid's self-update had removed.
 */
export class DroidAdapter extends BaseAdapter {
  readonly id: AgentId = "droid";
  readonly binaryName = "droid";

  private providerSettings: DroidProviderSettings | null = null;
  // Every file this adapter created and has not disposed; earlier runs
  // through the same instance may still be using theirs.
  private readonly providerSettingsAll: DroidProviderSettings[] = [];

  // Seams so tests can point the real brand home at a scratch directory.
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
      // Verified live on 2026-09-17 through a provider override (GLM-5.3
      // via Z.AI): under --tools none neither the read nor the shell probe
      // could produce its secret, while a plain run produced both
      // (docs/HERMETIC.md).
      supportsToolSelection: true,
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

  /**
   * The provider override, validated: droid's BYOK entry needs a base URL
   * and a key (the model may come from `--model` instead of the variable).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("droid", this.environment);
    if (override === null) return null;
    return requireProviderOverride("droid", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model id the BYOK entry routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "droid needs a model for the provider override; pass --model or set CODEMUX_DROID_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /**
   * The brand home whose `.codemux/` holds the per-run settings file: the
   * one a plain run reads settings.json, skills and hooks from. Droid has
   * no relocation variable for it (only FACTORY_API_KEY and
   * FACTORY_DROID_AUTO_UPDATE_ENABLED exist), so it is always under the
   * effective home.
   */
  private realBrandHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Droid home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return join(home && isAbsolute(home) ? home : homedir(), ".factory");
  }

  override prepareRun(request: RunRequest): void {
    const override = this.validatedProvider();
    if (override === null) return;
    const model = this.modelFor(request.model);
    if (model === undefined) return;
    this.providerSettings = writeDroidProviderSettings(
      this.realBrandHome(),
      override,
      model
    );
    this.providerSettingsAll.push(this.providerSettings);
  }

  /** Drops every per-run settings file this adapter created. */
  disposeProviderSettings(): void {
    for (const settings of this.providerSettingsAll.splice(0)) settings.finalize();
    this.providerSettings = null;
  }

  override getRunEnv(_request: RunRequest): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    if (this.providerSettings === null) {
      throw new Error("droid provider settings were not prepared before launch");
    }
    // The key rides the environment codemux provides; the settings file
    // holds only its name.
    return { [DROID_PROVIDER_KEY_ENV]: override.apiKey };
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd: string[] = ["droid"];

    // With an override the per-run settings file supplies the BYOK entry
    // and the session's default model. `--settings` is a root-level flag,
    // so it precedes the subcommand. A static preview (`verify`) has no
    // prepared file; the placeholder path does not exist, and droid fails
    // to read it, so a command built without prepareRun fails closed.
    if (this.validatedProvider() !== null) {
      const model = this.modelFor(request.model)!;
      const unprepared = join(this.realBrandHome(), ".codemux", "unprepared", "settings.json");
      cmd.push("--settings", this.providerSettings?.path ?? unprepared);
      cmd.push("exec");
      // The entry's id, not its API model name: droid resolves `-m` by id.
      cmd.push("-m", droidProviderModelId(model));
    } else {
      cmd.push("exec");
      if (request.model) {
        cmd.push("-m", request.model);
      }
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
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the operator's own login and default model
    // would otherwise silently answer.
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
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // The per-run settings file's lifecycle rides prepareRun, which only
    // the headless launch path calls; an interactive session has no hook to
    // write and remove the file.
    if (this.validatedProvider() !== null) {
      throw new Error(
        "the droid provider override supports headless runs only; unset CODEMUX_DROID_PROVIDER_* for an interactive session"
      );
    }
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
