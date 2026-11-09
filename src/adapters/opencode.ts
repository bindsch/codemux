import { join } from "node:path";
import { BaseAdapter } from "./base.js";
import { OpencodeExperimentRun, OPENCODE_EXPERIMENT_TOKEN_ENV, type OpencodeExperimentContext as RunContext } from "../opencode-experiment-run.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { createOpencodeHermeticHome } from "../opencode-hermetic.js";
import { opencodeRemoteConfigCarrier } from "../opencode-remote-config.js";
import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_KEY_ENV,
  opencodeBareModel,
  opencodeLimit,
  opencodeProviderConfig,
  writeOpencodeProviderConfig,
} from "../opencode-provider.js";
import { assertNoOpenCodeProjectExecutionConfig } from "../project-safety.js";
import { assertNoAncestorOpenCodeProjectConfig } from "../opencode-project-settings.js";
import { validateProjectSettingsRunRequest } from "../claude-project-settings.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
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
} from "../types.js";
import { OpenCodePlainFold, openCodeResultData, opencodePlainResult } from "../plain-unwrap.js";
import { opencodeResult } from "../result-envelope/opencode.js";
import { appendDiagnostic } from "../result-envelope/common.js";
import {
  hermeticRemoteConfigRefusal,
  OPENCODE_HERMETIC_ENV,
  OPENCODE_NO_TOOLS_PERMISSION,
  PLAIN_NO_TOOLS_REFUSAL,
} from "./opencode-env.js";
import { assertAbsoluteOpencodeXdgHome, opencodeRealDataDir, opencodeRealDataParent, opencodeRealStateDir } from "./opencode-home.js";
import { fileStoreLoginState, type LoginState } from "../harness-health.js";
import { opencodeNoWebConfig, opencodePlaywrightConfig } from "../opencode-launch-config.js";
import type { ExecutableCheck } from "../executable-security.js";
import { prepareOpencodeTuiEffort, validateOpencodeTuiEffortModel } from "../opencode-tui-effort.js";

export { opencodeRealDataParent, opencodeRealDataDir } from "./opencode-home.js";

export class OpencodeAdapter extends BaseAdapter {
  readonly id: AgentId = "opencode";
  readonly binaryName = "opencode";

  // Seams so tests can point the real data directory at a scratch directory.
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
      effortLevels: ["none", "low", "medium", "high"],
      // Plain operator config can override the global deny per agent.
      // Hermetic runs also refuse login-supplied remote configuration.
      supportsHermetic: true,
      supportsToolSelection: true,
      toolsNoneRequiresHermetic: true,
      // Plain and envelope results fold the same bounded JSON event stream.
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--agent", "plan"];
      case "low":
        return ["--agent", "build"];
      case "medium":
        return ["--agent", "build"];
      case "high":
        return ["--agent", "build", "--auto"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--variant", level];
  }

  override supportsTuiEffort(): boolean {
    return true;
  }

  /** Login state location for the remote-config inspection. */
  private realDataDir(): string {
    return opencodeRealDataDir(this.environment, this.homeDirectory);
  }

  /** Read fresh: login-supplied settings can change between validation and launch. */
  private remoteConfigCarrier(): string | null {
    return opencodeRemoteConfigCarrier(this.realDataDir());
  }

  /** Custom providers require a base URL and key in native configuration. */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("opencode", this.environment);
    if (override === null) return null;
    return requireProviderOverride("opencode", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The bare model id: the request's, else the override's. */
  private rawModelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "opencode needs a model for the provider override; pass --model or set CODEMUX_OPENCODE_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /** The `--model` value: with an override, the config's provider id routes to it. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = this.rawModelFor(model);
    if (resolved === undefined || override === null) return resolved;
    return resolved.startsWith(`${OPENCODE_PROVIDER_ID}/`)
      ? resolved
      : `${OPENCODE_PROVIDER_ID}/${resolved}`;
  }

  /** The wire `--model` value for a launch the caller builds itself (the
   * session driver's per-turn spawns): exactly what buildRunCommand would
   * pass, so the session turns and the run path cannot drift. */
  wireModelFor(model: string | undefined): string | undefined {
    return this.modelFor(model);
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];

    const experiment = context?.experimentOpencode;
    if (request.experimentMcp && !experiment) throw new Error("OpenCode experiment was not prepared");
    if (request.experimentProjectSettings && !request.hermetic) {
      throw new UsageRefusalError("--experiment-project-settings requires --hermetic");
    }

