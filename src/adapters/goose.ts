import { join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoGooseProjectExecutionConfig } from "../project-safety.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import { buildGoosePlaywrightExtension } from "../goose-playwright.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { assertCleanInstructionFiles } from "../clean-cwd.js";
import { createGooseHermeticHome } from "../goose-hermetic.js";
import { GooseExperimentRun } from "../goose-experiment-run.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { gooseResult } from "../result-envelope/goose.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { gooseLoginState, loginHome, type LoginState } from "../harness-health.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import type { ExecutableCheck } from "../executable-security.js";

/**
 * Splits an override base URL into goose's `OPENAI_HOST` /
 * `OPENAI_BASE_PATH` pair — the top-priority session overrides of goose's
 * built-in OpenAI provider (`resolve_base_url`/`from_env`,
 * crates/goose/src/providers/openai_def.rs at 1.50.1: the `OPENAI_HOST`
 * env var outranks `OPENAI_BASE_URL` and config, and an explicit
 * `OPENAI_BASE_PATH` always wins). The path derivation mirrors goose's
 * own `derive_base_path`: a path already ending in `chat/completions`
 * stays, one ending in a version segment (`v4`) gains `/chat/completions`,
 * anything else gains `/v1/chat/completions`, and an empty path becomes
 * the default `v1/chat/completions`.
 */
export function gooseOpenAiEndpoint(baseUrl: string): {
  host: string;
  basePath: string;
} {
  const parsed = new URL(baseUrl);
  if (parsed.search !== "") {
    // A configuration mistake the operator can fix at the flag boundary,
    // not a launch failure: the 64 every pre-launch refusal carries.
    throw new UsageRefusalError(
      "CODEMUX_GOOSE_PROVIDER_BASE_URL with a query string cannot map onto goose's OPENAI_HOST/OPENAI_BASE_PATH"
    );
  }
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  let basePath: string;
  if (path === "") {
    basePath = "v1/chat/completions";
  } else if (path === "chat/completions" || path.endsWith("/chat/completions")) {
    // Already complete — but only at a segment boundary: "notchat/
    // completions" does not name the completions endpoint and gets the
    // suffix appended (review round 169).
    basePath = path;
  } else if (/^v\d+$/.test(lastSegment)) {
    basePath = `${path}/chat/completions`;
  } else {
    basePath = `${path}/v1/chat/completions`;
  }
  return { host: parsed.origin, basePath };
}

