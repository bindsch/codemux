import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import {
  PI_AGENT_DIR_ENV,
  PI_PROVIDER_KEY_ENV,
  piProviderModelSelector,
  piProviderBareModel,
  writePiProviderAgentDir,
} from "../pi-provider.js";
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

export class PiAdapter extends BaseAdapter {
  readonly id: AgentId = "pi";
  readonly binaryName = "pi";

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super(environment);
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
      // Hermetic has no mechanism for the global SYSTEM.md channel, and
      // the live control probe leaked the planted code word (2026-09-17);
      // see docs/HERMETIC.md. `--tools none` is claimed: verified live at
      // 0.85.1 through the provider override — under `--no-tools` neither
      // capability probe could produce its secret while plain runs
      // produced both.
      supportsHermetic: false,
      supportsToolSelection: true,
      supportsProviderOverride: true,
    };
  }

  /**
   * The provider override, validated: the private models.json needs a
   * base URL and a key (the model may come from `--model` instead of the
   * variable). Both token caps ride the model entry (maxTokens,
   * contextWindow — first-class models.json fields).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("pi", this.environment);
    if (override === null) return null;
    return requireProviderOverride("pi", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model id the models.json entry routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "pi needs a model for the provider override; pass --model or set CODEMUX_PI_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /**
   * The agent directory a plain run reads: `~/.pi/agent`, or the
   * operator's passed-through PI_CODING_AGENT_DIR (which replaces every
   * path pi derives from it).
   */
  private realAgentDir(request: RunRequest): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Pi home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    const base = home && isAbsolute(home) ? home : homedir();
    const passedThrough =
      request.passthroughEnv?.includes(PI_AGENT_DIR_ENV) ?? false;
    const configured = this.environment[PI_AGENT_DIR_ENV]?.trim();
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error(`passed-through ${PI_AGENT_DIR_ENV} must be an absolute path`);
      }
      return configured;
    }
    return join(base, ".pi", "agent");
  }

  override prepareRun(request: RunRequest): RunContext {
    // One private agent directory per run with an override, never shared
    // and never recorded on the adapter: the launcher owns the returned
    // context and finalizes the directory in cleanupRun when this launch
    // ends.
    const override = this.validatedProvider();
    if (override === null) return {};
    const model = this.modelFor(request.model);
    if (model === undefined) return {};
    return {
      piProviderAgentDir: writePiProviderAgentDir(
        this.realAgentDir(request),
        override,
        model
      ),
    };
  }

  override cleanupRun(context?: RunContext): void {
    context?.piProviderAgentDir?.finalize();
  }

  override getRunEnv(
    _request: RunRequest,
    context?: RunContext
  ): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    const agentDir = context?.piProviderAgentDir;
    if (agentDir === undefined) {
      throw new Error("pi provider agent directory was not prepared before launch");
    }
    // The key and the relocation ride the environment codemux provides;
    // models.json holds only the key's name.
    return {
      [PI_AGENT_DIR_ENV]: agentDir.path,
      [PI_PROVIDER_KEY_ENV]: override.apiKey,
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
      i += 1;
    }
    return kept;
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["pi", "--print", "--no-session", "--no-approve"];

    // With an override the private agent directory's models.json supplies
    // the provider, so the model flag is provider-qualified and always
    // present: pi resolves `--model provider/id` against it.
    const override = this.validatedProvider();
    if (override !== null) {
      cmd.push("--model", piProviderModelSelector(this.modelFor(request.model)!));
    } else if (request.model) {
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

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // Fail before launch on a half-configured override, surface the model
    // requirement early (pi's own default provider, google, would
    // otherwise silently answer), and refuse a model models.json cannot
    // carry verbatim: pi expands $VAR/${VAR} templates inside it
    // (pi-provider.ts).
    const resolved = this.modelFor(request.model);
    if (resolved !== undefined && this.validatedProvider() !== null) {
      piProviderBareModel(resolved);
    }
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
    // The private agent directory's lifecycle rides prepareRun, which only
    // the headless launch path calls; an interactive session has no hook
    // to write and remove it.
    if (this.validatedProvider() !== null) {
      throw new Error(
        "the pi provider override supports headless runs only; unset CODEMUX_PI_PROVIDER_* for an interactive session"
      );
    }
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
