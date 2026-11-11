import { BaseAdapter } from "./base.js";
import type { LaunchIntent } from "../types.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import { existsSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoAiderProjectExecutionConfig } from "../project-safety.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import {
  createAiderHistoryFile,
  readAiderHistory,
} from "../aider-history.js";
import { createAiderRunFiles, type AiderRunContext } from "../aider-run-files.js";
import { aiderReportedLengthStop, parseAiderAnalytics } from "../result-envelope/aider.js";
import { withTruncationNotice } from "../answer-complete.js";
import { extractAiderReply } from "../aider-history-text.js";
import { assertCleanInstructionFiles } from "../clean-cwd.js";
import {
  assertProviderCap,
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
import { envKeyLoginState, type LoginState } from "../harness-health.js";

export const AIDER_EMPTY_CONFIG_PATH = fileURLToPath(
  new URL("../../resources/aider-empty.yml", import.meta.url)
);
export const AIDER_MODEL_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/aider-model-settings.yml", import.meta.url)
);
export const AIDER_MODEL_METADATA_PATH = fileURLToPath(
  new URL("../../resources/aider-model-metadata.json", import.meta.url)
);
/** One block of the canned declines every headless aider spawn feeds its
 * stdin: aider treats EOF as acceptance for its yes-default prompts (OAuth,
 * URL opening, supervised tool prompts), so a spawn that never answers must
 * answer no. The block REPEATS for the child's whole lifetime (the
 * adapter's stdinRepeats): a run that meets a 65th prompt still answers
 * no, and stdin is never closed while the child lives, because that EOF is
 * the acceptance this exists to prevent (review round 153). Exported for
 * the session driver's per-turn spawns. */
export const HEADLESS_NEGATIVE_RESPONSES = "n\n".repeat(64);

/** AskCoder has no functions or edits. Without Git, get_all_relative_files
 * returns in-chat files only, so subtracting those leaves no addable files.
 * URL detection, the repo map, and automatic lint/test paths are disabled. */
export const AIDER_NO_TOOLS_FLAGS = [
  "--chat-mode", "ask", "--no-git", "--map-tokens", "0",
  "--no-detect-urls", "--no-auto-lint", "--no-auto-test",
] as const;

/** The fixed headless flags every aider spawn shares — run, TUI, and the
 * session driver's per-turn processes — with the chat history target as
 * the one varying path. Exported so the session command cannot drift
 * from the run command. */
