import { BaseAdapter } from "./base.js";
import { devNull, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import { assertNoAiderProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import {
  createAiderHistoryFile,
  extractAiderReply,
  type AiderHistoryFile,
} from "../aider-history.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

export const AIDER_EMPTY_CONFIG_PATH = fileURLToPath(
  new URL("../../resources/aider-empty.yml", import.meta.url)
);
export const AIDER_MODEL_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/aider-model-settings.yml", import.meta.url)
);
export const AIDER_MODEL_METADATA_PATH = fileURLToPath(
  new URL("../../resources/aider-model-metadata.json", import.meta.url)
);
const HEADLESS_NEGATIVE_RESPONSES = "n\n".repeat(64);

export class AiderAdapter extends BaseAdapter {
  readonly id: AgentId = "aider";
  readonly binaryName = "aider";

  private historyFile: AiderHistoryFile | null = null;
  private readonly historyFiles: AiderHistoryFile[] = [];

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super();
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (
      this.homeDirectory !== undefined &&
      (!isAbsolute(this.homeDirectory) || this.homeDirectory !== this.homeDirectory.trim())
    ) {
      throw new Error("aider home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  private baseCommand(): string[] {
    return [
      "aider",
      "--config",
      AIDER_EMPTY_CONFIG_PATH,
      "--env-file",
      devNull,
      "--model-settings-file",
      AIDER_MODEL_SETTINGS_PATH,
      "--model-metadata-file",
      AIDER_MODEL_METADATA_PATH,
      "--input-history-file",
      devNull,
      // A per-run file when prepareRun created one (removed at exit, and the
      // hermetic check's answer source), /dev/null otherwise: TUI sessions
      // and static previews keep writing nowhere.
      "--chat-history-file",
      this.historyFile?.path ?? devNull,
      "--no-gitignore",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-analytics",
      "--no-suggest-shell-commands",
      "--no-check-update",
      "--no-show-release-notes",
      "--no-show-model-warnings",
      "--disable-playwright",
    ];
  }

  override prepareRun(_request: RunRequest): void {
    this.historyFile = createAiderHistoryFile(this.effectiveHome());
    this.historyFiles.push(this.historyFile);
  }

  /** Drops every history file this adapter created. */
  disposeHistoryFiles(): void {
    for (const file of this.historyFiles.splice(0)) file.finalize();
    this.historyFile = null;
  }

  /**
   * The model's answer for the hermetic check: read from the run's chat
   * history, whose reply section is the answer without the banner and
   * summaries that drown it on stdout. Without a prepared or readable
   * history the raw stdout is returned, banner included, so the check fails
   * closed rather than certifying a transcript.
   */
  override extractReply(_output: string): string {
    if (this.historyFile === null) return _output;
    try {
      return extractAiderReply(readFileSync(this.historyFile.path, "utf8"));
    } catch {
      return _output;
    }
  }

  /**
   * Stdout plus the full reply the history recorded: aider prints the final
   * answer but folds the endpoint's reasoning only into the history file, so
   * a code word that never reached stdout must still fail the check.
   */
  override replyScanSurface(output: string): string {
    if (this.historyFile === null) return output;
    try {
      return output + "\n" + readFileSync(this.historyFile.path, "utf8");
    } catch {
      return output;
    }
  }

  /**
   * The provider override, validated: aider reaches a custom endpoint only
   * through litellm's `openai/` model prefix with `OPENAI_API_BASE` and
   * `OPENAI_API_KEY` ("export OPENAI_API_BASE=<endpoint>", "Prefix the model
   * name with openai/", aider.chat/docs/llms/openai-compat.html), so the
   * override needs all three settings.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("aider", this.environment);
    if (override === null) return null;
    return requireProviderOverride("aider", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The `--model` value: with an override, the openai/ prefix routes to it. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined) {
      if (override !== null) {
        throw new Error(
          "aider needs a model for the provider override; pass --model or set CODEMUX_AIDER_PROVIDER_MODEL"
        );
      }
      return undefined;
    }
    if (override === null) return resolved;
    return resolved.startsWith("openai/") ? resolved : `openai/${resolved}`;
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
      // Claimed provisionally pending this session's live check through a
      // provider override (GLM-5.3 via Z.AI): `codemux check --hermetic -a
      // aider` with CODEMUX_AIDER_PROVIDER_* exported. Revert on failure; see
      // docs/HERMETIC.md.
      supportsHermetic: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--dry-run"];
      case "low":
        return [];
      case "medium":
      case "high":
        return ["--yes-always"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--reasoning-effort", level];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = this.baseCommand();
    if (request.hermetic) {
      // Aider is hermetic by construction: every codemux run already pins the
      // config, env file, model metadata and history files to packaged or
      // null paths, and aider has no skills, hooks, plugins or MCP. The one
      // channel left is the repository map, which injects working-directory
      // file contents into every prompt; a zero budget disables it
      // (--map-tokens "Suggested number of tokens to use for repo map, use 0
      // to disable", aider 0.86.2 --help).
      cmd.push("--map-tokens", "0");
    } else if (request.instructionDirs) {
      // Aider discovers no instruction files of its own, so an instruction
      // directory maps onto --read, the only channel that adds a file's
      // content to the chat. It is deliberately not passed under --hermetic:
      // nothing harness-side would ignore it, so passing it would leak by
      // construction. The hermetic check's control probe uses this to show
      // the planted files would reach the model.
      for (const dir of request.instructionDirs) {
        for (const name of ["AGENTS.md", "CLAUDE.md"]) {
          cmd.push("--read", join(dir, name));
        }
      }
    }
    const model = this.modelFor(request.model);
    if (model) {
      cmd.push("--model", model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    cmd.push(`--message=${request.prompt}`);
    return cmd;
  }

  override getRunEnv(_request: RunRequest): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    return {
      OPENAI_API_KEY: override.apiKey,
      OPENAI_API_BASE: override.baseUrl,
    };
  }

  override getTuiEnv(): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    return {
      OPENAI_API_KEY: override.apiKey,
      OPENAI_API_BASE: override.baseUrl,
    };
  }

  override getStdinInput(_request: RunRequest): string | null {
    // Aider treats EOF as acceptance for yes-default prompts. Headless runs
    // must explicitly decline OAuth, URL opening, and supervised tool prompts.
    return HEADLESS_NEGATIVE_RESPONSES;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoAiderProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    if (Buffer.byteLength(request.prompt, "utf8") > MAX_ARGV_PROMPT_BYTES) {
      throw new Error(
        `aider passes prompts in argv; prompt exceeds the ${MAX_ARGV_PROMPT_BYTES}-byte safe limit`
      );
    }
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the harness's own default model would hit the
    // custom endpoint and fail opaquely.
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
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    assertNoAiderProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = this.baseCommand();
    const resolved = this.modelFor(model);
    if (resolved) {
      cmd.push("--model", resolved);
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
