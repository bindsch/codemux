import { BaseAdapter, type RunContext } from "./base.js";
import { UsageRefusalError } from "../validation.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import {
  qwenBrandHome,
  writeQwenEffortSettings,
  writeQwenRunSettings,
  QWEN_EFFORT_LEVELS,
  QWEN_EFFORT_SETTINGS_ENV,
} from "../qwen-effort.js";
import { qwenNoToolsArgs, qwenNoWebArgs } from "../qwen-tools.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import { qwenPlainResult, qwenResult } from "../result-envelope/qwen.js";
import { qwenStreamFold } from "../qwen-stream-answer.js";
import { withStreamScanSurface } from "../stream-marker-scan.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { QwenExperimentRun, qwenExperimentResult, assertQwenExperimentCwd } from "../qwen-experiment-run.js";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions, type ScodeTrustLevel } from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { envKeyLoginState, type LoginState } from "../harness-health.js";

export class QwenAdapter extends BaseAdapter {
  readonly id: AgentId = "qwen";

  get binaryName(): string {
    return this.isLegacyBinary ? "qwen-coder" : "qwen";
  }

  private readonly resolvedBinary: string | null;
  private readonly isLegacyBinary: boolean;

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: !this.isLegacyBinary,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // The tier rides the SYSTEM settings layer through a per-run file
      // and QWEN_CODE_SYSTEM_SETTINGS_PATH (src/qwen-effort.ts; the
      // legacy qwen-coder binary has no settings layers at all, so it
      // keeps the base refusal through the empty level list below).
      supportsEffort: !this.isLegacyBinary,
      effortLevels: this.isLegacyBinary ? [] : [...QWEN_EFFORT_LEVELS],
      // Every codemux qwen run already passes --safe-mode, which qwen
      // documents as "Disable all customizations (context files, hooks,
      // extensions, skills, MCP servers)" and announces as "all
      // customizations disabled (hooks, extensions, skills, MCP servers,
      // QWEN.md)" (0.24.0 option table and startup warning, read
      // 2026-11-09). --hermetic therefore closes nothing further: the
      // claim is the always-on safe mode itself, documented in
      // docs/isolation.md.
      supportsHermetic: true,
      // The removal carrier is argv, not settings: safe mode ignores the
      // settings-sourced tool flags outright ("⚠ Safe mode: --core-tools
      // flag is ignored (settings-sourced core tools are also disabled)",
      // 0.24.0 binary string, read 2026-11-09), but `--exclude-tools`
      // joins the permission deny list unconditionally, whatever the
      // mode, so `--tools none` excludes the whole hard-coded CORE_TOOLS
      // list and the model gets a real empty set
      // (src/qwen-tools.ts, docs/isolation.md). The legacy qwen-coder
      // binary predates the flag and keeps the base refusal.
      supportsToolSelection: !this.isLegacyBinary,
      // The OpenAI-compatible provider rides the environment trio
      // OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL (below).
      supportsProviderOverride: !this.isLegacyBinary,
      // `--output-format json` prints the message array with the result
      // message last (src/result-envelope/qwen.ts).
      supportsResultJson: true,
    };
  }

  constructor(
    findBinary: ((name: string) => string | null) | undefined = undefined,
    environment: NodeJS.ProcessEnv = process.env
  ) {
    super(environment);
    findBinary ??= (name) => Bun.which(name, { PATH: environment.PATH ?? "" });
    const currentBinary = findBinary("qwen");
    const legacyBinary = currentBinary ? null : findBinary("qwen-coder");
    this.resolvedBinary = currentBinary ?? legacyBinary;
    this.isLegacyBinary = currentBinary === null && legacyBinary !== null;
  }

  private resolveBinary(): string {
    return this.resolvedBinary ?? "qwen";
  }

  override isAvailable(): boolean {
    return this.resolvedBinary !== null;
  }

  /**
   * The provider override, validated: qwen selects its OpenAI-compatible
   * auth only when ALL THREE of OPENAI_API_KEY, OPENAI_BASE_URL and
   * OPENAI_MODEL are set (`getAuthTypeFromEnv`: `env["OPENAI_API_KEY"] &&
   * (env["OPENAI_MODEL"] || env["QWEN_MODEL"]) && env["OPENAI_BASE_URL"]`,
   * 0.24.0, read 2026-11-09), so the override requires a model — the
   * request's or the variable's. The output cap rides
   * QWEN_CODE_MAX_OUTPUT_TOKENS; the context cap rides the run settings
   * file as model.generationConfig.contextWindowSize
   * (src/qwen-effort.ts), written at prepareRun from the override here.
   */
  private validatedProvider(): (ProviderOverride & {
    baseUrl: string; apiKey: string; model: string;
  }) | null {
    const override = readProviderOverride("qwen", this.environment);
    if (override === null) return null;
    return requireProviderOverride("qwen", override, [
      "baseUrl",
      "apiKey",
      "model",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string; model: string };
  }

  /** The environment an override carries — the auth trio, the model
   * selection riding OPENAI_MODEL, and the output cap — shared by the
   * run and TUI paths so the two cannot drift. */
  private providerEnv(model: string | undefined): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    // The trio getAuthTypeFromEnv requires. The request's --model flag,
    // when set, names the model for this run; the override's model rides
    // OPENAI_MODEL so the auth type resolves and an unspecified --model
    // still lands on the override's model.
    const env: Record<string, string> = {
      OPENAI_API_KEY: override.apiKey,
      OPENAI_BASE_URL: override.baseUrl,
      OPENAI_MODEL: model ?? override.model,
    };
    if (override.maxOutputTokens !== undefined) {
      env.QWEN_CODE_MAX_OUTPUT_TOKENS = String(override.maxOutputTokens);
    }
    return env;
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        // Auto mode can approve shell commands headless after classifier review.
        // https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/approval-mode.md
        return ["--approval-mode", "auto"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  override requiresSandboxForAutonomy(level: AutonomyLevel): boolean {
    // The legacy binary cannot enforce any level on its own, so it needs the
    // boundary even at `high`, which the base policy exempts.
    return this.isLegacyBinary || super.requiresSandboxForAutonomy(level);
  }

  override prepareRun(request: RunRequest, _trust?: ScodeTrustLevel, sandbox?: SandboxOptions): RunContext {
    if (request.experimentMcp) {
      if (this.isLegacyBinary) throw new UsageRefusalError("qwen-coder has no explicit MCP configuration carrier; install qwen 0.24.0 or newer");
      const spec = readExperimentRunSpec(request);
      const override = this.validatedProvider();
      const experiment = new QwenExperimentRun(spec, request.cwd ?? process.cwd(), qwenBrandHome(this.environment),
        { ...this.environment, ...this.providerEnv(request.model) }, request.prompt, {
          ...(request.effort === undefined ? {} : { reasoningEffort: request.effort }),
          ...(override?.maxContextTokens === undefined ? {} : { generationConfig: { contextWindowSize: override.maxContextTokens } }),
        }, undefined, this.buildExecutionEnv(this.providerEnv(request.model), request.passthroughEnv));
      try {
        if (sandbox) {
          assertNoCallerBlockOverStateDirs(sandbox.blockPaths ?? [], [experiment.home]);
          sandbox.harnessStateDirs = [...(sandbox.harnessStateDirs ?? []), experiment.home];
        }
        return { experimentQwen: experiment, experimentRecording: experiment.recordingPath, stdoutSink: experiment };
      } catch (error) { experiment.closeSync(); throw error; }
    }
    // One settings file per run, never shared and never recorded on the
    // adapter: the launcher owns the returned context and finalizes the
    // file in cleanupRun when this launch ends. It carries the effort
    // tier and, when the provider override caps the context window, that
    // cap (src/qwen-effort.ts) — either alone is enough to need a file.
    if (this.isLegacyBinary) return {};
    const override = this.validatedProvider();
    // The fold sheds tool payloads from the stream-json capture.
    if (request.effort === undefined && override?.maxContextTokens === undefined) {
      return { stdoutSink: qwenStreamFold() };
    }
    return {
      stdoutSink: qwenStreamFold(),
      qwenEffortSettings: writeQwenRunSettings(qwenBrandHome(this.environment), {
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(override?.maxContextTokens === undefined
          ? {}
          : { contextWindowTokens: override.maxContextTokens }),
      }),
    };
  }

  override cleanupRunSync(context?: RunContext): void {
    try { context?.experimentQwen?.closeSync(); }
    finally { context?.qwenEffortSettings?.finalize(); }
  }

  override cleanupRun(context?: RunContext): void | Promise<void> {
    if (context?.experimentQwen) return context.experimentQwen.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const binary = this.resolveBinary();

    if (this.isLegacyBinary) {
      if (request.model) {
        throw new Error("qwen-coder does not support model selection");
      }
      if (!request.sandboxed) {
        throw new Error(
          "qwen-coder cannot enforce autonomy levels; use --sandbox or install the current qwen CLI"
        );
      }
      return [binary, "--", request.prompt];
    }

    const cmd = [binary, "--safe-mode"];
    const experiment = context?.experimentQwen;
    if (request.experimentMcp && !experiment) throw new Error("Qwen experiment was not prepared before launch");
    if (experiment) cmd.push("--mcp-config", experiment.configPath, "--openai-logging",
      "--openai-logging-dir", experiment.logs, "--auth-type", experiment.authType);
    // The Playwright server rides --mcp-config inline JSON — the same
    // {"mcpServers":{...}} argument buildPlaywrightSandboxMcp emits for
    // the Claude family. Safe mode keeps it: chunk-HWKWZSZY.js (offset
    // 2095089) resolves mcpServers to {...topTierMcpServers} under
    // bareMode||safeMode, dropping only settings-sourced servers, and
    // --mcp-config is top-tier (parseMcpConfig reads inline JSON or a
    // file path). The trust check rides the context for the spawn's
    // re-stat, exactly as the claude adapter does (review round 110).
    const playwright = buildPlaywrightSandboxMcp(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(),
      pathEnv: this.executionPathEnv(),
    });
    cmd.push(...playwright.args);
    if (context !== undefined) context.playwrightMcpCheck = playwright.check;
    if (request.model) {
      cmd.push("--model", request.model);
    }
    // `--tools none` removes every built-in tool; a `--no-web` run (with
    // the tools still on) removes just the two web tools — the exclusion
    // list subsumes them, so the two flags never stack
    // (src/qwen-tools.ts).
    if (request.tools === "none") {
      cmd.push(...qwenNoToolsArgs());
    } else if (request.web === false) {
      cmd.push(...qwenNoWebArgs());
    }
    // Every run reads the stream-json wire: the result message carries
    // only the last assistant message, so the complete answer is rebuilt
    // from the assistant messages (src/qwen-stream-answer.ts, lane AN1).
    cmd.push("--output-format", "stream-json");
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    return experiment ? ["env", ...experiment.envAssignments, ...cmd] : cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return this.isLegacyBinary ? null : request.prompt;
  }

  override getRunEnv(
    request: RunRequest,
    context?: RunContext
  ): Record<string, string> {
    if (this.isLegacyBinary) return {};
    const env: Record<string, string> = this.providerEnv(request.model);
    // The settings file exists whenever prepareRun wrote one — an effort
    // tier, a context cap, or both — so the env follows the context, not
    // the request fields. A tier without its file is a launch-order bug
    // and refuses here, fail closed.
    if (request.effort !== undefined && context?.qwenEffortSettings === undefined && !context?.experimentQwen) {
      throw new Error("qwen effort settings were not prepared before launch");
    }
    if (context?.qwenEffortSettings !== undefined) {
      env[QWEN_EFFORT_SETTINGS_ENV] = context.qwenEffortSettings.path;
    }
    return env;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    if (context?.experimentQwen) return { ...qwenExperimentResult(result, request, context.experimentQwen.recordingPath),
      scanSurface: context.experimentQwen.scanSurface };
    // The run launched with --output-format stream-json; qwenResult
    // re-emits the complete answer with the codemux block, and a plain run
    // prints it.
    // The fold shed tool payloads; the scan covers them (stream-marker-scan.ts).
    return withStreamScanSurface(request.resultJson ? qwenResult(result, request) : qwenPlainResult(result),
      result.stdout, context?.stdoutSink);
  }

  override prepareTuiEnvironment(model?: string, _autonomy?: AutonomyLevel, effort?: ReasoningEffort,
    _sandboxed?: boolean, _passthroughEnv?: readonly string[], printOnly = false) {
    // The run path's own carriers on the interactive path: the provider
    // override's environment (the same providerEnv the run gets) and,
    // for a selected tier, the system settings file — written here
    // because only this hook owns launch-lifetime state on the TUI path,
    // and finalized on every exit path the launcher owns. A print-only
    // preview spawns nothing, so it writes nothing.
    if (this.isLegacyBinary || effort === undefined || printOnly) {
      return { env: this.providerEnv(model), finalize: () => {} };
    }
    const settings = writeQwenEffortSettings(qwenBrandHome(this.environment), effort);
    return {
      env: {
        ...this.providerEnv(model),
        [QWEN_EFFORT_SETTINGS_ENV]: settings.path,
      },
      finalize: () => settings.finalize(),
    };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    if (request.experimentMcp && this.isLegacyBinary) {
      throw new UsageRefusalError("qwen-coder has no explicit MCP configuration carrier; install qwen 0.24.0 or newer");
    }
    if (request.experimentMcp) assertQwenExperimentCwd(request.cwd ?? process.cwd());
    if (request.effort !== undefined && request.passthroughEnv?.includes(QWEN_EFFORT_SETTINGS_ENV)) {
      // The child's environment points the system settings layer at this
      // run's effort file, so an operator pass-through of the same name
      // would silently fight the tier the run asked for.
      throw new UsageRefusalError(
        `qwen --effort owns the system settings layer; remove --pass-env ${QWEN_EFFORT_SETTINGS_ENV}`
      );
    }
    // Surface a half-configured override before launch: a missing baseUrl,
    // apiKey or model would otherwise let qwen's own default auth answer.
    this.validatedProvider();
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
    this.validatedProvider();
    // The TUI's injected environment points the system settings layer at
    // the launch's own effort file, so an operator pass-through of the
    // same name would silently fight the tier this launch asked for —
    // the run path's rule, verbatim.
    if (effort !== undefined && passthroughEnv.includes(QWEN_EFFORT_SETTINGS_ENV)) {
      throw new UsageRefusalError(
        `qwen --effort owns the system settings layer; remove --pass-env ${QWEN_EFFORT_SETTINGS_ENV}`
      );
    }
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean
  ): string[] {
    const binary = this.resolveBinary();
    if (this.isLegacyBinary) {
      if (model) {
        throw new Error("qwen-coder does not support model selection");
      }
      if (!sandboxed) {
        throw new Error(
          "qwen-coder cannot enforce autonomy levels; use --sandbox or install the current qwen CLI"
        );
      }
      return [binary];
    }

    const cmd = [binary, "--safe-mode"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  /** The qwen login read: a credential variable in the environment. */
  override loginState(): LoginState {
    return envKeyLoginState(this.id, this.environment);
  }
}
