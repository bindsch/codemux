import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import { combinedCleanupFailure } from "../experiment-records.js";
import { join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoKimiProjectExecutionConfig } from "../project-safety.js";
import { kimiPromptIsCommand } from "../session/kimi-session.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { writeKimiNoToolsFile } from "../kimi-no-tools.js";
import { createKimiPolicyHome, prepareKimiPlaywright } from "../kimi-run-policy.js";
import { createKimiHermeticHome, KIMI_HERMETIC_ENV_ASSIGNMENTS, KIMI_HERMETIC_ENV_OMISSIONS } from "../kimi-hermetic.js";
import { assertNoKimiHermeticProjectConfig } from "../kimi-project-safety.js";
import { validateProjectSettingsRunRequest } from "../claude-project-settings.js";
import { kimiPlainResult, kimiResult } from "../result-envelope/kimi.js";
import { appendDiagnostic } from "../result-envelope.js";
import { foldOverflowEvidence, foldScanEvidence, KimiPlainFold } from "../plain-unwrap/kimi-fold.js";
import { kimiEffectiveHome, kimiRealBrandHome, kimiResultBrandHome } from "./kimi-home.js";
import { escapeForTerminal } from "../usage-protocol.js";
import { parseVersionParts } from "../harness-compatibility.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { ExperimentKimiRun } from "../experiment-kimi-run.js";
import type { ExperimentFailure } from "../experiment-records.js";
import {
  kimiProviderEnv,
  kimiProviderModelFor,
  kimiValidatedProvider,
} from "../kimi-provider.js";
import type { ProviderOverride } from "../provider-override.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
 LaunchIntent } from "../types.js";
import { kimiLoginState, loginHome, type LoginState } from "../harness-health.js";