export class GooseAdapter extends BaseAdapter {
  readonly id: AgentId = "goose";
  readonly binaryName = "goose";

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // GOOSE_THINKING_EFFORT, the config layer's env alias for the
      // gooseThinkingEffort preference (crates/goose/src/config/base.rs at
      // 1.50.1 — the same environment-then-config-then-keyring layer that
      // resolves GOOSE_PROVIDER), with the ThinkingEffort enum's values
      // `off low medium high max` and its setup copy "Off - No extended
      // thinking" … "Max - No constraints on thinking depth" (embedded
      // strings of the installed 1.50.1 binary, read 2026-11-09). `none`
      // maps to `off`; a provider that rejects the level fails at the
      // model call ("Provider rejected thinking effort"), the same
      // per-model residue agy documents.
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high", "max"],
      // Hermetic: the XDG redirect of src/goose-hermetic.ts closes
      // config.yaml (system prompt, extensions), the session ledger, and
      // the cache at once; the working-directory channel `.goosehints`
      // ("Project Hints: These are hints for working on the project in
      // this directory", CONTEXT_FILE_NAMES, 1.50.1 embedded strings)
      // closes with the clean-cwd rule. Nothing is carried into the
      // private home — config.yaml holds the operator's system prompt
      // next to any keys — so a hermetic run requires the provider
      // override and is refused without one (validateRunRequest). The
      // 2026-09-17 live control leak proved the PLAIN run loads its
      // channels, which is exactly what the private home now removes.
      // `--tools none` is claimed: verified live at 1.50.1 through the
      // provider override — under `--no-profile` neither capability probe
      // could produce its secret while plain runs produced both. Result
      // JSON: `run --output-format <text|json|stream-json>` at 1.50.1;
      // src/result-envelope/goose.ts holds the field evidence.
      supportsHermetic: true,
      hermeticRequiresProviderOverride: true,
      supportsToolSelection: true,
      supportsProviderOverride: true,
      supportsResultJson: true,
    };
  }

  /** goose's effort env value: `none` is goose's `off`. */
  private effortEnvValue(level: ReasoningEffort): string {
    return level === "none" ? "off" : level;
  }

  /**
   * The provider override, validated: goose's env delivery needs a base
   * URL and a key (the model may come from `--model` instead of the
   * variable). Both token caps ride the config layer's env aliases:
   * GOOSE_MAX_TOKENS (the per-model max_tokens) and GOOSE_CONTEXT_LIMIT
   * (the per-model context_limit) — the same environment-then-config
   * layer that resolves GOOSE_PROVIDER (crates/goose/src/config/base.rs
   * at 1.50.1; both aliases refuse a value that is not greater than 0,
   * so the caps arrive as positive integers).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("goose", this.environment);
    if (override === null) return null;
    for (const cap of [override.maxOutputTokens, override.maxContextTokens]) {
      if (cap !== undefined && (!Number.isSafeInteger(cap) || cap <= 0)) {
        throw new UsageRefusalError(
          "the goose provider override token caps must be positive integers " +
            "(GOOSE_MAX_TOKENS and GOOSE_CONTEXT_LIMIT refuse anything else, 1.50.1)"
        );
      }
    }
    return requireProviderOverride("goose", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model the override routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "goose needs a model for the provider override; pass --model or set CODEMUX_GOOSE_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  override mapAutonomy(_level: AutonomyLevel): string[] {
    return [];
  }

  private resolveMode(level?: AutonomyLevel): string {
    return this.mapAutonomyToMode(level ?? "read-only");
  }

  private mapAutonomyToMode(level: AutonomyLevel): string {
    switch (level) {
      case "read-only":
        return "chat";
      case "low":
        return "approve";
      case "medium":
        return "smart_approve";
      case "high":
        return "auto";
    }
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];
    if (request.hermetic) {
      // The XDG variables are assigned inside the sandbox command, never
      // the run environment: scode resolves its own config through XDG and
      // must keep the operator's real values (src/goose-hermetic.ts). A
      // static preview (verify) passes no context and gets a placeholder
      // path naming no real directory.
      const assignments = context?.gooseHermeticHome?.envAssignments ??
        [
          "GOOSE_PATH_ROOT=<unprepared>",
          "XDG_CONFIG_HOME=<unprepared>",
          "XDG_DATA_HOME=<unprepared>",
          "XDG_CACHE_HOME=<unprepared>",
        ];
      cmd.push("env", ...assignments);
    }
    cmd.push("goose", "run");
    if (request.tools === "none" && request.experimentMcp === undefined) {
      // An experiment run must NOT pass --no-profile: the probe itself
      // rides the private root's config.yaml, whose extensions the flag
      // skips — and that root holds the one planted entry alone, so the
      // tools-none promise holds by construction.
      // "Don't load your default extensions, only use CLI-specified
      // extensions" (1.50.1 `run --help`): with no CLI extensions the
      // session instantiates none, and every tool — built-in platform
      // extensions like developer included — reaches the model only
      // through an extension.
      cmd.push("--no-profile");
    }
    if (request.resultJson) {
      // 1.50.1 `run --output-format <text|json|stream-json>`: json prints
      // the final serialized agent message as one JSON object on stdout.
      cmd.push("--output-format", "json");
    }
    // The prompt never rides argv: "-i -" reads it from stdin ("Use -i -
    // for stdin.", 1.50.1 `run --help`), and the driver feeds it through
    // getStdinInput — argv stays visible to process inspection without
    // the prompt in it.
    cmd.push("-i", "-");
    // The sandbox-scoped Playwright server rides goose's per-run stdio
    // extension carrier (src/goose-playwright.ts; the shared allowlist
    // gates the flag, so this arm runs only once the shared patch lands).
    const playwright = buildGoosePlaywrightExtension(request.sandboxed, {
      enabled: request.enablePlaywrightMcp === true,
      pathEnv: this.executionPathEnv(),
      forbiddenRoot: validateWorkingDirectory(request.cwd) ?? process.cwd(),
    });
    if (context !== undefined) context.playwrightMcpCheck = playwright.check;
    cmd.push(...playwright.args);
    return cmd;
  }

  /** The real goose config directory the private home's parent lives under. */
  private realGooseConfigDir(): string {
    return join(loginHome(this.environment), ".config", "goose");
  }

  override prepareRun(
    request: RunRequest,
    _sandboxTrust?: ScodeTrustLevel,
    _sandboxOptions?: SandboxOptions
  ): RunContext {
    const experimentSpec = request.experimentMcp ? readExperimentRunSpec(request) : undefined;
    // The probe rides the private configuration root alone (src/goose-
    // experiment-run.ts plants config.yaml under GOOSE_PATH_ROOT): a plain
    // run would read the operator's config file, and the paired control
    // must stay comparable, so even the canary's non-hermetic control is
    // refused rather than run on the operator's own extensions.
    if (experimentSpec !== undefined && !request.hermetic) {
      throw new UsageRefusalError("goose experiments require the private hermetic home: the probe rides its configuration root");
    }
    if (!request.hermetic) return {};
    // No provider override, no hermetic run: nothing can be carried into
    // the private home (config.yaml holds the operator's system prompt
    // alongside any keys), so the run would have no provider at all.
    // Rechecked here, not only in validateRunRequest, because prepareRun
    // creates disk state on a seam a caller can reach directly.
    if (this.validatedProvider() === null) {
      throw new UsageRefusalError(
        "goose --hermetic requires the provider override: its config file carries the operator's system prompt, so no configuration can ride into the private home (set CODEMUX_GOOSE_PROVIDER_BASE_URL and CODEMUX_GOOSE_PROVIDER_API_KEY)"
      );
    }
    if (request.cwd === undefined) {
      throw new UsageRefusalError("goose --hermetic requires an explicit --cwd owned by this run");
    }
    const context: RunContext = {
      gooseHermeticHome: createGooseHermeticHome(this.realGooseConfigDir()),
    };
    if (experimentSpec !== undefined) {
      try {
        // The relay owns the run: the planted config points goose at it,
        // and the capture/verification lifecycle rides the launcher's
        // prepare/complete calls (the pi pattern, src/launch.ts).
        const experiment = new GooseExperimentRun(experimentSpec, request.cwd!,
          context.gooseHermeticHome!, this.environment, request.prompt);
        context.experimentGoose = experiment;
        context.stdoutSink = experiment;
        context.experimentRecording = experiment.recordingPath;
      } catch (error) { this.cleanupRunSync(context); throw error; }
    }
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    // The experiment retains its ledger evidence before the private root
    // that holds it is finalized (the pi ordering rule).
    try { context?.experimentGoose?.closeSync(); }
    finally { context?.gooseHermeticHome?.finalize(); }
  }

  override cleanupRun(context?: RunContext): void | Promise<void> {
    if (context?.experimentGoose) return context.experimentGoose.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    if (!request.resultJson) return result;
    return gooseResult(result, request, context?.experimentRecording ?? null);
  }

  override getStdinInput(request: RunRequest): string | null {
    // The `-i -` carrier: the prompt rides stdin, never argv.
    return request.prompt;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoGooseProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // Fail before launch on a half-configured override, surface the model
    // requirement early (goose's own configured default would otherwise
    // silently answer through the operator's provider), and refuse a base
    // URL goose's env pair cannot carry before the quota gate — the same
    // refusal the launch path would raise later, now as a usage error.
    const override = this.validatedProvider();
    if (override !== null) {
      this.modelFor(request.model);
      gooseOpenAiEndpoint(override.baseUrl);
    }
    if (request.hermetic) {
      if (override === null) {
        throw new UsageRefusalError(
          "goose --hermetic requires the provider override: its config file carries the operator's system prompt, so no configuration can ride into the private home (set CODEMUX_GOOSE_PROVIDER_BASE_URL and CODEMUX_GOOSE_PROVIDER_API_KEY)"
        );
      }
      if (request.cwd === undefined) {
        throw new UsageRefusalError("goose --hermetic requires an explicit --cwd owned by this run");
      }
      // The workspace channels the private root cannot close: the
      // .goosehints and AGENTS.md context files, loaded from the working
      // directory and its ancestors up to the Git root (load_hints.rs
      // GOOSE_HINTS_FILENAME and AGENTS_MD_FILENAME, 1.50.1; the installed
      // binary carries both strings, read 2026-11-09). A dangling symlink
      // counts (lstat): the harness resolves it.
      assertCleanInstructionFiles("goose", validateWorkingDirectory(request.cwd)!, [
        ".goosehints",
        "AGENTS.md",
      ]);
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
    assertNoGooseProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    const override = this.validatedProvider();
    if (override !== null) {
      this.modelFor(model);
      gooseOpenAiEndpoint(override.baseUrl);
    }
  }

  /**
   * The provider override rides the environment goose reads before any
   * config file or keyring (config precedence: environment, then
   * config.yaml, then the keyring — `crates/goose/src/config/base.rs` at
   * 1.50.1), so it survives any future hermetic mode and never touches an
   * operator file. The key travels as `OPENAI_API_KEY`, the endpoint as
   * the `OPENAI_HOST`/`OPENAI_BASE_PATH` pair, and the provider is
   * goose's built-in `openai`, whose provider metadata documents the
   * OpenAI-compatible custom-endpoint use.
   */
  private providerEnv(model: string | undefined): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    const resolved = this.modelFor(model);
    const endpoint = gooseOpenAiEndpoint(override.baseUrl);
    return {
      GOOSE_PROVIDER: "openai",
      OPENAI_HOST: endpoint.host,
      OPENAI_BASE_PATH: endpoint.basePath,
      OPENAI_API_KEY: override.apiKey,
      ...(resolved ? { GOOSE_MODEL: resolved } : {}),
      ...(override.maxOutputTokens !== undefined
        ? { GOOSE_MAX_TOKENS: String(override.maxOutputTokens) }
        : {}),
      ...(override.maxContextTokens !== undefined
        ? { GOOSE_CONTEXT_LIMIT: String(override.maxContextTokens) }
        : {}),
    };
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    return {
      GOOSE_MODE: this.resolveMode(request.autonomy),
      ...(request.model ? { GOOSE_MODEL: request.model } : {}),
      ...(request.effort ? { GOOSE_THINKING_EFFORT: this.effortEnvValue(request.effort) } : {}),
      ...this.providerEnv(request.model),
    };
  }

  buildTuiCommand(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp = false,
    workdir?: string,
    nestedChecks: ExecutableCheck[] = []
  ): string[] {
    const cmd = ["goose"];
    if (enablePlaywrightMcp) {
      // The interactive session subcommand is goose's own documented
      // extension surface ("goose session --with-extension", 1.50.1 help
      // copy: the session behavior options are shared between the
      // session and run commands). Owned and tested here; the shared
      // allowlist still refuses the flag until the patch lands, so this
      // arm is dormant until then (the pi rule).
      const playwright = buildGoosePlaywrightExtension(sandboxed, {
        enabled: true,
        pathEnv: this.executionPathEnv(),
        forbiddenRoot: validateWorkingDirectory(workdir) ?? process.cwd(),
      });
      if (playwright.check !== null) nestedChecks.push(playwright.check);
      cmd.push("session", ...playwright.args);
    }
    return cmd;
  }

  override getTuiEnv(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): Record<string, string> {
    return {
      GOOSE_MODE: this.resolveMode(autonomy),
      ...(model ? { GOOSE_MODEL: model } : {}),
      ...(effort ? { GOOSE_THINKING_EFFORT: this.effortEnvValue(effort) } : {}),
      ...this.providerEnv(model),
    };
  }

  /** The goose login read: its config file, or an API key. */
  override loginState(): LoginState {
    return gooseLoginState(loginHome(this.environment), this.environment);
  }
}
