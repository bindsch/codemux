import type { RunContext } from "./base.js";
import { UsageRefusalError } from "../validation.js";
import { ClaudeCredentialAdapter } from "./claude-credentials.js";
import { PROJECT_SETTING_SOURCES, validateProjectSettingsRunRequest } from "../claude-project-settings.js";
import {
  copyClaudeCredentialMirror,
  createProjectSettingsConfigDir,
  projectSettingsRunEnv,
} from "../claude-project-config.js";
import { ExperimentBridge } from "../experiment-bridge.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import type { ExecutableCheck } from "../executable-security.js";
import { appendDiagnostic, claudeFamilyResult } from "../result-envelope.js";
import { claudeFamilyPlainResult } from "../plain-unwrap.js";
import {
  claudeAutonomyFlags,
  claudeNativeAutonomyFlags,
  WEB_TOOL_GRANTS,
} from "../claude-autonomy.js";
import {
  assertAbsoluteClaudeConfigDir,
  assertExperimentConfigRootSingleLine,
  canonicalInstructionDir,
  claudeChildProject,
  claudeGatewayEnv,
  claudeGatewayOmissions,
  claudeModelArgv,
  resolveInstructionDir,
} from "../claude-family.js";
import {
  assertProviderCap,
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
import { claudeLoginState, loginHome, type LoginState } from "../harness-health.js";

/**
 * What the CHILD Claude sees that shapes an oversize-result spill, for the
 * experiment bridge's check: its config directory, a project-directory
 * override, its MCP output token limit, and its MCP truncation prompt
 * choice (claudeChildProject, claude-family.ts).
 */

export class ClaudeAdapter extends ClaudeCredentialAdapter {
  readonly id: AgentId = "claude";
  readonly binaryName = "claude";

  // Seam so tests can point the provider override at a scratch environment;
  // the view is forwarded to the base, whose checks read it.
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }

  /**
   * The provider override, validated: the same gateway mechanism zai rides
   * (claude-family.ts), pointed at the operator's endpoint. The endpoint
   * must serve the Anthropic Messages API (`/v1/messages`) — the binary
   * speaks no other wire format — and the override needs a base URL and a
   * key. The token wins over the on-disk login, so the run bills the
   * operator's endpoint, never the Claude subscription.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("claude", this.environment);
    if (override === null) return null;
    // Claude Code exposes no context-window knob: its environment surface
    // carries CLAUDE_CODE_MAX_OUTPUT_TOKENS only (verified against the
    // installed 2.1.280 binary), so a context cap cannot ride the override.
    assertProviderCap(
      "claude",
      override,
      "maxContextTokens",
      "Claude Code exposes no context-window environment variable (only " +
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS, verified against the installed 2.1.280 " +
        "binary), so a context cap cannot ride the override"
    );
    return requireProviderOverride("claude", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /**
   * The model the run uses: the request's, else the override's. With an
   * override one must exist — the binary's default model would hit the
   * operator's endpoint with a name it may not serve.
   */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "claude needs a model for the provider override; pass --model or set CODEMUX_CLAUDE_PROVIDER_MODEL");
    }
    return resolved;
  }

  override resultModel(request: RunRequest): string | undefined { return this.modelFor(request.model); }

  override getEnv(): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) {
      return { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
    }
    // Every model tier Claude Code may pick on its own — the haiku tier for
    // background requests and subagents, the small-fast model, and the
    // sonnet/opus defaults a `--model` alias can resolve to — is pinned to
    // the override model, so no request leaves for a model the endpoint
    // does not serve (the four names are verified against Claude Code
    // 2.1.280's binary strings). The model may instead arrive on `--model`
    // alone (modelFor); the tiers are pinned when the override names it,
    // which the README states.
    const env: Record<string, string> = {
      ...claudeGatewayEnv(override.apiKey, override.baseUrl),
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    };
    if (override.model !== undefined) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = override.model;
      env.ANTHROPIC_SMALL_FAST_MODEL = override.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = override.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = override.model;
    }
    if (override.maxOutputTokens !== undefined) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(override.maxOutputTokens);
    }
    return env;
  }

  override getEnvOmissions(): readonly string[] {
    // With an override the token is the credential and Claude Code's own
    // login must play no part: the operator's API key and OAuth token stay
    // out of the child environment. Without one, both keep forwarding as
    // before (ALLOWED_CREDENTIAL_ENV.claude).
    return this.validatedProvider() === null ? [] : claudeGatewayOmissions();
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      // `none` is deliberately absent (round al21, contracts-2 minor 4):
      // claude never accepted the spelling at this gate, and zai — the
      // same binary — diverges on purpose by carrying it (its comment
      // says why). mapEffort below still maps `none` for the paths that
      // resolve effort below the CLI gate.
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsHermetic: true,
      supportsToolSelection: true,
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // The TUI has a human to approve; write grants ride only on headless
    // runs (see buildRunCommand).
    return claudeNativeAutonomyFlags(level);
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return level === "none" ? [] : ["--effort", level];
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // The adapter pins no CLAUDE_CONFIG_DIR, so a passed-through one is the
    // only redirect -- and a relative one would resolve against the child's
    // working directory, landing the config store somewhere --cwd decides.
    assertAbsoluteClaudeConfigDir(request.passthroughEnv, this.environment);
    if (request.experimentMcp) assertExperimentConfigRootSingleLine(this.environment, request.passthroughEnv);
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the binary's default model would hit the
    // operator's endpoint with a name it may not serve. The context-cap
    // refusal lives in validatedProvider, so this call covers it too.
    this.modelFor(request.model);
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    assertAbsoluteClaudeConfigDir(passthroughEnv, this.environment);
    // The override is environment-only, so an interactive session carries
    // it too -- with the same model requirement as a headless run.
    this.modelFor(model);
  }

  override prepareRun(request: RunRequest): RunContext {
    const context: RunContext = {};
    if (request.experimentProjectSettings) {
      // The launch-path gate, from the request's own fields (review
      // round 2, edges 1): a programmatic caller cannot reach the config
      // directory or the spawn without sandbox and low autonomy.
      validateProjectSettingsRunRequest(request);
      // The private config directory must exist before anything else this
      // run prepares reads the child's config root (the bridge below).
      context.claudeProjectConfigDir =
        createProjectSettingsConfigDir(request.cwd ?? process.cwd(), this.environment);
    }
    if (!request.experimentMcp) return context;
    // A bridge that fails to build (a spec it refuses, a recording root it
    // cannot create) must not strand the private config directory created
    // above: cleanup first, then rethrow (review round 14, edges 12).
    try {
      context.experimentBridge = new ExperimentBridge(readExperimentRunSpec(request),
        request.cwd ?? process.cwd(), request.prompt, this.environment,
        claudeChildProject(this.environment, request.passthroughEnv, context.claudeProjectConfigDir?.dir));
      context.stdoutSink = context.experimentBridge;
      context.experimentRecording = context.experimentBridge.recordingPath;
    } catch (error) { this.cleanupRunSync(context); throw error; }
    return context;
  }

  /**
   * The per-run environment of an --experiment-project-settings launch:
   * CLAUDE_CONFIG_DIR pointed at the private directory, plus the
   * credential copy made here — after prepareSandbox refreshed the
   * default mirror, before the child reads <private>/.credentials.json —
   * unless the context defers the copy (deferCredentialCopy: a pre-claim
   * probe or print answers the environment without writing). A provider
   * override authenticates with its own token, so nothing of the
   * operator's login is copied; Z.AI rides its gateway token (zai.ts).
   */
  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    if (!request.experimentProjectSettings) return {};
    const env = projectSettingsRunEnv(context?.claudeProjectConfigDir);
    if (
      readProviderOverride("claude", this.environment) === null &&
      context?.claudeProjectConfigDir?.deferCredentialCopy !== true
    ) {
      copyClaudeCredentialMirror(env.CLAUDE_CONFIG_DIR, this.credentialTarget());
    }
    return env;
  }

  override async cleanupRun(context?: RunContext): Promise<void> {
    try {
      await context?.experimentBridge?.close();
    } finally {
      // The token copy dies with the directory.
      context?.claudeProjectConfigDir?.finalize();
    }
  }

  override cleanupRunSync(context?: RunContext): void {
    try {
      context?.experimentBridge?.closeSync();
    } finally {
      context?.claudeProjectConfigDir?.finalize();
    }
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    // The Playwright build is decided first, because the settings branch
    // reads it: the Playwright binary's trust check rides the context
    // (review round 110) — its path is embedded in the --mcp-config JSON
    // argument, where the spawn's command re-check cannot see it, so the
    // launcher re-stats it through the recorded check instead.
    const playwright = buildPlaywrightSandboxMcp(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(),
    });
    // True when the request asked for the Playwright server and none can
    // be attached (an unsandboxed launch: the build returns no
    // arguments). The validators refuse that combination first; this is
    // the fail-closed command a caller that reaches the builder directly
    // gets — the every-customization-off baseline, not the user settings
    // source the server needs (review round 147). Project settings keep
    // their own branch, which the experiment validation guards instead.
    const playwrightRefused = !request.experimentProjectSettings &&
      request.enablePlaywrightMcp === true && playwright.args.length === 0;
    const cmd = ["claude", "-p"];
    // Project settings replace --safe-mode, which would ignore their rules.
    if ((request.hermetic || playwrightRefused) && !request.experimentProjectSettings) {
      // --safe-mode starts with every customization disabled: CLAUDE.md
      // (user and project), skills, plugins, hooks, MCP servers, custom
      // commands and agents. Auth, model selection, built-in tools and
      // permissions work normally. --bare would go further but never reads
      // the OAuth login, so a subscription run would silently bill an API
      // key instead.
      cmd.push("--safe-mode");
    }
    if (request.experimentProjectSettings) {
      cmd.push("--disable-slash-commands");
    }
    // Kept under --safe-mode too: it costs nothing and settles whether a
    // repository's own settings file could still reach the run. Project
    // instruction files load only with the project source, so a request
    // that names instruction directories (the hermetic check's control)
    // enables it; under --safe-mode that is exactly the channel being
    // proven closed.
    // The project source is enabled only when the working directory is one
    // of the named instruction directories, so a repository's own settings
    // file can never ride in on an unrelated instruction directory. Both
    // sides compare in the same canonical form (canonicalInstructionDir,
    // review round 87): raw strings let equivalent spellings of one
    // directory silently disable the project source.
    const instructionDirs = request.instructionDirs ?? [];
    const base = request.cwd ?? process.cwd();
    const cwd = canonicalInstructionDir(base);
    const cwdIsInstructionDir = instructionDirs.some((dir) => canonicalInstructionDir(resolveInstructionDir(dir, base)) === cwd);
    if (!playwrightRefused) {
      cmd.push(
        "--setting-sources",
        request.experimentProjectSettings ? PROJECT_SETTING_SOURCES : cwdIsInstructionDir ? "user,project" : "user",
        "--strict-mcp-config"
      );
    }
    // No run of this adapter persists a session, so the harness is told so
    // explicitly: nothing a later run could resume is left behind.
    cmd.push("--no-session-persistence");
    // Always the single-result envelope, plain runs included: the reply
    // under `result`, plus `usage`, `modelUsage`, and `total_cost_usd`.
    // `--result-json` re-emits it with the codemux block appended; a plain
    // run unwraps it back to the reply text (plain-unwrap.ts) so stdout
    // keeps its contract while the call ledger gets the usage.
    cmd.push("--output-format", request.experimentMcp ? "stream-json" : "json");
    if (request.experimentMcp) {
      const spec = context?.experimentBridge?.spec ?? readExperimentRunSpec(request);
      cmd.push("--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio",
        "--mcp-config", JSON.stringify({ mcpServers: { [spec.name]: { type: "sdk", name: spec.name } } }));
    }
    if (request.tools === "none") {
      // An empty --tools list removes every built-in tool definition.
      cmd.push("--tools", "");
    }
    for (const dir of instructionDirs) {
      cmd.push("--add-dir", dir);
    }

    // The Playwright arguments and their trust check, from the build the
    // settings branch above already read (see the top of this method).
    cmd.push(...playwright.args);
    if (context !== undefined) context.playwrightMcpCheck = playwright.check;

    // With an override the model is always explicit — the request's or the
    // override's — because the binary's default model is a subscription
    // name the operator's endpoint may not serve (the same rule as zai).
    // The picker mapping rides with it (modelFlags) so the binary's own
    // catalog check accepts the id before the first request.
    cmd.push(...this.modelFlags(request.model));

    if (request.autonomy) {
      // scode enforces read-only for the harness. The host authorizes only
      // experiment tools, whose separate process owns its writes; plan mode
      // must not suppress those before they reach the control callback.
      cmd.push(...(request.experimentMcp ? ["--permission-mode", "default"] :
        claudeAutonomyFlags(request.autonomy, request.cwd ?? process.cwd(), { web: request.web === false ? "deny" : "grant" })));
    }
    if (request.web === false && !cmd.includes("--disallowedTools")) {
      cmd.push("--disallowedTools", ...WEB_TOOL_GRANTS);
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    return cmd;
  }

  /**
   * The model flags every launch shares: `--model` (always explicit under
   * an override — modelFor's rule), plus the modelPicker `--settings`
   * payload when the id needs it — a provider-format id under an override,
   * without which 2.1.280's client catalog check rejects it before any
   * request leaves the binary. The needs-it predicate is the family's one
   * rule (claudeModelArgv in claude-family.ts), shared with zai and the
   * session builder. No model resolved: no flags.
   */
  private modelFlags(model: string | undefined): string[] {
    const resolved = this.modelFor(model);
    if (resolved === undefined) return [];
    return claudeModelArgv(resolved);
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    if (context?.experimentBridge) {
      if (result.exitCode === 0 && !result.stdout) throw new Error("Claude returned no experiment result envelope");
      result = { ...result, scanSurface: context.experimentBridge.scanSurface() };
    }
    // Ordinary runs use --output-format json; the experiment bridge extracts
    // the final result envelope from stream-json. Under --result-json it is re-emitted with every
    // original field untouched plus the codemux block (usage, model);
    // anything that is not the envelope fails loudly there: the raw stdout
    // stays on stdout, stderr says what is missing, and the exit is
    // non-zero.
    if (request.resultJson) {
      // An override run always launched with --model resolved (the same
      // fallback buildRunCommand applies), so the envelope's model fallback
      // sees the model codemux actually selected.
      return claudeFamilyResult(
        result,
        { ...request, model: this.resultModel(request) },
        this.id,
        context?.experimentRecording ?? null
      );
    }
    // A plain run: the same envelope, unwrapped back to the reply text.
    // Stdout that is not JSON passes through verbatim with the run
    // unchanged — the escape hatch for binaries codemux did not structure
    // the output for; JSON that is not the envelope (an array or scalar
    // included, or an object cut mid-write) fails with nothing on stdout
    // (plain-unwrap.ts).
    const plain = claudeFamilyPlainResult(result, this.id);
    // A plain run has no codemux block to carry the recording path, so the
    // run's stderr summary names it instead.
    return context?.experimentBridge
      ? { ...plain, stderr: appendDiagnostic(plain.stderr,
          `codemux: experiment MCP recording: ${context.experimentBridge.recordingPath}`) }
      : plain;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string,
    nestedChecks?: ExecutableCheck[]
  ): string[] {
    // The TUI's default launch carries --safe-mode: the same every-
    // customization-off baseline as a hermetic run (see buildRunCommand),
    // and the only verified way to keep an interactive session from
    // loading the operator's own hooks and MCP servers. The Playwright
    // branch needs the user settings source instead, so the MCP client
    // configuration is reachable — and it is selected by what the MCP
    // build attached, never by the flag alone (review round 147): an
    // unsandboxed launch attaches nothing, and user settings with no MCP
    // configuration to load from them is the baseline lost for nothing.
    const playwright = buildPlaywrightSandboxMcp(sandboxed, {
      enabled: enablePlaywrightMcp,
      forbiddenRoot: cwd ?? process.cwd(),
    });
    const cmd = playwright.args.length > 0
      ? ["claude", "--setting-sources", "user", "--strict-mcp-config"]
      : ["claude", "--safe-mode"];
    cmd.push(...playwright.args);
    if (playwright.check !== null) nestedChecks?.push(playwright.check);
    // The override's model fallback, same as buildRunCommand: an override
    // launch never runs the binary's default model, and the picker
    // mapping rides with it (modelFlags) for the same catalog reason.
    // (The tui launch this command builds; the session path wires its
    // override through the providerSettings seam instead, session/cli.ts.)
    cmd.push(...this.modelFlags(model));
    if (autonomy) {
      // The TUI has a human to approve; write grants ride only on
      // headless runs.
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }

  /** The claude login read: the mirror's expiry (see harness-health). */
  override loginState(): LoginState {
    return claudeLoginState(loginHome(this.environment));
  }
}