/**
 * Kimi Code CLI (`kimi`), installed 2.4.0; contract audited against 2.4.0
 * (live gate 2026-11-02; the 0.31.1 flag audit below still holds).
 * Every headless run asks for the stream-json wire; plain runs unwrap it
 * (reply and wire-log usage, kimiPlainResult). Only a binary that ignored
 * `--output-format` prints the 2.3.2 bullet blocks with two-space
 * continuations, removed by processRunResult only for installed major
 * versions 2 and higher when all stdout matches; older ones stay as-is.
 *
 * Autonomy maps onto three native switches in interactive sessions: the
 * default asks before acting, `--yolo` auto-approves tool calls, `--auto`
 * removes the questions too, and `--plan` is the read-only equivalent.
 * None of them may be combined with `--prompt`, so headless runs carry no
 * native control and depend on the scode boundary that every level below
 * `high` already requires.
 *
 * `--tools none`: no flag removes kimi's tools, but an agent definition's
 * `tools: []` frontmatter is the profile's own allowlist, and the tool
 * manager's gates are strict membership tests, so an empty list exposes no
 * built-in and no MCP tool (src/kimi-no-tools.ts). Verified live on
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
      // KIMI_MODEL_THINKING_EFFORT, the config layer's env alias for the
      // [thinking] forcedEffort field (kimi 2.5.2 bundle byte ~97385100:
      // envBindings(ThinkingConfigSchema, { forcedEffort:
      // "KIMI_MODEL_THINKING_EFFORT" }), applied to every run kind).
      // resolveForcedThinkingEffort (byte ~98845400) applies the value
      // whenever the model's thinking is not already "off", and the
      // vocabulary's "off" is the disable state (resolveThinkingEffort,
      // byte ~97226900), so `none` maps to `off` and a model that rejects
      // the level fails at its own thinking-cannot-disable error.
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high"],
      // Verified live on 2026-09-17 through a provider override (GLM-5.3
      // via Z.AI): under --tools none the read and shell probes produced
      // neither secret, while a plain run produced both (docs/isolation.md).
      supportsToolSelection: true,
      supportsHermetic: true,
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  /** The provider override, validated (kimi-provider.ts holds the rule). */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    return kimiValidatedProvider(this.environment);
  }

  /** The model id the synthesized provider sends: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    return kimiProviderModelFor(this.environment, model);
  }

  /** The `KIMI_MODEL_*` environment for an active override, else nothing. */
  private providerEnv(model: string | undefined): Record<string, string> {
    return kimiProviderEnv(this.environment, model);
  }

  /**
   * The brand home whose `.codemux/` holds the generated agent file. The
   * whole rule — the exact-as-read value, the empty and relative and
   * missing-directory refusals, the default home's exemption — lives with
   * its grounding in kimi-home.ts (kimiRealBrandHome).
   */
  private realBrandHome(passthroughEnv?: readonly string[]): string {
    return kimiRealBrandHome(this.environment, passthroughEnv, this.effectiveHome());
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    return kimiEffectiveHome(this.environment, this.homeDirectory);
  }

  override prepareRun(request: RunRequest, _sandboxTrust?: ScodeTrustLevel, _sandboxOptions?: SandboxOptions, launch: LaunchIntent = {}): RunContext {
    const printOnly = launch.printOnly === true;
    // The project-settings gate runs before any artifact this method
    // creates (claude's ordering rule): a programmatic caller cannot
    // reach the private home without hermetic mode, the scode sandbox,
    // and low autonomy.
    if (request.experimentProjectSettings) validateProjectSettingsRunRequest(request);
    if (request.experimentMcp) {
      const spec = readExperimentRunSpec(request);
      if (!request.hermetic && !spec.control) throw new UsageRefusalError("Kimi experiment requires a private hermetic home");
      // The control probe's write target is the brand home carried on the
      // request (the planted scratch home), never an environment hint the
      // planted adapter happens to carry.
      const controlBrandHome = request.kimiControlBrandHome ?? this.realBrandHome(request.passthroughEnv);
      const context: RunContext = request.hermetic
        ? { kimiHermeticHome: createKimiHermeticHome(this.realBrandHome(), true, printOnly) }
        : { kimiNoToolsFile: writeKimiNoToolsFile(controlBrandHome) };
      try {
        const experiment = new ExperimentKimiRun(spec, request.cwd ?? process.cwd(),
          context.kimiHermeticHome?.kimiHome ?? controlBrandHome,
          context.kimiHermeticHome?.agentFile ?? context.kimiNoToolsFile!.path, this.environment);
        context.experimentKimi = experiment;
        context.experimentRecording = experiment.recordingPath;
        context.stdoutSink = experiment;
        return context;
      } catch (error) { this.cleanupRunSync(context); throw error; }
    }
    if (request.hermetic || request.web === false || request.enablePlaywrightMcp) {
      const context: RunContext = {
        kimiHermeticHome: createKimiPolicyHome(this.realBrandHome(request.passthroughEnv), request, printOnly),
      };
      if (!request.resultJson) context.stdoutSink = new KimiPlainFold();
      return context;
    }
    // One generated agent file per --tools none run, never shared and never
    // recorded on the adapter: the launcher owns the context, finalizing the
    // file in cleanupRun when this launch ends.
    if (request.tools !== "none") {
      return request.resultJson ? {} : { stdoutSink: new KimiPlainFold() };
    }
    const noToolsFile = writeKimiNoToolsFile(this.realBrandHome(request.passthroughEnv));
    const context: RunContext = { kimiNoToolsFile: noToolsFile };
    if (!request.resultJson) context.stdoutSink = new KimiPlainFold();
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    try { this.cleanupHome(context); }
    finally {
      const experiment = context?.experimentKimi;
      if (experiment && !experiment.hasOutput) experiment.relay.fail(new Error("interrupted before harness evidence"));
      experiment?.closeSync();
    }
  }

  private cleanupHome(context?: RunContext): void {
    const experiment = context?.experimentKimi;
    // The hermetic home (copied credentials) and the no-tools file (in the
    // real brand home) are finalized even when evidence preservation
    // fails (review round 64). One failure rethrows as itself, several as
    // one AggregateError naming each.
    const failures: unknown[] = [];
    try {
      experiment?.preserveHarnessLog();
    } catch (error) {
      failures.push(error);
    }
    try {
      context?.kimiHermeticHome?.finalize();
    } catch (error) {
      failures.push(error);
    }
    try {
      context?.kimiNoToolsFile?.finalize();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      // The relay latches its first failure: one combined error (round 69).
      const failure = combinedCleanupFailure(failures);
      experiment?.relay.fail(failure);
      throw failure;
    }
  }

  override cleanupRun(context?: RunContext): void | Promise<void> {
    const experiment = context?.experimentKimi;
    if (experiment) {
      const verified = experiment.hasOutput ? experiment.complete() : Promise.resolve();
      return verified.finally(() => this.cleanupHome(context)).finally(() => experiment.close());
    }
    this.cleanupRunSync(context);
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

  /** kimi's effort env value: `none` is kimi's `off`. */
  private effortEnvValue(level: ReasoningEffort): string {
    return level === "none" ? "off" : level;
  }

  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    if ((request.hermetic || request.web === false || request.enablePlaywrightMcp) && context?.kimiHermeticHome === undefined) {
      throw new Error(`kimi ${request.hermetic ? "hermetic" : "private policy"} home was not prepared before launch`);
    }
    return {
      ...this.providerEnv(request.model),
      ...(request.effort ? { KIMI_MODEL_THINKING_EFFORT: this.effortEnvValue(request.effort) } : {}),
    };
  }

  override getTuiEnv(
    model?: string,
    _autonomy?: AutonomyLevel,
    effort?: ReasoningEffort
  ): Record<string, string> {
    return {
      ...this.providerEnv(model),
      ...(effort ? { KIMI_MODEL_THINKING_EFFORT: this.effortEnvValue(effort) } : {}),
    };
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const privateHome = context?.kimiHermeticHome;
    const unpreparedHome = join(this.realBrandHome(), ".codemux-hermetic", "unprepared");
    prepareKimiPlaywright(request, context, { pathEnv: this.executionPathEnv(), forbiddenRoot: request.cwd });
    // Scode must keep the real HOME for policy and credential access. Redirect only its child.
    const cmd = request.hermetic
      ? ["env", ...KIMI_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
        ...KIMI_HERMETIC_ENV_ASSIGNMENTS,
        `HOME=${privateHome?.home ?? unpreparedHome}`,
        `KIMI_CODE_HOME=${privateHome?.kimiHome ?? join(unpreparedHome, ".kimi-code")}`, "kimi"]
      : privateHome && (request.web === false || request.enablePlaywrightMcp)
        ? ["env", `KIMI_CODE_HOME=${privateHome.kimiHome}`, "kimi"] : ["kimi"];

    // With an override the synthesized provider is the default model, and
    // `-m` names a config alias that outranks it — one that does not exist
    // outside config.toml — so the flag stays off and the environment drives.
    if (request.model && this.validatedProvider() === null) {
      cmd.push("--model", request.model);
    }
    // 2.5.2 rejects --plan, --yolo, and --auto when combined with --prompt
    // ("Cannot combine --prompt with --plan."), and the hidden yolo aliases
    // --yes and --auto-approve hit the same refusal: the option reader maps
    // them onto yolo (`raw["yolo"] === true || raw["yes"] === true ||
    // raw["autoApprove"] === true`, kimi 2.5.2 bundle strings, read
    // 2026-11-08). Headless Kimi therefore has no native autonomy control
    // at all, and the level is enforced entirely by the scode boundary
    // that every level below `high` already requires.

    if (request.hermetic) {
      const unprepared = join(this.realBrandHome(), ".codemux-hermetic", "unprepared");
      // A project-settings run drops --skills-dir: the option replaces
      // auto-discovered user AND project skill directories (2.5.2 root
      // option table), so keeping it would keep the repository's own
      // skills out of the run the flag exists to expose. The operator's
      // global channels stay blocked by the HOME/KIMI_CODE_HOME redirect.
      if (request.experimentProjectSettings !== true) {
        cmd.push("--skills-dir", context?.kimiHermeticHome?.skillsDir ?? join(unprepared, "skills-dir"));
      }
      cmd.push("--agent-file", context?.kimiHermeticHome?.agentFile ?? join(unprepared, "agent.md"));
    } else if (request.tools === "none") {
      // A static preview (`verify`) has no prepared file; the placeholder
      // path does not exist, and kimi fails to read it, so a command built
      // without prepareRun fails closed.
      const unprepared = join(
        this.realBrandHome(request.passthroughEnv),
        ".codemux",
        "unprepared"
      );
      cmd.push("--agent-file", privateHome?.agentFile ?? context?.kimiNoToolsFile?.path ?? unprepared);
    }

    // Kimi 2.5.2 reads opts.prompt in runV2Print. Every run uses stream-json;
    // plain output folds the reply and reads usage from the native wire log.
    cmd.push("--output-format", "stream-json");
    cmd.push("--prompt", request.prompt);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext, failure?: ExperimentFailure): RunResult {
    // The leak scan covers the whole printed output, shed tool payloads included (round 17, contracts-2 1).
    // The channels join with a newline (aider's rule): unseparated concatenation can fuse bytes at a
    // channel boundary into the canary marker though it exists in no single channel (round 361, item 4).
    result = { ...result, scanSurface: `${result.stdout}\n${result.stderr}\n${foldScanEvidence(context?.stdoutSink)}` };
    if (request.resultJson || request.experimentMcp) {
      if (request.hermetic && !context?.kimiHermeticHome && !failure) {
        throw new Error("kimi hermetic home was not prepared before reading results");
      }
      let model = request.model;
      try { model = this.modelFor(model); } catch (error) { if (!failure) throw error; }
      // kimiResultBrandHome never re-refuses what launch time validated (round 372, item 4).
      const brandHome = kimiResultBrandHome(this.environment, request.passthroughEnv, this.homeDirectory, context?.kimiHermeticHome?.kimiHome, failure !== undefined);
      const normalized = kimiResult(result, { ...request, model }, brandHome, context, failure);
      if (request.experimentMcp && !request.resultJson) {
        try {
          const reply: unknown = JSON.parse(normalized.stdout).reply;
          return typeof reply === "string" ? { ...normalized, stdout: reply } : normalized;
        }
        catch { return normalized; }
      }
      return normalized;
    }
    // Plain runs: the same structured launch, unwrapped. The reply and the
    // wire-log usage come off the stream exactly as a --result-json run's
    // do, while stdout keeps the plain contract (the reply, never the
    // wire); a binary that ignored --output-format keeps its verbatim,
    // bullet unwrapped text and records no usage (kimiPlainResult's
    // hatch). When the launch streamed, result.stdout is already the
    // folded subset and the unwrap below parses it unchanged.
    if (result.captureLimitExceeded) {
      // The 125 said only that a line passed 16 MiB; the fold held the
      // offender's first bytes as it latched, so the failure names the
      // line instead of leaving the run's killer nameless (lane C30,
      // item 2). Controls escape so a hostile line cannot repaint the
      // terminal from the failure message itself.
      const overflow = foldOverflowEvidence(context?.stdoutSink);
      if (overflow !== null) {
        const length = overflow.final
          ? `${overflow.bytes} bytes`
          : `at least ${overflow.bytes} streamed bytes`;
        result = {
          ...result,
          stderr: appendDiagnostic(
            result.stderr,
            `kimi: the line that passed the capture limit is ${length} long and starts with ` +
              `(first 512 bytes, controls escaped): ${JSON.stringify(escapeForTerminal(overflow.prefix))}`
          ),
        };
      }
    }
    if (request.hermetic && !context?.kimiHermeticHome) {
      throw new Error("kimi hermetic home was not prepared before reading results");
    }
    let model = request.model;
    try { model = this.modelFor(model); } catch { /* validateRunRequest already refused it */ }
    const brandHome = kimiResultBrandHome(this.environment, request.passthroughEnv, this.homeDirectory, context?.kimiHermeticHome?.kimiHome, false);
    const majorVersion = context?.harnessVersion
      ? parseVersionParts(context.harnessVersion)?.[0]
      : undefined;
    return kimiPlainResult(result, { ...request, model }, brandHome, context, majorVersion);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
    if (request.hermetic) {
      if (request.passthroughEnv?.includes("KIMI_CODE_HOME")) {
        throw new UsageRefusalError("kimi --hermetic owns KIMI_CODE_HOME; remove --pass-env KIMI_CODE_HOME");
      }
      // Project-settings mode flips exactly this refusal: the
      // repository's own channels (kimi-project-settings.ts) load inside
      // the hermetic boundary, and prepareRun's gate has already judged
      // the request against that mode's rules.
      if (request.experimentProjectSettings !== true) assertNoKimiHermeticProjectConfig(cwd);
    } else assertNoKimiProjectExecutionConfig(cwd);
    // The refusal class is usage (exit 64, UsageRefusalError), the aider
    // rule the session driver already applies before its ack (round al11).
    // What is refused narrowed in al17 to what kimi's headless path
    // actually dispatches: 0.31.1 parses only goal-creates before the
    // model turn, so every other `/`-leading prompt (a path like
    // /tmp/notes.md first among them) reaches the model unchanged, and
    // the refusals are the word-bounded `/goal` name and the `!`
    // shell-escape shape (kimiPromptIsCommand states the full rule).
    // Round al18 corrected the message to the per-shape truth: only /goal
    // CREATES dispatch, while the other /goal subcommands fall through to
    // the model as prompt text — the whole name is refused as codemux's
    // own policy, not as a claim that kimi would run every spelling.
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
    // (round al21). Round al29 widened the check to EVERY run that passes
    // the variable through: the child reads its config, skills and store
    // from that directory whatever the run kind, so the
    // empty/relative/missing refusals cannot depend on --tools none being
    // the one kind codemux itself writes under it — and the refusals are
    // UsageRefusalErrors (exit 64, zero drift between the two paths). The
    // default home (no passthrough) stays exempt.
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

  /** The kimi login read: the credential file's expiry and refresh token. */
  override loginState(): LoginState {
    return kimiLoginState(loginHome(this.environment), this.environment);
  }
}
