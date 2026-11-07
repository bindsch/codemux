import { PROJECT_SETTING_SOURCES, validateProjectSettingsRunRequest } from "../claude-project-settings.js";
import { createProjectSettingsConfigDir, projectSettingsRunEnv } from "../claude-project-config.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { ExperimentBridge } from "../experiment-bridge.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import type { ExecutableCheck } from "../executable-security.js";
import {
  claudeAutonomyFlags,
  claudeNativeAutonomyFlags,
  WEB_TOOL_GRANTS,
} from "../claude-autonomy.js";
import { readUtf8FileBounded } from "../file-io.js";
import { appendDiagnostic, claudeFamilyResult } from "../result-envelope.js";
import { claudeFamilyPlainResult } from "../plain-unwrap.js";
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
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { zaiLoginState, loginHome, type LoginState } from "../harness-health.js";

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const MAX_KEY_FILE_BYTES = 16 * 1024;
const DEFAULT_API_TIMEOUT_MS = 3_000_000;
const MAX_API_TIMEOUT_MS = 86_400_000;
// The model zai runs when the request names none (buildRunCommand and
// buildTuiCommand both fall back to it); result processing must report the
// same one, or an envelope without modelUsage would claim codemux selected
// nothing.
export const ZAI_DEFAULT_MODEL = "opus";