export function aiderBaseFlags(chatHistoryPath: string): string[] {
  return [
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
    "--chat-history-file",
    chatHistoryPath,
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

/** Whether aider would run this text as one of its own commands rather
 * than a prompt: aider's `preproc_user_input` dispatches any message
 * whose first non-whitespace character is `/` (a slash command) or `!`
 * (the `/run` alias) BEFORE any model turn — and `/run` executes the
 * shell immediately, ungated by the autonomy flags (`--dry-run` does
 * not reach it). Codemux refuses such text outright on both surfaces —
 * `run` here in validateRunRequest, the session driver before the ack —
 * never escapes it: the autonomy a session records is meant to bound
 * what caller text can do, and an escaped dispatch would only hide the
 * intent (review D10, security). Shared so the two paths cannot drift. */
export function aiderPromptIsCommand(text: string): boolean {
  const first = text.trimStart()[0];
  return first === "/" || first === "!";
}

export class AiderAdapter extends BaseAdapter {
  readonly id: AgentId = "aider";
  readonly binaryName = "aider";

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super(environment);
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

  private baseCommand(context?: AiderRunContext): string[] {
    // A per-run file when prepareRun created one (hermetic runs only,
    // removed in cleanupRun, and the hermetic check's answer source),
    // /dev/null otherwise: plain runs, TUI sessions and static previews
    // keep writing nowhere.
    const cmd = ["aider", ...aiderBaseFlags(context?.aiderHistoryFile?.path ?? devNull)];
    if (context?.aiderRunFiles?.modelSettingsPath) {
      cmd[cmd.indexOf("--model-settings-file") + 1] = context.aiderRunFiles.modelSettingsPath;
    }
    return cmd;
  }

  override prepareRun(request: RunRequest, _trust?: ScodeTrustLevel, _sandbox?: SandboxOptions, launch: LaunchIntent = {}): AiderRunContext {
    const files = createAiderRunFiles(this.realAiderDir(), request.prompt,
      this.modelFor(request.model), this.validatedProvider()?.maxOutputTokens, launch.printOnly);
    try {
      return {
        aiderRunFiles: files,
        ...(request.hermetic ? {
          aiderHistoryFile: launch.printOnly ? { path: join(files.home, "history.txt"), finalize: () => {} } : createAiderHistoryFile(this.effectiveHome()),
          aiderHermeticHome: files,
        } : {}),
      };
    } catch (error) {
      files.finalize();
      throw error;
    }
  }

  override cleanupRunSync(context?: AiderRunContext): void {
    context?.aiderHistoryFile?.finalize();
    context?.aiderHermeticHome?.finalize();
    context?.aiderRunFiles?.finalize();
  }

  /** The real ~/.aider directory both per-run scratch parents live under. */
  private realAiderDir(): string {
    return join(this.effectiveHome(), ".aider");
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
    context?: AiderRunContext
  ): RunResult {
    if (context?.aiderRunFiles) {
      const analytics = readAiderHistory(context.aiderRunFiles.analyticsPath);
      if (analytics !== null && analytics.trim()) {
        result = { ...result, ...parseAiderAnalytics(analytics) };
      }
    }
    result = withTruncationNotice(result, "aider", { messages: [],
      truncated: aiderReportedLengthStop(`${result.stdout}\n${result.stderr}`) });
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
   * override needs all three settings. A model settings file carries
   * max_tokens; max_input_tokens only triggers an overridable question.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("aider", this.environment);
    if (override === null) return null;
    assertProviderCap("aider", override, "maxContextTokens",
      "aider 0.86.2 max_input_tokens is advisory: check_tokens asks 'Try to proceed anyway?' " +
      "and --yes-always bypasses it; no hard context-token cap exists");
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
        throw new UsageRefusalError(
          "aider needs a model for the provider override; pass --model or set CODEMUX_AIDER_PROVIDER_MODEL"
        );
      }
      return undefined;
    }
    if (override === null) return resolved;
    return resolved.startsWith("openai/") ? resolved : `openai/${resolved}`;
  }

  /** The wire `--model` value for a launch the caller builds itself (the
   * session driver's per-turn spawns): exactly what buildRunCommand would
   * pass, so the session turns and the run path cannot drift. */
  wireModelFor(model: string | undefined): string | undefined {
    return this.modelFor(model);
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
      // Hermetic (the 2026-10-04 refusal, closed): the pinned flags left
      // open every config layer aider searches itself — .aider.conf.yml,
      // .env, .aider.model.settings.yml and .aider.model.metadata.json
      // from the home, the git root and the working directory, plus
      // ~/.aider/oauth-keys.env (main.py at 0.86.2: default_config_files,
      // load_dotenv_files, generate_search_path_list; read 2026-11-09) —
      // and no flag closes them (the 2026-09-17 evidence stands). A private
      // HOME (src/aider-hermetic.ts) empties the home entries at once, and
      // the clean-working-directory rule refuses those four names from the
      // working directory up to the project root, the same range aider
      // searches. --result-json stays refused: aider 0.86.2 has no JSON
      // output mode (its argparse surface and --help list none), so there
      // is no machine-readable stream to fold.
      supportsHermetic: true,
      supportsProviderOverride: true,
      supportsToolSelection: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // Low's carrier is not argv but the stdin stream getStdinInput feeds
    // (HEADLESS_NEGATIVE_RESPONSES): aider 0.86.2's confirm_ask answers
    // from a yes/no flag when one is set and otherwise prompts, and EOF
    // accepts the default — which is yes for yes-default prompts — so the
    // repeating `n` lines ARE the low carrier (io.py confirm_ask, read
    // 2026-11-08). --yes-always exists as the auto-confirm flag (args.py,
    // store_true, default None, no negative spelling) and carries
    // medium/high natively.
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

  buildRunCommand(request: RunRequest, context?: AiderRunContext): string[] {
    const cmd: string[] = [];
    if (request.hermetic) {
      // HOME is assigned inside the sandbox command, never the run
      // environment: scode derives its policy and credential access from
      // the real home (the kimi rule, src/aider-hermetic.ts). Python's
      // Path.home() follows it, so aider's own home, git-root and cwd
      // config searches see the empty private home. A static preview
      // (verify) passes no context and gets a placeholder path naming no
      // real directory.
      const home = context?.aiderHermeticHome?.home ??
        join(this.realAiderDir(), ".codemux-hermetic", "unprepared");
      cmd.push("env", `HOME=${home}`);
    }
    cmd.push(...this.baseCommand(context));
    const files = context?.aiderRunFiles;
    const previewRoot = join(this.realAiderDir(), ".codemux-hermetic", "unprepared");
    cmd.push("--no-stream", "--analytics-log", files?.analyticsPath ?? join(previewRoot, "analytics.jsonl"));
    if (request.tools === "none") cmd.push(...AIDER_NO_TOOLS_FLAGS);
    if (request.web === false) cmd.push("--no-detect-urls");
    if (this.validatedProvider()?.maxOutputTokens !== undefined && !files) {
      cmd[cmd.indexOf("--model-settings-file") + 1] = join(previewRoot, "model-settings.yml");
    }
    if (request.hermetic) {
      // A zero repo-map budget keeps working-directory file contents out
      // of the prompt (--map-tokens "Suggested number of tokens to use for
      // repo map, use 0 to disable", aider 0.86.2 --help): hermetic is a
      // hermetic run of the model, not of the repo map.
      cmd.push("--map-tokens", "0");
    } else if (request.instructionDirs) {
      // Aider discovers no instruction files of its own, so an instruction
      // directory maps onto --read, the only channel that adds a file's
      // content to the chat. Only a file that exists is passed (review
      // round 391, item 9): aider 0.86.2 exits 1 at argv parse when a
      // --read file is missing, so an unconditional pair made a directory
      // holding only one of the two names a validated request whose
      // command was guaranteed to die. It is deliberately not passed under
      // --hermetic: nothing harness-side would ignore it, so passing it
      // would leak by construction.
      for (const dir of request.instructionDirs) {
        for (const name of ["AGENTS.md", "CLAUDE.md"]) {
          const file = join(dir, name);
          if (existsSync(file)) cmd.push("--read", file);
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
    cmd.push("--message-file", files?.promptPath ?? join(previewRoot, "prompt.txt"));
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
    assertProviderCap("aider", override, "maxOutputTokens", "aider output caps require a prepared headless run");
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

  override promptInArgv(_request: RunRequest): boolean {
    // --message-file keeps prompt bytes out of argv. Stdin remains the
    // repeating negative answers; reading /dev/stdin would consume those.
    return false;
  }

  override stdinRepeats(_request: RunRequest): boolean {
    // While the child lives, its stdin never reaches EOF and always
    // answers a decline: one block in flight at a time, the next written
    // only after the previous flushed (review round 153).
    return true;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoAiderProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // The refusal class is usage (exit 64, UsageRefusalError), not a run
    // failure: a prompt that dispatches a slash command is a request only
    // the caller can fix, and the message names the rule (review D10,
    // security).
    if (aiderPromptIsCommand(request.prompt)) {
      throw new UsageRefusalError(
        "aider prompts must not start with '/' or '!': aider runs those as " +
          "its own commands before any model turn (/run, the '!' alias, " +
          "executes the shell immediately, ungated by --dry-run and the " +
          "other autonomy flags), so the prompt is refused rather than " +
          "dispatched"
      );
    }
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the harness's own default model would hit the
    // custom endpoint and fail opaquely.
    this.modelFor(request.model);
    if (request.hermetic) {
      if (request.cwd === undefined) {
        throw new UsageRefusalError("aider --hermetic requires an explicit --cwd owned by this run");
      }
      // The channels the private HOME cannot close: aider searches the same
      // four names from the working directory up to the project root (the
      // same range this walk covers). A dangling symlink counts (lstat):
      // aider resolves it.
      assertCleanInstructionFiles("aider", validateWorkingDirectory(request.cwd)!, [
        ".aider.conf.yml",
        ".aider.model.settings.yml",
        ".aider.model.metadata.json",
        ".env",
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
    const override = this.validatedProvider();
    if (override) assertProviderCap("aider", override, "maxOutputTokens", "aider output caps require a prepared headless run");
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const override = this.validatedProvider();
    if (override) assertProviderCap("aider", override, "maxOutputTokens", "aider output caps require a prepared headless run");
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

  /** The aider login read: a credential variable in the environment. */
  override loginState(): LoginState {
    return envKeyLoginState(this.id, this.environment);
  }
}
