import { dirname, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoCopilotProjectExecutionConfig } from "../project-safety.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  LaunchIntent,
  ReasoningEffort,
  RunRequest,
  RunResult,
} from "../types.js";
import { copilotLoginState, loginHome, type LoginState } from "../harness-health.js";
import { createCopilotHermeticHome } from "../copilot-hermetic.js";
import { copilotResult } from "../result-envelope/copilot.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import { copilotProvider, copilotProviderEnv, copilotProviderOmissions, createCopilotProviderFile, type CopilotProviderFile } from "../copilot-provider.js";
import { createCopilotUsageFile, readCopilotUsageFile, type CopilotRunContext } from "../copilot-usage.js";
import { buildCopilotPlaywrightMcp } from "../copilot-mcp.js";
import type { ExecutableCheck } from "../executable-security.js";
import { applyCopilotProjectSandbox, validateCopilotProjectSettingsRun } from "../copilot-project-settings.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { CopilotExperimentRun } from "../copilot-experiment-run.js";
import { buildCopilotRpcLaunch } from "../session/copilot-rpc-config.js";
import { CopilotModelRun } from "../copilot-model-run.js";

const PKG_CACHE_ENV = "COPILOT_PKG_CACHE_HOME";
const CACHE_ENV = "COPILOT_CACHE_HOME";

// A name that matches none of copilot's tools. `--available-tools
// [tools...]` is the documented allowlist ("Only these tools will be
// available to the model"; its help text: "The --available-tools option
// disables all other tools"), and the CLI's own normalizer `sW` maps every
// empty spelling to "no filter": the flag with no values arrives as the
// boolean true and returns undefined, and every value string of length
// zero is filtered out before the length check that collapses the list to
// undefined (installed @github/copilot 1.0.85 app.js and 1.0.103
// copilot.tgz/package/cli-main.js, read 2026-11-09). That is why the
// 2026-09-17 live probes left tools armed under every empty spelling: the
// filter never engaged. A NON-empty value engages it, so a name that is no
// tool's name leaves the registry empty.
const NO_TOOLS_SENTINEL = "codemux-no-tools";

// `--tools none` evidence (1.0.85): see NO_TOOLS_SENTINEL above. The
// sentinel passes the parser and empties the registry through the filter,
// the mechanism the empty spellings could not reach.