    const envPrefix: string[] = [];
    if (experiment) envPrefix.push("-u", "OPENCODE_PURE", "-u", "OPENCODE_EXPERIMENTAL_NATIVE_LLM");
    if (request.hermetic) {
      const carrier = this.remoteConfigCarrier();
      if (carrier !== null) {
        throw new UsageRefusalError(hermeticRemoteConfigRefusal(carrier));
      }
      if (request.experimentProjectSettings) {
        assertNoAncestorOpenCodeProjectConfig(request.cwd ?? process.cwd());
      }
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and getRunEnv refuses a launch without one, so
      // a command built without prepareRun fails closed. The same holds for
      // the provider config's path.
      const unprepared = join(this.realDataDir(), ".codemux-hermetic", "unprepared");
      const home = context?.opencodeHermeticHome?.home ?? unprepared;
      envPrefix.push(
        ...OPENCODE_HERMETIC_ENV(
          home,
          // The XDG data parent a plain run sees (opencode-home.ts):
          // XDG_DATA_HOME passes through the sanitized child environment,
          // so an operator who relocated it keeps their login.
          opencodeRealDataParent(this.environment, this.homeDirectory),
          context?.opencodeProviderConfig?.path ?? null,
          request.experimentProjectSettings === true
        )
      );
    }
    if (request.tools === "none" && !experiment) {
      // Hermetic only: on a plain run the operator's config can override
      // the deny per agent (OPENCODE_NO_TOOLS_PERMISSION above), so the
      // capability refuses there instead of launching a run whose deny
      // silently does not hold. validateRunRequest answers the CLI path;
      // this fails every other builder closed.
      if (!request.hermetic) {
        throw new UsageRefusalError(PLAIN_NO_TOOLS_REFUSAL);
      }
      envPrefix.push(OPENCODE_NO_TOOLS_PERMISSION);
    }
    const mcp = opencodePlaywrightConfig(request.sandboxed, request.enablePlaywrightMcp,
      this.executionPathEnv(), request.cwd);
    if (context) context.playwrightMcpCheck = mcp.check;
    const noWeb = request.web === false ? opencodeNoWebConfig(request.autonomy) : undefined;
    if (request.web === false || mcp.check || experiment) {
      this.assertNoRemoteLaunchConfig();
      const config = { ...noWeb?.config, ...mcp.config, ...experiment?.config };
      envPrefix.push(`OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`);
    }
    if (envPrefix.length > 0) {
      cmd.push("env", ...envPrefix);
    }
    // Installed bin/opencode 1.19.5, UTF-16LE byte 102534694 (2026-11-09):
    // `let T=n.pure?[]:y.plugin_origins??[];` excludes every external plugin,
    // including a private-home observer. No per-origin exception exists.
    // Project-settings and experiment runs explicitly enable their plugins.
    cmd.push("opencode");
    if (!request.experimentProjectSettings && !experiment) cmd.push("--pure");
    cmd.push("run");
    // Plain results and envelopes share the native event stream.
    cmd.push("--format", "json");

    const model = this.modelFor(request.model);
    if (model) {
      cmd.push("--model", model);
    }

