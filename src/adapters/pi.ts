import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import {
  PI_AGENT_DIR_ENV,
  PI_PROVIDER_KEY_ENV,
  createPiHermeticAgentDir,
  piProviderModelSelector,
  piProviderBareModel,
  writePiProviderAgentDir,
} from "../pi-provider.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import { UsageRefusalError } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { piLoginState, loginHome, type LoginState } from "../harness-health.js";
import { piResult } from "../result-envelope/pi.js";
import { preparePiPlaywright, type PiMcpRunContext } from "../pi-mcp-launch.js";
import { piNativeSessionDir, preparePiTuiProviderEnvironment } from "../pi-launch.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { PiExperimentRun, PI_EXPERIMENT_TOKEN_ENV } from "../pi-experiment-run.js";
import { preparePiBudget, piBudgetResult, type PiBudgetRunContext } from "../pi-budget.js";

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
      // Hermetic runs on the same relocation the provider override uses:
      // a private agent directory (createPiHermeticAgentDir) holds no
      // SYSTEM.md, settings.json, prompts, themes or skills, the run adds
      // `--no-context-files` so the cwd and its ancestors contribute no
      // AGENTS.md/CLAUDE.md, and `--no-approve` (every headless run)
      // leaves the project untrusted so `<cwd>/.pi/SYSTEM.md` never loads
      // (pi 0.85.1 chunk-JVUZSMYM.js: discoverSystemPromptFile and
      // loadProjectContextFiles, read 2026-11-09). `--tools none` is
      // claimed: verified live at 0.85.1 through the provider override —
      // under `--no-tools` neither capability probe could produce its
      // secret while plain runs produced both.
      supportsHermetic: true,
      supportsToolSelection: true,
      supportsProviderOverride: true,
      supportsResultJson: true,
      budgetLimit: true,
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
      throw new UsageRefusalError(
        "pi needs a model for the provider override; pass --model or set CODEMUX_PI_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /**
   * The agent directory a plain run reads: `~/.pi/agent`, or the
   * operator's passed-through PI_CODING_AGENT_DIR (which replaces every
   * path pi derives from it). The value is used exactly as the child
   * receives it, untrimmed: trimming it here made codemux write its
   * private provider directory under the whitespace-free path while pi
   * itself resolved the value as passed (round 307). A value that is
   * whitespace-only is not absolute and refuses at the same boundary as
   * a relative one.
   */
  private realAgentDir(request: RunRequest): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Pi home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    const base = home && isAbsolute(home) ? home : homedir();
    const passedThrough =
      request.passthroughEnv?.includes(PI_AGENT_DIR_ENV) ?? false;
    const configured = this.environment[PI_AGENT_DIR_ENV];
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        // A caller mistake at the flag boundary, the sibling rule of
        // codex's CODEX_HOME and claude's CLAUDE_CONFIG_DIR: exit 64 at
        // validation, before the quota gate or any "Running with" line.
        throw new UsageRefusalError(`passed-through ${PI_AGENT_DIR_ENV} must be an absolute path`);
      }
      return configured;
    }
    return join(base, ".pi", "agent");
  }

  /** Refuses a passed-through PI_CODING_AGENT_DIR that pi would resolve
   * against the run's working directory. Pi reads the variable on every
   * launch, not only the override's, so both boundaries check every
   * request — a relative value reached ordinary runs and TUI sessions
   * unrefused (review round 286) — and a NUL-carrying value never reaches
   * a spawn. The value is read exactly as the child receives it; an unset
   * or empty value means no relocation and is left alone. */
  private assertAbsoluteAgentDir(passthroughEnv: readonly string[] | undefined): void {
    if (!passthroughEnv?.includes(PI_AGENT_DIR_ENV)) return;
    const configured = this.environment[PI_AGENT_DIR_ENV];
    if (configured === undefined || configured === "") return;
    if (configured.includes("\0")) {
      throw new UsageRefusalError(`passed-through ${PI_AGENT_DIR_ENV} must not contain a NUL byte`);
    }
    if (!isAbsolute(configured)) {
      throw new UsageRefusalError(`passed-through ${PI_AGENT_DIR_ENV} must be an absolute path`);
    }
  }

  override prepareRun(request: RunRequest): PiBudgetRunContext {
    this.validateBudgetPricing(request);
    const context = this.prepareNativeRun(request);
    try { return preparePiBudget(request, context, this.realAgentDir(request)); }
    catch (error) { this.cleanupRunSync(context); throw error; }
  }

  private prepareNativeRun(request: RunRequest): PiMcpRunContext {
    // One private agent directory per run with an override or with
    // --hermetic, never shared and never recorded on the adapter: the
    // launcher owns the returned context and finalizes the directory in
    // cleanupRun when this launch ends.
    const override = this.validatedProvider();
    const model = this.modelFor(request.model);
    const experimentSpec = request.experimentMcp ? readExperimentRunSpec(request) : undefined;
    if (experimentSpec && !request.hermetic && !experimentSpec.control) throw new UsageRefusalError("Pi experiment requires a private hermetic home");
    if (request.hermetic || experimentSpec) {
      const context: PiMcpRunContext = {
        piProviderAgentDir: createPiHermeticAgentDir(
          this.realAgentDir(request),
          override,
          model
        ),
      };
      try {
        if (experimentSpec) {
          const experiment = new PiExperimentRun(experimentSpec, request.cwd ?? process.cwd(),
            context.piProviderAgentDir!.path, this.environment, request.prompt);
          context.experimentPi = experiment;
          context.stdoutSink = experiment;
          context.experimentRecording = experiment.recordingPath;
        }
        return context;
      } catch (error) { this.cleanupRunSync(context); throw error; }
    }
    const context: PiMcpRunContext = override === null || model === undefined ? {} : {
      piProviderAgentDir: writePiProviderAgentDir(
        this.realAgentDir(request),
        override,
        model
      ),
    };
    if (!request.enablePlaywrightMcp) return context;
    try {
      return preparePiPlaywright(request, context, this.realAgentDir(request), this.executionPathEnv());
    } catch (error) { this.cleanupRunSync(context); throw error; }
  }

  nativeSessionDirectory(cwd: string, passthroughEnv?: readonly string[]): string {
    return piNativeSessionDir(this.realAgentDir({ agent: "pi", prompt: "", passthroughEnv }), cwd);
  }

  override prepareTuiEnvironment(model?: string, autonomy?: AutonomyLevel, effort?: ReasoningEffort,
    sandboxed?: boolean, passthroughEnv?: readonly string[], printOnly = false) {
    this.assertAbsoluteAgentDir(passthroughEnv);
    const override = this.validatedProvider();
    const selected = this.modelFor(model);
    if (override === null) return super.prepareTuiEnvironment(model, autonomy, effort, sandboxed, passthroughEnv, printOnly);
    return preparePiTuiProviderEnvironment(
      this.realAgentDir({ agent: "pi", prompt: "", passthroughEnv }), override, selected!
    );
  }

  override cleanupRunSync(context?: PiBudgetRunContext): void {
    try {
      try { context?.piBudget?.directory.finalize(); }
      finally { context?.experimentPi?.closeSync(); context?.piMcpExtension?.directory.finalize(); }
    }
    finally { context?.piProviderAgentDir?.finalize(); }
  }

  override cleanupRun(context?: PiBudgetRunContext): void | Promise<void> {
    if (context?.experimentPi) return context.experimentPi.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  override getRunEnv(
    _request: RunRequest,
    context?: PiMcpRunContext
  ): Record<string, string> {
    const override = this.validatedProvider();
    const agentDir = context?.piProviderAgentDir;
    const experimentEnv: Record<string, string> = context?.experimentPi ? { [PI_EXPERIMENT_TOKEN_ENV]: context.experimentPi.relay.token } : {};
    if (override === null) {
      // A hermetic run without an override still relocates the agent
      // directory; a plain run has nothing to provide.
      return agentDir === undefined ? experimentEnv : { [PI_AGENT_DIR_ENV]: agentDir.path, ...experimentEnv };
    }
    if (agentDir === undefined) {
      throw new Error("pi provider agent directory was not prepared before launch");
    }
    // The key and the relocation ride the environment codemux provides;
    // models.json holds only the key's name.
    return {
      [PI_AGENT_DIR_ENV]: agentDir.path,
      [PI_PROVIDER_KEY_ENV]: override.apiKey,
      ...experimentEnv,
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
      case "high":
        // medium and high have no dedicated flags: pi's default mode
        // already runs every tool. No warning per launch — the capability
        // table (docs/harnesses.md) is the one place this is recorded.
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
    if (request.enablePlaywrightMcp) {
      // An explicit allowlist removes dynamically registered extension
      // tools from Pi's registry. Exclude only the forbidden built-ins;
      // --no-extensions still permits the explicitly passed extension.
      const excluded = request.autonomy === "read-only" ? "bash,powershell,edit,write"
        : request.autonomy === "low" ? "bash,powershell" : null;
      return excluded === null ? [] : ["--no-extensions", "--exclude-tools", excluded];
    }
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

  buildRunCommand(request: RunRequest, context?: PiBudgetRunContext): string[] {
    // --no-web denies built-in web tools, as on Claude; it does not deny
    // shell networking or extension tools. Pi 0.85.1 has no built-in web
    // tools (dist/core/tools/index.js allToolNames, read 2026-11-09), so
    // web:false needs no flag and must preserve ordinary tool selection.
    const cmd = ["pi", "--print", "--no-session", "--no-approve"];
    if (request.maxBudgetUsd !== undefined) {
      if (!context?.piBudget) throw new Error("Pi budget extension was not prepared");
      cmd.push("--extension", context.piBudget.path);
    }
    if (request.experimentMcp) {
      if (!context?.experimentPi) throw new Error("Pi experiment extension was not prepared");
      cmd.push("--extension", context.experimentPi.extensionPath);
    }
    if (request.enablePlaywrightMcp) {
      if (context?.piMcpExtension === undefined) throw new Error("pi Playwright MCP extension was not prepared");
      cmd.push("--extension", context.piMcpExtension.path);
    }

    // A --result-json run switches the print mode to pi's json wire: a
    // `{type:"session"}` header line (absent under --no-session) and one
    // JSON line per session event, the reply and usage read off
    // message_end events (0.85.1 runPrintMode, chunk-JVUZSMYM.js). A
    // plain run keeps the text mode: the last assistant message's text
    // blocks on stdout.
    if (request.resultJson || request.experimentMcp || request.maxBudgetUsd !== undefined) {
      cmd.push("--mode", "json");
    }

    // With an override the private agent directory's models.json supplies
    // the provider, so the model flag is provider-qualified and always
    // present: pi resolves `--model provider/id` against it.
    const override = this.validatedProvider();
    if (override !== null) {
      cmd.push("--model", piProviderModelSelector(this.modelFor(request.model)!));
    } else if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.hermetic) {
      // "Disable AGENTS.md and CLAUDE.md discovery and loading" (0.85.1
      // --help): loadProjectContextFiles walks the cwd AND every ancestor
      // with no trust gate of its own, so hermetic needs the flag — the
      // private agent directory only covers the agent-dir side.
      cmd.push("--no-context-files");
    }

    cmd.push(...this.autonomyFlagsFor(request));
    if (request.tools === "none") {
      // "Disable all tools by default (built-in and extension)" (0.85.1
      // --help): the empty allowlist keeps every built-in, extension and
      // custom tool out of the registry, so the model is offered none.
      cmd.push(request.experimentMcp ? "--no-builtin-tools" : "--no-tools");
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
    _context?: RunContext
  ): RunResult {
    if (request.maxBudgetUsd !== undefined) return piBudgetResult(result, request, _context as PiBudgetRunContext);
    // A --result-json run launched with `--mode json`, so stdout is the
    // newline-separated event wire; piResult folds it into the envelope.
    // A plain run keeps pi's text stdout unchanged.
    if (request.experimentMcp) {
      const parsed = piResult(result, request);
      try {
        const envelope = JSON.parse(parsed.stdout);
        envelope.codemux.recording = _context?.experimentRecording ?? null;
        return { ...parsed, scanSurface: result.stdout,
          stdout: request.resultJson ? `${JSON.stringify(envelope)}\n` : envelope.reply };
      } catch { return parsed; }
    }
    if (!request.resultJson) return result;
    return piResult(result, request);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    this.validateBudgetPricing(request);
    // Every launch reads a passed-through PI_CODING_AGENT_DIR, so every
    // launch is checked for it, before the quota gate or any spawn.
    this.assertAbsoluteAgentDir(request.passthroughEnv);
    // --hermetic points PI_CODING_AGENT_DIR at a private agent directory
    // of its own, so a caller-provided second value for the same variable
    // is a contradiction, refused before the quota gate or any spawn.
    if (request.hermetic && request.passthroughEnv?.includes(PI_AGENT_DIR_ENV)) {
      throw new UsageRefusalError(
        `pi --hermetic cannot combine with a passed-through ${PI_AGENT_DIR_ENV}: --hermetic already points it at a private agent directory`
      );
    }
    // Fail before launch on a half-configured override, surface the model
    // requirement early (pi's own default provider, google, would
    // otherwise silently answer), and refuse a model models.json cannot
    // carry verbatim: pi expands $VAR/${VAR} templates inside it
    // (pi-provider.ts). With the override active, the agent directory the
    // private models.json replaces is resolved here too, so a relative
    // value refuses at the same boundary.
    const resolved = this.modelFor(request.model);
    if (resolved !== undefined && this.validatedProvider() !== null) {
      piProviderBareModel(resolved);
      this.realAgentDir(request);
    }
  }

  private validateBudgetPricing(request: RunRequest): void {
    if (request.maxBudgetUsd !== undefined && this.validatedProvider() !== null) {
      throw new UsageRefusalError("Pi USD budgets require native model prices; this provider override has no verified USD rates");
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
    // The TUI reads a passed-through PI_CODING_AGENT_DIR like a run does,
    // so the same boundary check applies before the session spawns.
    this.assertAbsoluteAgentDir(passthroughEnv);
    const selected = this.modelFor(model);
    if (selected !== undefined && this.validatedProvider() !== null) {
      piProviderBareModel(selected);
      this.realAgentDir({ agent: "pi", prompt: "", passthroughEnv });
    }
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    // --no-approve is project trust, not an autonomy grant: 0.85.1's help
    // spells it "Ignore project-local files for this run" (and --approve
    // "Trust project-local files for this run"), and projectTrustOverride
    // is what discoverSystemPromptFile checks before reading
    // <cwd>/.pi/SYSTEM.md. It therefore rides every level — the TUI's
    // operator keeps the terminal, but an untrusted tree's project-local
    // files stay out the same way every headless run's do — matching the
    // run path, which passes it unconditionally.
    const cmd = ["pi", "--no-approve"];
    const selected = this.modelFor(model);
    if (selected !== undefined && this.validatedProvider() !== null) {
      cmd.push("--model", piProviderModelSelector(piProviderBareModel(selected)));
    } else if (model) {
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

  /** The pi login read: auth.json, or a provider key in the environment. */
  override loginState(): LoginState {
    return piLoginState(loginHome(this.environment), this.environment);
  }
}
