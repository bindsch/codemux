import { BaseAdapter } from "./base.js";
import { assertNoGeminiProjectExecutionConfig, assertNoGeminiRepositoryEnv } from "../project-safety.js";
import { validateWorkingDirectory, UsageRefusalError } from "../validation.js";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCleanInstructionFiles,
} from "../clean-cwd.js";
import { createGeminiHermeticHome } from "../gemini-hermetic.js";
import { GEMINI_POLICY_FILENAME, geminiToolPolicy, writeGeminiToolPolicy } from "../gemini-policy.js";
import { validateGeminiProjectSettings } from "../gemini-project-settings.js";
import { geminiPlaywrightSettings } from "../gemini-mcp.js";
import { geminiStreamResult } from "../result-envelope/gemini.js";
import { geminiStreamFold } from "../gemini-stream-answer.js";
import { withStreamScanSurface } from "../stream-marker-scan.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { GeminiExperimentRun, type GeminiExperimentContext } from "../gemini-experiment-run.js";
import { geminiTelemetryEnvironment, prepareGeminiTelemetry } from "../gemini-telemetry.js";
import { loginHome, geminiLoginState, type LoginState } from "../harness-health.js";
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
  RunResult,
  AdapterCapabilities,
  LaunchIntent,
} from "../types.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";

export const GEMINI_SYSTEM_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/gemini-system-settings.json", import.meta.url)
);

/** The file reads behind the loadability check, injectable for tests. */
export const geminiSettingsHost = {
  statSync,
  platform: (): NodeJS.Platform => process.platform,
};

/**
 * Whether the Gemini CLI will load codemux's system settings file. The CLI
 * loads the file `GEMINI_CLI_SYSTEM_SETTINGS_PATH` names only when it and
 * every ancestor directory are owned by root; otherwise it prints "Skipping
 * system settings file ... is not owned by root" and loads none of it. A
 * checkout and a Homebrew prefix are user-owned, so the layer, and the
 * `advanced.ignoreLocalEnv` protection it carries, never load there (live
 * matrix, 2026-11-07). An unreadable path counts as not loadable.
 */
