import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoKimiProjectExecutionConfig } from "../project-safety.js";
import { kimiPromptIsCommand } from "../session/kimi-session.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { writeKimiNoToolsFile } from "../kimi-no-tools.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

/**
 * Kimi Code CLI (`kimi`), audited against 0.31.1.
 *
 * Autonomy maps onto three native switches in interactive sessions: the default
 * asks before acting, `--yolo` auto-approves tool calls while still asking
 * questions, `--auto` removes the questions too, and `--plan` is the read-only
 * equivalent. None of them may be combined with `--prompt`, so headless runs
 * carry no native control and depend on the scode boundary that every level
 * below `high` already requires.
 *
 * `--tools none`: no flag removes kimi's tools, but an agent definition's
 * `tools: []` frontmatter is the profile's own allowlist, and the tool
 * manager's gates are strict membership tests, so an empty list exposes no
 * built-in and no MCP tool (see src/kimi-no-tools.ts for the grounding). The
 * file's required prompt body is `${base_prompt}`, the default profile's own
 * prompt, so the run keeps kimi's base instructions. Verified live on
 * 2026-09-17 through the provider override: under it neither the read nor
 * the shell capability probe could produce its secret, while a plain run
 * produced both.
 *
 * A provider override rides the `KIMI_MODEL_*` environment group: setting
 * `KIMI_MODEL_NAME` makes the CLI synthesize a temporary provider in memory
 * (nothing is written to config.toml), with the key, base URL and protocol
 * from the sibling variables (kimi-code docs, "Define a model from
 * environment variables"). The variables are read from the real process
 * environment, so the override needs no file and works in both run kinds.
 */
export class KimiAdapter extends BaseAdapter {
  readonly id: AgentId = "kimi";
  readonly binaryName = "kimi";