export class CopilotAdapter extends BaseAdapter {
  // The environment the adapter sees is the one its factory was handed:
  // `verify` passes only PATH so an exported override cannot
  // change its rows, and a run passes the real one.
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }
  readonly id: AgentId = "copilot";
  readonly binaryName = "copilot";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Hermetic: COPILOT_HOME redirects the config directory the CLI's own
      // resolvers read (`configDir ?? COPILOT_HOME ?? ~/.copilot`; the
      // `--config-dir` help "Deprecated: use COPILOT_HOME env var instead";
      // installed @github/copilot 1.0.85 app.js and 1.0.103
      // copilot.tgz/package/cli-main.js, read 2026-11-09) — custom
      // instructions (`copilot-instructions.md`, the channel the 2026-09-17
      // live control leaked), settings.json, installed plugins, and session
      // state all live there. A fresh directory plus the hard-linked login
      // closes every home channel (src/copilot-hermetic.ts); the workspace
      // channel is already closed by --no-custom-instructions on every run.
      // The check's control drops that flag only, with both probes using
      // the scratch config in src/check-hermetic-plan.ts (homeCheckAdapter).
      // Tools none: the sentinel allowlist above. Result JSON:
      // `--output-format json` ("JSONL, one JSON object per line", the
      // flag's own help, same bundle), a final result line included
      // (src/result-envelope/copilot.ts holds the field evidence).
      supportsHermetic: true,
      supportsToolSelection: true,
      supportsResultJson: true,
      supportsProviderOverride: true,
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
    // `--reasoning-effort`, not `--effort`. `--effort` was a shorthand alias upstream added in
    // v1.0.10 and has since dropped; `--reasoning-effort` has been the canonical flag since
    // v1.0.4. Codemux kept passing the alias, so every `codemux run -a copilot --effort <level>`
    // failed on an unknown option. The
    // installed-contract suite pins the real name and `make release-gate` runs it on every PR. It
    // caught nothing because it skips a binary absent from the machine, and no machine in the loop
    // had copilot installed -- CI runners carry no harness CLIs.
    //
    // Verified 2026-09-21 against copilot 1.0.85's own `--help`: it lists
    // `--reasoning-effort <level>` with `[possible values: none, minimal, low, medium, high,
    // xhigh, max]` and no `--effort`. The values are unchanged, so the level passes through raw --
    // unlike Droid, which maps `none` to `off` for the same flag name.
    return ["--reasoning-effort", level];
  }

  /** The real copilot config directory the private home's parent lives under. */
  private realConfigDir(): string {
    return join(loginHome(this.environment), ".copilot");
  }

  override prepareRun(
    request: RunRequest,
    _sandboxTrust?: ScodeTrustLevel,
    sandboxOptions?: SandboxOptions,
    launch: LaunchIntent = {}
  ): CopilotRunContext {
    if (request.experimentProjectSettings) {
      validateCopilotProjectSettingsRun(request);
      if (sandboxOptions === undefined) {
        throw new UsageRefusalError("copilot project settings require prepared sandbox options");
      }
    }
    const context: CopilotRunContext = {};
    try {
      const experiment = request.experimentMcp ? readExperimentRunSpec(request) : undefined;
      if (experiment && !request.hermetic && !experiment.control) throw new UsageRefusalError("Copilot experiment requires a private hermetic home");
      if (request.hermetic || experiment) {
        context.copilotHermeticHome = createCopilotHermeticHome(this.realConfigDir(), {
          printOnly: launch.printOnly === true,
        });
      }
      if (request.resultJson && !experiment && !launch.printOnly) {
        context.copilotUsageFile = createCopilotUsageFile(this.realConfigDir());
      }
      const provider = copilotProvider(this.environment);
      if (provider?.maxContextTokens !== undefined && !launch.printOnly) {
        context.copilotProviderFile = createCopilotProviderFile(this.realConfigDir(), provider, request.model);
      }
      if (request.experimentProjectSettings) {
        const artifacts = [context.copilotUsageFile?.path, context.copilotProviderFile?.path]
          .filter((path): path is string => path !== undefined).map(dirname);
        applyCopilotProjectSandbox(sandboxOptions!, this.realConfigDir(), context.copilotHermeticHome!.home, artifacts);
      }
      if (experiment && !launch.printOnly) {
        this.prepareCopilotExperiment(request, context, experiment);
      }
      return context;
    } catch (error) {
      this.cleanupRunSync(context);
      throw error;
    }
  }

  /** A paired check may supply its own disposable instruction home. */
  prepareCopilotExperiment(request: RunRequest, context: CopilotRunContext, spec = readExperimentRunSpec(request)): void {
    if (!context.copilotHermeticHome) throw new Error("Copilot experiment requires a prepared home");
    const provider = copilotProvider(this.environment);
    if (!context.copilotProviderFile && provider?.maxContextTokens !== undefined) context.copilotProviderFile = createCopilotProviderFile(this.realConfigDir(), provider, request.model);
    const native = buildCopilotRpcLaunch({ adapter: this, request: { ...request, experimentMcp: undefined }, context,
      harnessHome: this.realConfigDir(), turn: { text: request.prompt, sessionId: null, firstTurn: true,
        hermeticHome: context.copilotHermeticHome.home, autonomy: request.autonomy ?? "read-only", model: request.model, effort: request.effort } });
    context.copilotExperimentArgv = spec.control ? native.argv.filter((arg) => arg !== "--no-custom-instructions") : native.argv;
    context.experimentCopilot = new CopilotExperimentRun(spec, request.cwd ?? process.cwd(), this.environment, request.prompt, native.config);
    context.stdoutSink = context.experimentCopilot;
    context.experimentRecording = context.experimentCopilot.recordingPath;
  }

  /** Shared launch calls this only after its sandbox/network validation. */
  prepareCopilotModelRun(request: RunRequest, context: CopilotRunContext): void {
    if (request.sandboxNoNet || request.sandboxTrust === "untrusted") throw new UsageRefusalError("Copilot model-response observation requires network access; it cannot bypass sandbox network denial");
    const native = buildCopilotRpcLaunch({ adapter: this, request, context, harnessHome: this.realConfigDir(),
      turn: { text: request.prompt, sessionId: null, firstTurn: true, hermeticHome: context.copilotHermeticHome?.home ?? null,
        autonomy: request.autonomy ?? "read-only", model: request.model, effort: request.effort } });
    context.copilotModelArgv = native.argv;
    context.copilotModelRun = new CopilotModelRun(request.prompt, native.config, request.autonomy ?? "read-only");
    context.stdoutSink = context.copilotModelRun;
  }

  override cleanupRunSync(context?: RunContext): void {
    try {
      (context as CopilotRunContext | undefined)?.copilotModelRun?.closeProtocol();
      (context as CopilotRunContext | undefined)?.experimentCopilot?.closeSync();
    } finally {
      try {
        (context as CopilotRunContext | undefined)?.copilotUsageFile?.finalize();
      } finally {
        try { (context as CopilotRunContext | undefined)?.copilotProviderFile?.finalize(); }
        finally { context?.copilotHermeticHome?.finalize(); }
      }
    }
  }

  override cleanupRun(context?: CopilotRunContext): void | Promise<void> {
    if (context?.experimentCopilot) return context.experimentCopilot.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  override getRunEnv(request: RunRequest, _context?: RunContext): Record<string, string> {
    return {
      ...this.getPackageCacheEnv(request.sandboxed, request.passthroughEnv),
      ...copilotProviderEnv(this.environment, request.model),
    };
  }

  override getEnvOmissions(): string[] {
    return copilotProviderOmissions(this.environment);
  }

  override buildExecutionEnv(extraEnv: Record<string, string> = {}, passthroughEnv: readonly string[] = []): Record<string, string> {
    const env = super.buildExecutionEnv(extraEnv, passthroughEnv);
    // The omission removes ambient provider files. The TUI preparation
    // supplies this launch's private file explicitly after that removal.
    if (extraEnv.COPILOT_PROVIDERS_CONFIG !== undefined) env.COPILOT_PROVIDERS_CONFIG = extraEnv.COPILOT_PROVIDERS_CONFIG;
    return env;
  }

  override getTuiEnv(
    model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean,
    passthroughEnv?: readonly string[]
  ): Record<string, string> {
    return {
      ...this.getPackageCacheEnv(sandboxed, passthroughEnv),
      ...copilotProviderEnv(this.environment, model),
    };
  }

  private getPackageCacheEnv(
    sandboxed?: boolean,
    passthroughEnv?: readonly string[]
  ): Record<string, string> {
    if (
      !sandboxed || process.platform !== "darwin" ||
      this.environment.HOME === undefined ||
      // The passthrough is the authorization: either cache name passed
      // through and set — an empty string included — is the operator's
      // value and suppresses the cache redirect (review round 361; a name
      // passed through but never set carries nothing to preserve).
      (passthroughEnv?.includes(PKG_CACHE_ENV) && this.environment[PKG_CACHE_ENV] !== undefined) ||
      (passthroughEnv?.includes(CACHE_ENV) && this.environment[CACHE_ENV] !== undefined)
    ) return {};
    // Copilot appends pkg/<platform> to this root. Scode permits this cache,
    // while macOS's default ~/Library/Caches/copilot is blocked.
    return { [PKG_CACHE_ENV]: join(this.environment.HOME, ".cache", "copilot") };
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const modelArgv = (context as CopilotRunContext | undefined)?.copilotModelArgv;
    if (modelArgv) return [...modelArgv];
    if (request.experimentMcp) {
      const argv = (context as CopilotRunContext | undefined)?.copilotExperimentArgv;
      if (argv === undefined) throw new Error("Copilot experiment RPC launch was not prepared");
      return [...argv];
    }
    const cmd: string[] = [];
    const providerFile = (context as CopilotRunContext | undefined)?.copilotProviderFile;
    if (copilotProvider(this.environment)?.maxContextTokens !== undefined) {
      const path = providerFile?.path ?? join(this.realConfigDir(), ".codemux-hermetic", "unprepared", "providers.json");
      cmd.push("env", `COPILOT_PROVIDERS_CONFIG=${path}`);
    }
    if (request.hermetic) {
      // Assigned inside the sandbox command, never the run environment:
      // scode resolves its own state through HOME-adjacent variables and
      // must keep the operator's real values (the kimi rule). Static
      // previews (verify) pass no context and get a placeholder path that
      // names no real directory.
      const home = context?.copilotHermeticHome?.home ??
        join(this.realConfigDir(), ".codemux-hermetic", "unprepared");
      cmd.push("env", `COPILOT_HOME=${home}`);
    }
    cmd.push(
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      ...(request.experimentProjectSettings ? [] : ["--no-custom-instructions"]),
      "--no-experimental"
    );
    if ((request.autonomy ?? "read-only") !== "high") {
      cmd.push("--disable-builtin-mcps");
    }
    if (request.model || providerFile !== undefined) {
      cmd.push("--model", providerFile?.modelId ?? request.model!);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    if (request.tools === "none") {
      cmd.push("--available-tools", NO_TOOLS_SENTINEL);
    }
    if (request.web === false) {
      cmd.push("--excluded-tools", "web_fetch", "web_search",
        "--deny-tool", "github-mcp-server(web_search)");
    }
    const playwright = buildCopilotPlaywrightMcp(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(), pathEnv: this.executionPathEnv(),
    });
    cmd.push(...playwright.args);
    if (context !== undefined) context.playwrightMcpCheck = playwright.check;
    if (request.resultJson) {
      cmd.push("--output-format", "json");
      const usagePath = (context as CopilotRunContext | undefined)?.copilotUsageFile?.path;
      if (usagePath !== undefined) cmd.push("--usage-output-file", usagePath);
    }
    cmd.push("--silent");
    return cmd;
  }

  override getStdinInput(request: RunRequest): string {
    // 1.0.103 cli-main.js ryo: e.prompt || await Fho(process.stdin).
    // A pipe selects non-interactive prompt mode without a -p argument.
    return request.prompt;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    const modelRun = (context as CopilotRunContext | undefined)?.copilotModelRun;
    if (modelRun) return copilotResult(result, request, modelRun.usage
      ? { usage: modelRun.usage, servedModel: modelRun.evidence.servedModel } : { error: "native usage is missing" });
    const experiment = (context as CopilotRunContext | undefined)?.experimentCopilot;
    if (experiment) {
      const processed = copilotResult(result, request, experiment.usage ? { usage: experiment.usage } : { error: "experiment usage is missing" });
      let envelope;
      try { envelope = JSON.parse(processed.stdout); }
      catch { return { ...processed, scanSurface: experiment.capturedOutput }; }
      if (envelope.codemux) envelope.codemux.recording = experiment.recordingPath;
      return { ...processed, stdout: JSON.stringify(envelope) + "\n", scanSurface: experiment.capturedOutput };
    }
    if (!request.resultJson) return result;
    const usageFile = (context as CopilotRunContext | undefined)?.copilotUsageFile;
    if (usageFile === undefined) return copilotResult(result, request);
    try {
      return copilotResult(result, request, { usage: readCopilotUsageFile(usageFile) });
    } catch {
      return copilotResult(result, request, { error: "usage output is missing or invalid" });
    }
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    copilotProvider(this.environment);
    if (request.experimentProjectSettings) validateCopilotProjectSettingsRun(request);
    else assertNoCopilotProjectExecutionConfig(validateWorkingDirectory(request.cwd) ?? process.cwd());
    if (request.hermetic) {
      if (request.passthroughEnv?.includes("COPILOT_HOME")) {
        throw new UsageRefusalError("copilot --hermetic owns COPILOT_HOME; remove --pass-env COPILOT_HOME");
      }
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
    copilotProvider(this.environment);
    assertNoCopilotProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  /** The shared TUI launch owns this artifact through its final wait. */
  prepareTuiProvider(model?: string, printOnly = false): CopilotProviderFile | undefined {
    const provider = copilotProvider(this.environment);
    if (provider?.maxContextTokens === undefined) return undefined;
    if (printOnly) return { path: join(this.realConfigDir(), ".codemux-hermetic", "preview", "providers.json"),
      modelId: "codemux/model", finalize() {} };
    return createCopilotProviderFile(this.realConfigDir(), provider, model);
  }

  override prepareTuiEnvironment(model?: string, autonomy?: AutonomyLevel, effort?: ReasoningEffort,
    sandboxed?: boolean, passthroughEnv?: readonly string[], printOnly = false) {
    const file = this.prepareTuiProvider(model, printOnly);
    return { env: { ...this.getTuiEnv(model, autonomy, effort, sandboxed, passthroughEnv),
      ...(file === undefined ? {} : { COPILOT_PROVIDERS_CONFIG: file.path }) }, finalize: () => file?.finalize() };
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string,
    nestedChecks?: ExecutableCheck[],
    providerFile?: CopilotProviderFile
  ): string[] {
    const contextCap = copilotProvider(this.environment)?.maxContextTokens !== undefined;
    const cmd = [
      ...(providerFile === undefined ? [] : ["env", `COPILOT_PROVIDERS_CONFIG=${providerFile.path}`]),
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
    if (model || providerFile !== undefined || contextCap) {
      cmd.push("--model", contextCap ? "codemux/model" : providerFile?.modelId ?? model!);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    const playwright = buildCopilotPlaywrightMcp(sandboxed, {
      enabled: enablePlaywrightMcp, forbiddenRoot: cwd ?? process.cwd(),
      pathEnv: this.executionPathEnv(),
    });
    cmd.push(...playwright.args);
    if (playwright.check !== null) nestedChecks?.push(playwright.check);
    return cmd;
  }

  /** The copilot login read: a GitHub token in the environment or its config. */
  override loginState(): LoginState {
    return copilotLoginState(loginHome(this.environment), this.environment);
  }
}
