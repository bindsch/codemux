import { BaseAdapter, type RunContext } from "./base.js";
import { devNull, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import { assertNoAiderProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import {
  createAiderHistoryFile,
  extractAiderReply,
  readAiderHistory,
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
  RunResult,
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

  private baseCommand(context?: RunContext): string[] {
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
      // A per-run file when prepareRun created one (hermetic runs only,
      // removed in cleanupRun, and the hermetic check's answer source),
      // /dev/null otherwise: plain runs, TUI sessions and static previews
      // keep writing nowhere.
      "--chat-history-file",
      context?.aiderHistoryFile?.path ?? devNull,
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

  override prepareRun(request: RunRequest): RunContext {
    // A history file only where its reader is: the hermetic check's answer
    // extraction (processRunResult below, through `reply` and
    // `scanSurface`). Plain runs keep /dev/null — nothing reads their
    // history, and writing it would persist the whole conversation on disk
    // for nothing (h6 review; the file used to ride every run). The check
    // is refused today, so no reachable run writes one; the machinery
    // stays for the day aider grows a switch, and nothing is recorded on
    // the adapter — the launcher owns the context.
    if (!request.hermetic) return {};
    return { aiderHistoryFile: createAiderHistoryFile(this.effectiveHome()) };
  }

  override cleanupRun(context?: RunContext): void {
    context?.aiderHistoryFile?.finalize();
  }

  /**
   * Reads the run's chat history HERE, while the context is alive, and
   * hands post-launch callers what stdout cannot: the model's answer
   * without the banner and summaries that drown it (`reply`, so the
   * hermetic check's exact-OK test runs on the answer, failing closed on
   * an unreadable or empty history rather than certifying a transcript),
   * and the full record for a leak scan (`scanSurface` -- aider folds the
   * endpoint's reasoning into the history and omits it from stdout, so a
   * code word that never reached stdout must still fail the check). The
   * launcher disposes the context right after this returns, so the result
   * is the check's only channel to the file.
   */
  override processRunResult(
    result: RunResult,
    _request: RunRequest,
    context?: RunContext
  ): RunResult {
    const history = context?.aiderHistoryFile;
    if (history === undefined) return result;
    // The read itself trusts nothing about the file (readAiderHistory:
    // no symlink, bounded size — the sandboxed harness can write the
    // directory it lives in).
    const contents = readAiderHistory(history.path);
    if (contents === null) {
      // Unreadable, a symlink, or oversized history: leave stdout as the
      // answer, the check's fail-closed default.
      return result;
    }
    return {
      ...result,
      reply: extractAiderReply(contents),
      scanSurface: `${result.stdout}\n${contents}`,
    };
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
      // --hermetic is refused (2026-10-04 review): the pinned flags close
      // only the channels codemux hands aider. Aider itself still reads
      // .aider.conf.yml from the home, git root and working directory
      // alongside --config (default_config_files, main.py at 0.86.2), the
      // same search loads .env and .aider.model.settings.yml beside the
      // pinned files (generate_search_path_list), and all of it loads
      // inside the aider process, where the sanitizer's AIDER_* block
      // cannot see it. The check's canary never rode those channels, which
      // is why the live pass certified what the flags do not close; see
      // docs/HERMETIC.md.
      supportsHermetic: false,
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

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd = this.baseCommand(context);
    if (request.hermetic) {
      // Unreachable from the CLI (supportsHermetic is false; the request
      // refuses before a command is built), kept for the day aider grows a
      // switch for its own config layers: every codemux run already pins
      // the config, env file, model metadata and history files to packaged
      // or null paths, and a zero repo-map budget keeps working-directory
      // file contents out of the prompt (--map-tokens "Suggested number of
      // tokens to use for repo map, use 0 to disable", aider 0.86.2 --help)
      // -- but the .aider.conf.yml/.env/.aider.model.settings.yml searches
      // from the home, git root and working directory have no flag at all
      // (docs/HERMETIC.md).
      cmd.push("--map-tokens", "0");
    } else if (request.instructionDirs) {
      // Aider discovers no instruction files of its own, so an instruction
      // directory maps onto --read, the only channel that adds a file's
      // content to the chat. It is deliberately not passed under --hermetic:
      // nothing harness-side would ignore it, so passing it would leak by
      // construction.
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