    if (experiment) {
      cmd.push("--agent", experiment.agent);
    } else if (noWeb) {
      cmd.push("--agent", noWeb.agent);
      if (request.autonomy === "high") cmd.push("--auto");
    } else if (request.autonomy) {
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

  override processRunResult(
    result: RunResult,
    request: RunRequest,
    context?: RunContext
  ): RunResult {
    if (context?.experimentOpencode) result = { ...result, scanSurface: context.experimentOpencode.scanSurface(),
      stderr: appendDiagnostic(result.stderr, `codemux: experiment MCP recording: ${context.experimentRecording}`) };
    const sink = context?.experimentOpencode?.fold ?? context?.stdoutSink;
    if (request.resultJson) {
      const data = sink instanceof OpenCodePlainFold
        ? sink.resultData()
        : openCodeResultData(result.stdout);
      return opencodeResult(
        result,
        request,
        data,
        context?.opencodeSelectedModel ?? request.model ?? null,
        context?.experimentRecording ?? null,
        context?.experimentOpencode?.servedModel ?? null
      );
    }
    if (sink instanceof OpenCodePlainFold) return { ...sink.verdict(result), servedModel: context?.experimentOpencode?.servedModel ?? null };
    return opencodePlainResult(result);
  }

  override prepareRun(request: RunRequest): RunContext {
    if (request.web === false || request.enablePlaywrightMcp || request.experimentMcp) this.assertNoRemoteLaunchConfig();
    // Programmatic launches enforce the same project-settings gate as the CLI.
    if (request.experimentProjectSettings) {
      validateProjectSettingsRunRequest(request);
    }
    // Per-run artifacts belong to the launcher, never the singleton adapter.
    const context: RunContext = {};
    const override = this.validatedProvider();
    if (override !== null) {
      const model = this.rawModelFor(request.model);
      if (model !== undefined) {
        context.opencodeProviderConfig = writeOpencodeProviderConfig(
          this.realDataDir(),
          override,
          model
        );
      }
    }
    context.opencodeSelectedModel = this.rawModelFor(request.model);
    if (request.hermetic || request.experimentMcp) {
      try {
        context.opencodeHermeticHome = createOpencodeHermeticHome(
          this.realDataDir(),
          opencodeRealStateDir(this.environment, this.homeDirectory)
        );
        if (request.experimentMcp) {
          context.experimentOpencode = new OpencodeExperimentRun(readExperimentRunSpec(request), request.cwd ?? process.cwd(),
            context.opencodeHermeticHome.home, this.environment, request.prompt);
          context.experimentRecording = context.experimentOpencode.recordingPath;
        }
      } catch (error) {
        // The provider configuration above is already on disk; a context
        // that never reaches the launcher would strand it (review round 39).
        this.cleanupRunSync(context);
        throw error;
      }
    }
    // Streaming keeps reply and usage while dropping completed tool events.
    context.stdoutSink = context.experimentOpencode ?? new OpenCodePlainFold();
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    // Attempt every finalizer even when one fails; report all retained artifacts.
    const failures: unknown[] = [];
    try { context?.experimentOpencode?.closeSync(); } catch (error) { failures.push(error); }
    for (const artifact of [context?.opencodeHermeticHome, context?.opencodeProviderConfig]) {
      if (artifact === undefined) continue;
      try { artifact.finalize(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const messages = failures.map((f) => f instanceof Error ? f.message : String(f));
      throw new AggregateError(failures, `codemux: opencode cleanup failed ${failures.length} times: ${messages.join("; ")}`);
    }
  }

  override cleanupRun(context?: RunContext): void | Promise<void> {
    if (context?.experimentOpencode) return context.experimentOpencode.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  override getRunEnv(
    request: RunRequest,
    context?: RunContext
  ): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // OpenCode's side only in effect, so this is the codemux-side guarantee.
    if (request.hermetic && context?.opencodeHermeticHome === undefined) {
      throw new Error("opencode hermetic home was not prepared before launch");
    }
    const experimentEnv: Record<string, string> = context?.experimentOpencode ? { [OPENCODE_EXPERIMENT_TOKEN_ENV]: context.experimentOpencode.relay.token } : {};
    const override = this.validatedProvider();
    if (override === null) return experimentEnv;
    const config = context?.opencodeProviderConfig;
    if (config === undefined) {
      throw new Error("opencode provider config was not prepared before launch");
    }
    // The key rides the environment codemux provides, never argv and never a
    // file. OPENCODE_CONFIG reaches a hermetic run through the env prefix
    // (an env(1) assignment would clobber it here); a plain run has no
    // prefix, so it rides along.
    if (request.hermetic) {
      return { ...experimentEnv, [OPENCODE_PROVIDER_KEY_ENV]: override.apiKey };
    }
    return {
      ...experimentEnv,
      [OPENCODE_PROVIDER_KEY_ENV]: override.apiKey,
      OPENCODE_CONFIG: config.path,
    };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    if (request.web === false || request.enablePlaywrightMcp || request.experimentMcp) this.assertNoRemoteLaunchConfig();
    // The inherited XDG directories are refused while still relative,
    // before any walk or spawn: OpenCode resolves them against the run's
    // working directory, past every check below (review round 286).
    assertAbsoluteOpencodeXdgHome(this.environment);
    // The project-settings gates, surfaced early with their reasons (the
    // build path fails closed on the same two rules).
    if (request.experimentProjectSettings) {
      if (!request.hermetic) {
        throw new UsageRefusalError("--experiment-project-settings requires --hermetic");
      }
      assertNoAncestorOpenCodeProjectConfig(request.cwd ?? process.cwd());
    }
    // The working directory's own opencode.json/.opencode are the point of
    // --experiment-project-settings, so that mode exempts the working
    // directory itself; every ancestor this walk reaches is still refused.
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd(),
      request.experimentProjectSettings === true
    );
    // Operator per-agent permissions can override a plain run's global denial.
    if (request.tools === "none" && !request.hermetic && !request.experimentMcp) {
      throw new UsageRefusalError(PLAIN_NO_TOOLS_REFUSAL);
    }
    // The hermetic remote-config refusal, surfaced with its reason too:
    // the login's own configuration channel (opencode-remote-config.ts).
    if (request.hermetic) {
      const carrier = this.remoteConfigCarrier();
      if (carrier !== null) {
        throw new UsageRefusalError(hermeticRemoteConfigRefusal(carrier));
      }
    }
    // Validate model substitutions and the paired context/output token caps.
    const resolved = this.modelFor(request.model);
    const override = this.validatedProvider();
    if (resolved !== undefined && override !== null) {
      opencodeBareModel(resolved);
      opencodeLimit(override);
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
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    // The inherited XDG directories, the run boundary's rule (review
    // round 286): a relative value resolves beneath the session's working
    // directory inside OpenCode, past the walk below.
    assertAbsoluteOpencodeXdgHome(this.environment);
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    this.tuiProviderConfig(model);
    if (effort !== undefined) validateOpencodeTuiEffortModel(this.modelFor(model));
    if (enablePlaywrightMcp || this.validatedProvider()) this.assertNoRemoteLaunchConfig();
  }

  private assertNoRemoteLaunchConfig(): void {
    const carrier = this.remoteConfigCarrier();
    if (carrier !== null) throw new UsageRefusalError(
      `opencode launch configuration is refused while the login carries remote configuration: ${carrier}; it can override the requested native settings`
    );
  }

  private tuiProviderConfig(model?: string): Record<string, unknown> {
    const override = this.validatedProvider();
    return override ? opencodeProviderConfig(override, this.rawModelFor(model)!) : {};
  }

  override getTuiEnv(model?: string): Record<string, string> {
    const override = this.validatedProvider();
    if (!override) return {};
    this.assertNoRemoteLaunchConfig();
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(this.tuiProviderConfig(model)),
      [OPENCODE_PROVIDER_KEY_ENV]: override.apiKey,
    };
  }

  /** The launcher owns private effort state until the TUI settles. */
  override prepareTuiEnvironment(model?: string, _autonomy?: AutonomyLevel, effort?: ReasoningEffort,
    _sandboxed?: boolean, _passthroughEnv?: readonly string[], printOnly = false) {
    const env = this.getTuiEnv(model);
    if (effort === undefined) return { env, finalize: () => {} };
    const selected = validateOpencodeTuiEffortModel(this.modelFor(model));
    if (printOnly) return { env: { ...env, XDG_STATE_HOME: join(this.realDataDir(), ".codemux-hermetic", "unprepared", ".local", "state") }, finalize: () => {} };
    const prepared = prepareOpencodeTuiEffort(this.realDataDir(), selected, effort);
    return { env: { ...env, ...prepared.env }, finalize: prepared.finalize };
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string,
    nestedChecks?: ExecutableCheck[]
  ): string[] {
    const mcp = opencodePlaywrightConfig(sandboxed, enablePlaywrightMcp, this.executionPathEnv(), cwd);
    const cmd: string[] = [];
    if (mcp.check) {
      this.assertNoRemoteLaunchConfig();
      nestedChecks?.push(mcp.check);
      cmd.push("env", `OPENCODE_CONFIG_CONTENT=${JSON.stringify({ ...this.tuiProviderConfig(model), ...mcp.config })}`);
    }
    cmd.push("opencode", "--pure");
    const selected = this.modelFor(model);
    if (selected) {
      cmd.push("--model", selected);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  /** The opencode login read: auth.json in the real data directory. */
  override loginState(): LoginState {
    return fileStoreLoginState(join(this.realDataDir(), "auth.json"), "the opencode data directory's auth.json");
  }
}
