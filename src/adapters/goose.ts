import { BaseAdapter } from "./base.js";
import { assertNoGooseProjectExecutionConfig } from "../project-safety.js";
import {
  assertProviderCap,
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

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
    throw new Error(
      "CODEMUX_GOOSE_PROVIDER_BASE_URL with a query string cannot map onto goose's OPENAI_HOST/OPENAI_BASE_PATH"
    );
  }
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  let basePath: string;
  if (path === "") {
    basePath = "v1/chat/completions";
  } else if (path.endsWith("chat/completions")) {
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
      supportsEffort: false,
      effortLevels: [],
      // Hermetic has no mechanism for goose's context-file and
      // config-system-prompt channels, and the live control probe leaked
      // the planted code word (2026-09-17); see docs/HERMETIC.md.
      // `--tools none` is claimed: verified live at 1.50.1 through the
      // provider override — under `--no-profile` neither capability probe
      // could produce its secret while plain runs produced both.
      supportsHermetic: false,
      supportsToolSelection: true,
      supportsProviderOverride: true,
    };
  }

  /**
   * The provider override, validated: goose's env delivery needs a base
   * URL and a key (the model may come from `--model` instead of the
   * variable). Both token caps are refused: the per-model token knobs live
   * only in goose's config file, which the override never writes.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("goose", this.environment);
    if (override === null) return null;
    const noCapSurface =
      "goose's per-model max_tokens and context_limit exist only in its config " +
      "file, which the override never writes; its environment surface (OPENAI_HOST, " +
      "OPENAI_BASE_PATH, OPENAI_API_KEY) carries no token limit";
    assertProviderCap("goose", override, "maxOutputTokens", noCapSurface);
    assertProviderCap("goose", override, "maxContextTokens", noCapSurface);
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
      throw new Error(
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

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["goose", "run"];
    if (request.tools === "none") {
      // "Don't load your default extensions, only use CLI-specified
      // extensions" (1.50.1 `run --help`): with no CLI extensions the
      // session instantiates none, and every tool — built-in platform
      // extensions like developer included — reaches the model only
      // through an extension.
      cmd.push("--no-profile");
    }
    cmd.push("-t", request.prompt);
    return cmd;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoGooseProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: goose's own configured default would
    // otherwise silently answer through the operator's provider.
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
    assertNoGooseProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    this.modelFor(model);
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
    };
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    return {
      GOOSE_MODE: this.resolveMode(request.autonomy),
      ...(request.model ? { GOOSE_MODEL: request.model } : {}),
      ...this.providerEnv(request.model),
    };
  }

  buildTuiCommand(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    return ["goose"];
  }

  override getTuiEnv(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): Record<string, string> {
    return {
      GOOSE_MODE: this.resolveMode(autonomy),
      ...(model ? { GOOSE_MODEL: model } : {}),
      ...this.providerEnv(model),
    };
  }
}