export class ZaiAdapter extends BaseAdapter {
  readonly id: AgentId = "zai";
  readonly binaryName = "claude";

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
      // Same binary as claude, so the same --effort flag: the levels the
      // binary's own help lists, plus `none`, the "no flag" spelling
      // mapEffort maps to nothing. The live evidence behind the mapping
      // (2026-10-10, glm-5.3 replying under --effort low) predates the
      // 2.1.280 client-side model-catalog check: a non-catalog id now
      // rides the picker settings of claude-family.ts or the run dies
      // before any request leaves the binary.
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      supportsHermetic: true,
      supportsToolSelection: true,
      // Same binary as claude, so the same --output-format json envelope.
      supportsResultJson: true,
      // Same binary as claude, so the same --max-budget-usd spend cap
      // (Claude Code 2.1.317, a headless --print flag).
      budgetLimit: true,
    };
  }

  override mapEffort(level: ReasoningEffort): string[] {
    // Claude's mapping verbatim: `none` is the adapter's "no flag", not a
    // value the binary accepts.
    return level === "none" ? [] : ["--effort", level];
  }

  override resultModel(request: RunRequest): string { return request.model || ZAI_DEFAULT_MODEL; }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Z.AI home directory must be an absolute path");
    }
    const configuredHome =
      this.homeDirectory ||
      this.environment.HOME ||
      this.environment.USERPROFILE;
    return configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : homedir();
  }

  private getZaiApiKey(): string {
    const environmentKey = this.environment.ZAI_API_KEY?.trim();
    if (environmentKey) {
      return this.validateCredential(environmentKey, "ZAI_API_KEY");
    }

    const zaiFile = join(this.effectiveHome(), ".zai");
    try {
      const content = readUtf8FileBounded(zaiFile, {
        maxBytes: MAX_KEY_FILE_BYTES,
        label: zaiFile,
        noFollow: true,
        validate: (stat) => {
          if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
            throw new Error(`${zaiFile} permissions must be 0600 or stricter`);
          }
          if (
            process.platform !== "win32" &&
            typeof process.getuid === "function" &&
            stat.uid !== process.getuid()
          ) {
            throw new Error(`${zaiFile} must be owned by the current user`);
          }
        },
      }).trim();
      if (content) {
        return this.validateCredential(content, zaiFile);
      }
      throw new Error(`${zaiFile} is empty`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    throw new Error(
      "Z.AI API key not found.\n" +
      "Either create ~/.zai with your API key, or set ZAI_API_KEY env var.\n" +
      "Get your API key from: https://z.ai/manage-apikey/apikey-list"
    );
  }

  private validateCredential(value: string, source: string): string {
    if (value.includes("\0") || /[\r\n]/.test(value)) {
      throw new Error(`${source} must contain exactly one credential line`);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_KEY_FILE_BYTES) {
      throw new Error(`${source} exceeds ${MAX_KEY_FILE_BYTES} bytes`);
    }
    return value;
  }

  private getApiTimeout(): string {
    const raw = this.environment.API_TIMEOUT_MS?.trim();
    if (raw === undefined || raw === "") return String(DEFAULT_API_TIMEOUT_MS);
    if (!/^\d+$/.test(raw)) {
      throw new Error("API_TIMEOUT_MS must be a positive integer in milliseconds");
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_API_TIMEOUT_MS) {
      throw new Error(
        `API_TIMEOUT_MS must be between 1 and ${MAX_API_TIMEOUT_MS}`
      );
    }
    return String(value);
  }

  override getEnv(): Record<string, string> {
    const apiKey = this.getZaiApiKey();
    return {
      // The shared gateway mechanism (claude-family.ts): the token wins over
      // the operator's on-disk login, and the endpoint serves the Anthropic
      // Messages API.
      ...claudeGatewayEnv(apiKey, ZAI_BASE_URL),
      API_TIMEOUT_MS: this.getApiTimeout(),
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    };
  }

  override getEnvOmissions(): readonly string[] {
    return ["ZAI_API_KEY", ...claudeGatewayOmissions()];
  }

  override beforeLaunch(): void {
    this.getZaiApiKey();
    if (process.stderr.isTTY) {
      console.error("Z.AI mode: using api.z.ai/api/anthropic");
    }
  }

  override configurationIssues(): string[] {
    try {
      this.getZaiApiKey();
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message.split("\n")[0]! : String(error)];
    }
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // The TUI has a human to approve; write grants ride only on headless
    // runs (see buildRunCommand).
    return claudeNativeAutonomyFlags(level);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // The adapter pins no CLAUDE_CONFIG_DIR, so a passed-through one is the
    // only redirect -- and a relative one would resolve against the child's
    // working directory, landing the config store somewhere --cwd decides.
    assertAbsoluteClaudeConfigDir(request.passthroughEnv, this.environment);
    if (request.experimentMcp) assertExperimentConfigRootSingleLine(this.environment, request.passthroughEnv);
  }

  // The experiment bridge as claude's: same binary, same SDK control
  // protocol, same recordings and result envelope. The private config
  // directory of a project-settings run is the same mechanism too.
  override prepareRun(request: RunRequest): RunContext {
    const context: RunContext = {};
    if (request.experimentProjectSettings) {
      // The launch-path gate, from the request's own fields (review
      // round 2, edges 1): the CLI's early check is a duplicate, so a
      // programmatic caller cannot reach the config directory — or the
      // spawn — without the sandbox, low autonomy, and hermetic mode.
      validateProjectSettingsRunRequest(request);
      context.claudeProjectConfigDir = createProjectSettingsConfigDir(
        request.cwd ?? process.cwd(),
        this.environment
      );
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
   * CLAUDE_CONFIG_DIR pointed at the private directory. No credential is
   * copied into it — the gateway token (getEnv) is this run's credential,
   * so the operator's Claude login stays out of a Z.AI run entirely.
   */
  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    if (!request.experimentProjectSettings) return {};
    return projectSettingsRunEnv(context?.claudeProjectConfigDir);
  }

  override async cleanupRun(context?: RunContext): Promise<void> {
    try {
      await context?.experimentBridge?.close();
    } finally {
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

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, _effort, passthroughEnv, enablePlaywrightMcp);
    assertAbsoluteClaudeConfigDir(passthroughEnv, this.environment);
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
    // directory silently disable the project source. The
    // user source resolves under the ordinary Claude Code home the child
    // already uses (CLAUDE_CONFIG_DIR, default ~/.claude) -- Z.AI runs load
    // the operator's ~/.claude/settings.json directly, exactly as claude
    // runs do, because both run the same binary against the same store.
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
    // No run of this adapter persists a session (same binary and rule as
    // claude): nothing a later run could resume is left behind.
    cmd.push("--no-session-persistence");
    // The run's spend cap (same binary and flag as claude): the one
    // spelling of the parsed number, on every branch above.
    if (request.maxBudgetUsd !== undefined) {
      cmd.push("--max-budget-usd", String(request.maxBudgetUsd));
    }
    // Always the single-result envelope, plain runs included (same binary
    // and rule as claude): `--result-json` re-emits it with the codemux
    // block appended; a plain run unwraps it back to the reply text
    // (plain-unwrap.ts) so stdout keeps its contract while the call ledger
    // gets the usage.
    // The experiment bridge drives the SDK control protocol over stream-json
    // and registers the one experiment server, exactly as claude's run does.
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
    // Non-catalog ids (glm-5.3, glm-4.5-air — the clerk/worker/judge
    // tiers) need the picker --settings or the 2.1.280+ catalog check
    // rejects them client-side (claude-family.ts); the default `opus`
    // carries none.
    cmd.push(...claudeModelArgv(this.resultModel(request)));

    if (request.autonomy) {
      // scode enforces read-only for the harness; the host authorizes only
      // experiment tools, whose separate process owns its writes, so plan
      // mode must not suppress those before they reach the control callback.
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

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    if (context?.experimentBridge) {
      if (result.exitCode === 0 && !result.stdout) throw new Error("Claude returned no experiment result envelope");
      result = { ...result, scanSurface: context.experimentBridge.scanSurface() };
    }
    // Same envelope as claude (same binary): with --result-json the harness's
    // envelope is re-emitted with the codemux block appended, and anything
    // that is not the envelope fails loudly there, as in claude's adapter.
    if (request.resultJson) {
      // buildRunCommand ran --model opus when the request named none (or an
      // empty string -- same `||` fallback), so the envelope's model fallback
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
    // The TUI's default launch carries --safe-mode, the same every-
    // customization-off baseline as a hermetic run (claude.ts's
    // buildRunCommand records why --bare is not used instead); the
    // Playwright branch needs the user settings source for the MCP client
    // configuration — and it is selected by what the MCP build attached,
    // never by the flag alone (review round 147): an unsandboxed launch
    // attaches nothing, and user settings with no MCP configuration to
    // load from them is the baseline lost for nothing.
    const playwright = buildPlaywrightSandboxMcp(sandboxed, {
      enabled: enablePlaywrightMcp,
      forbiddenRoot: cwd ?? process.cwd(),
    });
    const cmd = playwright.args.length > 0
      ? ["claude", "--setting-sources", "user", "--strict-mcp-config"]
      : ["claude", "--safe-mode"];
    cmd.push(...playwright.args);
    if (playwright.check !== null) nestedChecks?.push(playwright.check);
    // Same rule as the run path: a non-catalog model id rides the picker
    // --settings (claude-family.ts) or the binary rejects it before any
    // request.
    cmd.push(...claudeModelArgv(model || ZAI_DEFAULT_MODEL));
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


  /** The zai login read: the key file's existence and mode, or the env key. */
  override loginState(): LoginState {
    return zaiLoginState(loginHome(this.environment), this.environment);
  }
}
