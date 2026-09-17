import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import { assertNoClineProjectExecutionConfig } from "../project-safety.js";
import {
  CLINE_PROVIDER_ID,
  writeClineProviderDataDir,
  type ClineProviderDataDir,
} from "../cline-provider.js";
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

export class ClineAdapter extends BaseAdapter {
  readonly id: AgentId = "cline";
  readonly binaryName = "cline";

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super();
  }

  private providerDataDir: ClineProviderDataDir | null = null;
  private readonly providerDataDirs: ClineProviderDataDir[] = [];

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high", "xhigh"],
      // Both refusals verified live at 3.0.62 through the provider
      // override: the non-hermetic control probe leaked the planted code
      // word through the workspace AGENTS.md channel, and no flag or
      // environment variable can close it (docs/HERMETIC.md).
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  /**
   * The provider override, validated: the private providers.json needs a
   * base URL and a key (the model may come from `--model` instead of the
   * variable).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("cline", this.environment);
    if (override === null) return null;
    return requireProviderOverride("cline", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model id the providers.json entry routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "cline needs a model for the provider override; pass --model or set CODEMUX_CLINE_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /**
   * The cline directory a plain run reads: `~/.cline`, or the
   * operator's passed-through `CLINE_DIR` (which every cline path
   * derives from).
   */
  private realClineDir(request: RunRequest): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Cline home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    const base = home && isAbsolute(home) ? home : homedir();
    const passedThrough =
      request.passthroughEnv?.includes("CLINE_DIR") ?? false;
    const configured = this.environment.CLINE_DIR?.trim();
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("passed-through CLINE_DIR must be an absolute path");
      }
      return configured;
    }
    return join(base, ".cline");
  }

  override prepareRun(request: RunRequest): void {
    const override = this.validatedProvider();
    if (override === null) return;
    const model = this.modelFor(request.model);
    if (model === undefined) return;
    this.providerDataDir = writeClineProviderDataDir(
      this.realClineDir(request),
      override,
      model
    );
    this.providerDataDirs.push(this.providerDataDir);
  }

  /** Drops every private data directory this adapter created. */
  disposeProviderDataDir(): void {
    for (const dir of this.providerDataDirs.splice(0)) dir.finalize();
    this.providerDataDir = null;
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        return ["--auto-approve", "false"];
      case "medium":
      case "high":
        return ["--auto-approve", "true"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--thinking", level];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["cline"];

    // With an override the private data directory's providers.json
    // supplies the openai-compatible entry. `--data-dir` points cline's
    // isolated-state mode at it — which relocates the settings path to
    // <dir>/settings/providers.json AND forces the in-process backend
    // that resolves the entry's base URL (a plain run delegates to the
    // hub daemon, which drops it). The provider and model are named
    // explicitly: the command's --provider default ("cline") would
    // otherwise leave the file's entry unused.
    const override = this.validatedProvider();
    if (override !== null) {
      if (this.providerDataDir === null) {
        throw new Error("cline provider data directory was not prepared before launch");
      }
      cmd.push(
        "--data-dir",
        this.providerDataDir.path,
        "--provider",
        CLINE_PROVIDER_ID,
        "--model",
        this.modelFor(request.model)!
      );
    } else if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    cmd.push("--", request.prompt);
    return cmd;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoClineProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: cline's own default provider would
    // otherwise silently answer.
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
    assertNoClineProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // The private providers.json lifecycle rides prepareRun, which only
    // the headless launch path calls; an interactive session has no hook
    // to write and remove it.
    if (this.validatedProvider() !== null) {
      throw new Error(
        "the cline provider override supports headless runs only; unset CODEMUX_CLINE_PROVIDER_* for an interactive session"
      );
    }
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["cline", "--tui"];
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