  // Seams so tests can point the real brand home at a scratch directory.
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
      // 0.31.1 exposes no reasoning-effort or thinking-budget control.
      supportsEffort: false,
      effortLevels: [],
      // Verified live on 2026-09-17 through a provider override (GLM-5.3
      // via Z.AI): under --tools none the read and shell probes produced
      // neither secret, while a plain run produced both (docs/HERMETIC.md).
      supportsToolSelection: true,
      supportsProviderOverride: true,
    };
  }

  /**
   * The provider override, validated: kimi's only env-driven custom provider
   * is the `KIMI_MODEL_*` synthesis, which needs a base URL and a key.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("kimi", this.environment);
    if (override === null) return null;
    return requireProviderOverride("kimi", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model id the synthesized provider sends: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "kimi needs a model for the provider override; pass --model or set CODEMUX_KIMI_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /** The `KIMI_MODEL_*` environment for an active override, else nothing. */
  private providerEnv(model: string | undefined): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    return {
      KIMI_MODEL_NAME: this.modelFor(model)!,
      KIMI_MODEL_API_KEY: override.apiKey,
      KIMI_MODEL_BASE_URL: override.baseUrl,
      // The Z.AI-style endpoints the override targets speak the OpenAI
      // chat-completions protocol; kimi's own protocol is the default.
      KIMI_MODEL_PROVIDER_TYPE: "openai",
      // The caps ride the sibling variables the synthesis reads:
      // KIMI_MODEL_MAX_COMPLETION_TOKENS is the reply budget's hard cap and
      // KIMI_MODEL_MAX_CONTEXT_SIZE the context window (both parsed from the
      // environment in the installed binary; the cap names differ by one
      // word and are not interchangeable — MAX_OUTPUT_SIZE is an output-SIZE
      // knob of a different unit, deliberately unused).
      ...(override.maxOutputTokens !== undefined
        ? { KIMI_MODEL_MAX_COMPLETION_TOKENS: String(override.maxOutputTokens) }
        : {}),
      ...(override.maxContextTokens !== undefined
        ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(override.maxContextTokens) }
        : {}),
    };
  }

  /**
   * The brand home whose `.codemux/` holds the generated agent file: the one
   * a plain run of this request reads config.toml, skills and agents from.
   * The sanitized child environment drops KIMI_CODE_HOME unless the operator
   * passes it through with --pass-env, in which case both kinds of run use
   * that directory. The value is read exactly as the child receives it --
   * the session boundary's belief (round al11), applied to the run path
   * (round al21, contracts-2 minor 7): kimi reads the variable without
   * trimming, so a padded value names a real (differently spelled)
   * directory to the child, and a trimmed copy here placed the generated
   * agent file under a spelling the child never reads. An empty value is
   * refused rather than treated as unset (round al16, the session's rule):
   * kimi's own resolver preserves an empty KIMI_CODE_HOME and places its
   * store under the working directory, so no default codemux could fall
   * back to names the directory the child actually uses. A value that names
   * no existing directory is refused too, on every run that passes the
   * variable through (round al29, correctness major 5; the TUI path joined
   * in round al30, contracts minor — validateTuiRequest ran the model and
   * project checks but not this one, so `codemux tui -a kimi` launched with
   * a typo'd home where the same run was refused): the child reads its
   * config, skills and store from that directory whatever the run kind, so
   * a passed-through value is the operator naming their real brand home,
   * and a missing one is a typo kimi would paper over by creating a fresh,
   * empty store. The DEFAULT home carries no such check: it legitimately
   * does not exist before kimi's own first run.
   */
  private realBrandHome(passthroughEnv?: readonly string[]): string {
    const passedThrough = passthroughEnv?.includes("KIMI_CODE_HOME") ?? false;
    const configured = this.environment.KIMI_CODE_HOME;
    if (!passedThrough || configured === undefined) {
      return join(this.effectiveHome(), ".kimi-code");
    }
    if (configured === "") {
      throw new UsageRefusalError(
        "KIMI_CODE_HOME must not be empty when passed through; kimi's own " +
          "resolver preserves an empty value and places its store under the " +
          "working directory — unset the variable or give it an absolute " +
          "path"
      );
    }
    if (!isAbsolute(configured)) {
      throw new UsageRefusalError("KIMI_CODE_HOME must be an absolute path");
    }
    let stat: ReturnType<typeof statSync> | null;
    try {
      stat = statSync(configured);
    } catch {
      stat = null;
    }
    if (stat === null || !stat.isDirectory()) {
      throw new UsageRefusalError(
        "KIMI_CODE_HOME must be an existing directory when passed through; " +
          "the value names no directory here — kimi would create a fresh, " +
          "empty store under it instead of reading the brand home the " +
          "operator meant, so the typo fails the launch rather than " +
          "silently forking the store. Create the directory or unset the " +
          "variable"
      );
    }
    return configured;
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Kimi home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  override prepareRun(request: RunRequest): RunContext {
    // One generated agent file per --tools none run, never shared and never
    // recorded on the adapter: the launcher owns the returned context and
    // finalizes the file in cleanupRun when this launch ends.
    if (request.tools !== "none") return {};
    return {
      kimiNoToolsFile: writeKimiNoToolsFile(this.realBrandHome(request.passthroughEnv)),
    };
  }

  override cleanupRun(context?: RunContext): void {
    context?.kimiNoToolsFile?.finalize();
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        // The default already prompts before each tool call.
        return [];
      case "medium":
        return ["--yolo"];
      case "high":
        return ["--auto"];
    }
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    return this.providerEnv(request.model);
  }

  override getTuiEnv(model?: string): Record<string, string> {
    return this.providerEnv(model);
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd = ["kimi"];

    // With an override the synthesized provider is the default model, and
    // `-m` names a config alias that outranks it — one that does not exist
    // outside config.toml — so the flag stays off and the environment drives.
    if (request.model && this.validatedProvider() === null) {
      cmd.push("--model", request.model);
    }
    // 0.31.1 rejects --plan, --yolo, and --auto when combined with --prompt
    // ("Cannot combine --prompt with --plan"), verified against the installed
    // binary. Headless Kimi therefore has no native autonomy control at all,
    // and the level is enforced entirely by the scode boundary that every level
    // below `high` already requires. The flags below are interactive-only and
    // are applied in buildTuiCommand.

    if (request.tools === "none") {
      // A static preview (`verify`) has no prepared file; the placeholder
      // path does not exist, and kimi fails to read it, so a command built
      // without prepareRun fails closed.
      const unprepared = join(
        this.realBrandHome(request.passthroughEnv),
        ".codemux",
        "unprepared"
      );
      cmd.push("--agent-file", context?.kimiNoToolsFile?.path ?? unprepared);
    }

    // 0.31.1 has no stdin transport: the prompt is an argv value. BaseAdapter
    // bounds its length, the same as the other argv-only harnesses.
    cmd.push("--prompt", request.prompt);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoKimiProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // The refusal class is usage (exit 64, UsageRefusalError), the aider
    // rule the session driver already applies before its ack (round al11;
    // the README's live-sessions sentence names the run path's refusal,
    // which did not exist). What is refused narrowed in al17 to what
    // kimi's headless path actually dispatches: 0.31.1 parses only
    // goal-creates before the model turn, so every other `/`-leading
    // prompt (a path like /tmp/notes.md first among them) reaches the
    // model unchanged, and the refusals are the word-bounded `/goal`
    // name (dispatched as the goal flow with its own exit codes, never
    // a model turn) and the `!` shell-escape shape (kimiPromptIsCommand
    // states the full rule). Round al18 corrected the message to the
    // per-shape truth: only /goal CREATES dispatch (the goal flow, its
    // own exit codes), while the other /goal subcommands fall through
    // to the model as prompt text in 0.31.1 — the whole name is refused
    // as codemux's own policy, not as a claim that kimi would have run
    // every spelling headlessly.
    if (kimiPromptIsCommand(request.prompt)) {
      throw new UsageRefusalError(
        "kimi prompts must not be the /goal command or a '!' shell line: " +
          "kimi dispatches only /goal creates headlessly (its goal flow, " +
          "with its own exit codes, never a model turn), while the other " +
          "/goal subcommands fall through to the model as prompt text — " +
          "codemux refuses the whole word-bounded /goal name as policy, so " +
          "the boundary does not ride on kimi's dispatch table, and '!' is " +
          "kimi's shell-escape shape, refused rather than dispatched; every " +
          "other prompt (a /-leading path included) is model text and passes"
      );
    }
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the operator's own login and default model
    // would otherwise silently answer.
    this.modelFor(request.model);
    // The passed-through KIMI_CODE_HOME is checked exactly as the child
    // reads it here, before prepareRun writes the agent file under it
    // (round al21, contracts-2 minor 7). Round al29 (correctness major 5)
    // widened the check to EVERY run that passes the variable through: the
    // child reads its config, skills and store from that directory
    // whatever the run kind, so the empty/relative/missing refusals cannot
    // depend on --tools none being the one kind codemux itself writes
    // under it — and the refusals are UsageRefusalErrors (exit 64, the
    // session boundary's own class for them, zero drift between the two
    // paths). The default home (no passthrough) stays exempt.
    this.realBrandHome(request.passthroughEnv);
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: undefined,
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
    assertNoKimiProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    this.modelFor(model);
    // The passed-through KIMI_CODE_HOME is validated on the TUI path too
    // (round al30, contracts minor): the child kimi reads its config,
    // skills and store from that directory whatever the launch kind, so
    // the run path's empty/relative/missing refusals apply unchanged —
    // same UsageRefusalError class, exit 64, both paths.
    this.realBrandHome(passthroughEnv);
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel): string[] {
    const cmd = ["kimi"];
    if (model && this.validatedProvider() === null) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