export function geminiSystemSettingsLoadable(path: string = GEMINI_SYSTEM_SETTINGS_PATH): boolean {
  if (geminiSettingsHost.platform() === "win32") return true;
  try {
    let current = path;
    for (;;) {
      if (geminiSettingsHost.statSync(current).uid !== 0) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

export class GeminiAdapter extends BaseAdapter {
  // The environment the adapter sees is the one its factory was handed:
  // `verify` passes only PATH so an exported override cannot
  // change its rows, and a run passes the real one.
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }
  readonly id: AgentId = "gemini";
  readonly binaryName = "gemini";

  override getEnv(): Record<string, string> {
    // Named only when the CLI will load it: on a user-owned prefix the
    // variable bought a warning on every run and no protection, and the
    // repository .env it was meant to shut out is refused instead
    // (validateRunRequest, assertNoGeminiRepositoryEnv).
    return geminiSystemSettingsLoadable()
      ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH }
      : {};
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // The shared effort levels still need a model-specific thinkingConfig
      // mapping. Native modelConfigs settings exist; lack of a CLI flag
      // alone does not establish a harness limitation (0.60.0, 2026-11-09).
      supportsEffort: false,
      effortLevels: [],
      // GEMINI_CLI_HOME isolates operator settings; workspace settings
      // still require the clean-cwd guard. Tool denial is independent:
      // --policy accepts a private TOML file in plain and hermetic runs.
      // Installed Gemini 0.60.0 bundle, read 2026-11-09.
      supportsHermetic: true,
      supportsToolSelection: true,
      toolsNoneRequiresHermetic: false,
      // The stream-json wire rebuilt into the JsonFormatter envelope shape
      // (src/gemini-stream-answer.ts and src/result-envelope/gemini.ts hold
      // the field evidence).
      supportsResultJson: true,
      // The GATEWAY auth route: GOOGLE_GEMINI_BASE_URL selects it
      // (chunk-M6NSK26M.js, getBaseUrl/getEnv) and GEMINI_API_KEY carries
      // the key; read in the installed 0.60.0 bundle, 2026-11-09.
      supportsProviderOverride: true,
    };
  }

  /**
   * The provider override, validated: gemini's env delivery needs a base
   * URL and a key (the model may come from `-m` instead of the variable).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("gemini", this.environment);
    if (override === null) return null;
    if (override.maxContextTokens !== undefined) {
      throw new UsageRefusalError(
        "gemini cannot set provider max-context-tokens: Gemini CLI 0.60.0 uses its hard-coded tokenLimit(model) table"
      );
    }
    return requireProviderOverride("gemini", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model the gateway routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "gemini needs a model for the provider override; pass --model or set CODEMUX_GEMINI_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  private providerEnv(model: string | undefined): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    this.modelFor(model);
    return {
      GOOGLE_GEMINI_BASE_URL: override.baseUrl,
      GEMINI_API_KEY: override.apiKey,
    };
  }

  /** The real gemini directory the private home's parent lives under. */
  private realGeminiDir(): string {
    return join(loginHome(this.environment), ".gemini");
  }

  override prepareRun(
    request: RunRequest,
    _sandboxTrust?: ScodeTrustLevel,
    _sandboxOptions?: SandboxOptions,
    launch: LaunchIntent = {}
  ): GeminiExperimentContext {
    const printOnly = launch.printOnly === true;
    if (printOnly && request.experimentMcp) throw new UsageRefusalError("Gemini experiment MCP cannot be prepared for a print-only preview");
    const experimentSpec = request.experimentMcp ? readExperimentRunSpec(request) : undefined;
    if (experimentSpec && !request.hermetic && !experimentSpec.control) throw new UsageRefusalError("Gemini experiment requires a private hermetic home");
    const override = this.validatedProvider();
    const tokens = override?.maxOutputTokens;
    const mcp = geminiPlaywrightSettings(request.sandboxed, request.enablePlaywrightMcp, this.executionPathEnv(), request.cwd);
    if (request.hermetic || request.resultJson || experimentSpec || geminiToolPolicy(request) !== null || tokens !== undefined || mcp.check !== null) {
      const home = createGeminiHermeticHome(this.realGeminiDir(), {
          toolsNone: request.tools === "none" || experimentSpec !== undefined,
          apiKeyAuth: override !== null || (!request.hermetic && !request.resultJson && request.tools !== "none" && tokens === undefined && mcp.check === null),
          printOnly,
          preserveCustomization: !request.hermetic && !experimentSpec && (request.resultJson || request.tools === "none" || tokens !== undefined || mcp.check !== null),
          outputLimit: tokens === undefined ? undefined : { model: this.modelFor(request.model)!, tokens },
          mcpServers: mcp.servers,
        });
      try {
        if (!printOnly) writeGeminiToolPolicy(home.home, request);
        const context: GeminiExperimentContext = { geminiHermeticHome: home, playwrightMcpCheck: mcp.check };
        if (experimentSpec) {
          const experiment = new GeminiExperimentRun(experimentSpec, request.cwd ?? process.cwd(), home.home, this.environment, request.prompt);
          context.experimentGemini = experiment;
          context.stdoutSink = experiment;
          context.experimentRecording = experiment.recordingPath;
        } else {
          context.stdoutSink = geminiStreamFold();
          if (request.resultJson) context.geminiTelemetryPath = prepareGeminiTelemetry(home.home, printOnly);
        }
        return context;
      } catch (error) {
        home.finalize();
        throw error;
      }
    }
    return { stdoutSink: geminiStreamFold() };
  }

  override cleanupRunSync(context?: GeminiExperimentContext): void {
    try { context?.experimentGemini?.closeSync(); }
    finally { context?.geminiHermeticHome?.finalize(); }
  }

  override cleanupRun(context?: GeminiExperimentContext): void | Promise<void> {
    if (context?.experimentGemini) return context.experimentGemini.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  override getRunEnv(request: RunRequest, context?: GeminiExperimentContext): Record<string, string> {
    if ((request.hermetic || request.resultJson || request.enablePlaywrightMcp || geminiToolPolicy(request) !== null || this.validatedProvider()?.maxOutputTokens !== undefined) && context?.geminiHermeticHome === undefined) {
      throw new Error("gemini hermetic home was not prepared before launch");
    }
    return { ...this.providerEnv(request.model), ...(context?.geminiTelemetryPath ? geminiTelemetryEnvironment(context.geminiTelemetryPath) : {}),
      ...context?.experimentGemini?.environment };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        // auto_edit denies shell commands headless; scode is the boundary.
        return ["--approval-mode", "yolo"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  buildRunCommand(request: RunRequest, context?: GeminiExperimentContext): string[] {
    if (request.experimentMcp && !context?.experimentGemini) throw new Error("Gemini experiment was not prepared");
    const isolated = request.hermetic || request.resultJson || request.experimentMcp || request.tools === "none" || request.enablePlaywrightMcp || this.validatedProvider()?.maxOutputTokens !== undefined;
    // Run and session commands carry the native home redirect in argv.
    // The interactive lifecycle carries it in its prepared environment.
    // Both keep HOME unchanged and put mirrors under the real .gemini root.
    const unprepared = join(this.realGeminiDir(), ".codemux-hermetic", "unprepared");
    const cmd = isolated
      ? ["env", `GEMINI_CLI_HOME=${context?.geminiHermeticHome?.home ?? unprepared}`, "gemini"]
      : ["gemini"];
    cmd.push("--sandbox=false");
    if (request.experimentMcp || geminiToolPolicy(request) !== null) {
      cmd.push("--policy", join(context?.geminiHermeticHome?.home ?? unprepared, GEMINI_POLICY_FILENAME));
    }

    const model = this.modelFor(request.model);
    if (model) {
      cmd.push("-m", model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    // Every run reads the stream-json wire: the json format drops the text
    // written before the last tool request, and the text format glues
    // messages together (src/gemini-stream-answer.ts, lane AN1).
    cmd.push("--output-format", "stream-json");

    // The empty flag selects headless mode; the exact prompt arrives on stdin.
    // Gemini 0.60.0 readStdin() uses piped input verbatim (2026-11-09).
    cmd.push("-p", "");

    return cmd;
  }

  override getStdinInput(request: RunRequest): string {
    return request.prompt;
  }

  override getTuiEnv(model?: string): Record<string, string> {
    return this.providerEnv(model);
  }

  /** Both interactive launch paths own this environment until finalize.
   * Gemini 0.60.0 reads GEMINI_CLI_HOME before global settings discovery
   * (bundle/chunk-M6NSK26M.js homedir/getGlobalGeminiDir, 2026-11-09).
   * The mirror stays under the real .gemini state root; scode selects that
   * root through HOME, which this hook leaves intact (scode:2058). */
  override prepareTuiEnvironment(
    model?: string, _autonomy?: AutonomyLevel, _effort?: ReasoningEffort,
    _sandboxed?: boolean, _passthroughEnv?: readonly string[], printOnly = false
  ) {
    const env = this.providerEnv(model);
    const override = this.validatedProvider();
    if (override?.maxOutputTokens === undefined) return { env, finalize: () => {} };
    const home = createGeminiHermeticHome(this.realGeminiDir(), {
      apiKeyAuth: true, preserveCustomization: true, printOnly,
      outputLimit: { model: this.modelFor(model)!, tokens: override.maxOutputTokens },
    });
    return { env: { ...env, GEMINI_CLI_HOME: home.home }, finalize: home.finalize };
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: GeminiExperimentContext): RunResult {
    const model = { ...request, model: this.modelFor(request.model) };
    if (context?.experimentGemini) return geminiStreamResult(result, model, context.experimentRecording ?? undefined, context.experimentGemini.evidencePath);
    // The fold shed tool results; the scan covers them (stream-marker-scan.ts).
    return withStreamScanSurface(geminiStreamResult(result, model, undefined, context?.geminiTelemetryPath),
      result.stdout, context?.stdoutSink);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    const workdir = validateWorkingDirectory(request.cwd) ?? process.cwd();
    if (request.experimentProjectSettings) {
      if (this.validatedProvider()?.maxOutputTokens !== undefined) {
        throw new UsageRefusalError("gemini project settings can override provider output token caps; omit one of these options");
      }
      validateGeminiProjectSettings({
        agent: "gemini", hermetic: request.hermetic === true,
        autonomy: request.autonomy ?? "read-only", sandbox: request.sandboxed === true,
        cwd: workdir, tools: request.tools, experimentMcp: request.experimentMcp,
        passthroughEnv: request.passthroughEnv,
      });
    } else {
      assertNoGeminiProjectExecutionConfig(workdir);
    }
    if (!geminiSystemSettingsLoadable()) assertNoGeminiRepositoryEnv(workdir);
    if (request.hermetic) {
      if (request.cwd === undefined) {
        throw new UsageRefusalError("gemini isolation requires an explicit --cwd owned by this run");
      }
      if (request.passthroughEnv?.includes("GEMINI_CLI_HOME")) {
        throw new UsageRefusalError("gemini isolation owns GEMINI_CLI_HOME; remove --pass-env GEMINI_CLI_HOME");
      }
      // The workspace channels the private home cannot close: the context
      // file GEMINI.md (DEFAULT_CONTEXT_FILENAME, chunk-VCAJDPDX.js) and
      // the .gemini/ workspace settings and policy directory. A dangling
      // symlink counts (lstat): the harness resolves it.
      if (!request.experimentProjectSettings) {
        assertCleanInstructionFiles("gemini", validateWorkingDirectory(request.cwd)!, [
          "GEMINI.md",
          ".gemini",
          ".agents/skills",
        ]);
      }
    }
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: gemini's own default would otherwise
    // silently answer through the operator's gateway.
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
    this.validateTuiSettingsRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    if (enablePlaywrightMcp) {
      throw new UsageRefusalError("gemini Playwright MCP requires a run settings context; TUI delivery is not implemented");
    }
  }

  /** Validate workspace settings before creating any private mirror.
   * The MCP helper also uses this entry point while public attachment
   * still depends on the unapplied shared whitelist/lifecycle patch. */
  validateTuiSettingsRequest(
    model?: string, cwd?: string, autonomy: AutonomyLevel = "read-only", effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [], enablePlaywrightMcp = false
  ): void {
    // The helper carries MCP itself; the public CLI's shared whitelist
    // remains a separate gate until its integration patch is applied.
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, false);
    if (typeof enablePlaywrightMcp !== "boolean") throw new Error("enablePlaywrightMcp must be a boolean");
    const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
    assertNoGeminiProjectExecutionConfig(workdir);
    if (!geminiSystemSettingsLoadable()) assertNoGeminiRepositoryEnv(workdir);
    this.modelFor(model);
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["gemini", "--sandbox=false"];
    const resolvedModel = this.modelFor(model);
    if (resolvedModel) {
      cmd.push("-m", resolvedModel);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  /** The gemini login read: the oauth creds file, or an API key. */
  override loginState(): LoginState {
    return geminiLoginState(loginHome(this.environment), this.environment);
  }
}
