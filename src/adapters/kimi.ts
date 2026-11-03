import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import { join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoKimiProjectExecutionConfig } from "../project-safety.js";
import { kimiPromptIsCommand } from "../session/kimi-session.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { writeKimiNoToolsFile } from "../kimi-no-tools.js";
import { createKimiHermeticHome, KIMI_HERMETIC_ENV_ASSIGNMENTS, KIMI_HERMETIC_ENV_OMISSIONS } from "../kimi-hermetic.js";
import { assertNoKimiHermeticProjectConfig } from "../kimi-project-safety.js";
import { kimiPlainResult, kimiResult } from "../result-envelope/kimi.js";
import { appendDiagnostic } from "../result-envelope.js";
import { foldOverflowEvidence, foldScanEvidence, KimiPlainFold } from "../plain-unwrap/kimi-fold.js";
import { kimiEffectiveHome, kimiRealBrandHome } from "./kimi-home.js";
import { escapeForTerminal } from "../usage-protocol.js";
import { parseVersionParts } from "../harness-compatibility.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { ExperimentKimiRun } from "../experiment-kimi-run.js";
import type { ExperimentFailure } from "../experiment-records.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import type {
  AgentId,
  AutonomyLevel,
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
      // neither secret, while a plain run produced both (docs/isolation.md).
      supportsToolSelection: true,
      supportsHermetic: true,
      supportsResultJson: true,
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
      throw new UsageRefusalError(
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
    if (request.hermetic) {
      const context: RunContext = {
        kimiHermeticHome: createKimiHermeticHome(this.realBrandHome(), request.tools === "none", printOnly),
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
    try {
      experiment?.preserveHarnessLog();
      context?.kimiHermeticHome?.finalize();
      context?.kimiNoToolsFile?.finalize();
    } catch (error) { experiment?.relay.fail(error); throw error; }
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

  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    if (request.hermetic && context?.kimiHermeticHome === undefined) {
      throw new Error("kimi hermetic home was not prepared before launch");
    }
    return this.providerEnv(request.model);
  }

  override getTuiEnv(model?: string): Record<string, string> {
    return this.providerEnv(model);
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const privateHome = context?.kimiHermeticHome;
    const unpreparedHome = join(this.realBrandHome(), ".codemux-hermetic", "unprepared");
    // Scode must keep the real HOME for policy and credential access. Redirect only its child.
    const cmd = request.hermetic
      ? ["env", ...KIMI_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
        ...KIMI_HERMETIC_ENV_ASSIGNMENTS,
        `HOME=${privateHome?.home ?? unpreparedHome}`,
        `KIMI_CODE_HOME=${privateHome?.kimiHome ?? join(unpreparedHome, ".kimi-code")}`, "kimi"]
      : ["kimi"];

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

    if (request.hermetic) {
      const unprepared = join(this.realBrandHome(), ".codemux-hermetic", "unprepared");
      cmd.push("--skills-dir", context?.kimiHermeticHome?.skillsDir ?? join(unprepared, "skills-dir"),
        "--agent-file", context?.kimiHermeticHome?.agentFile ?? join(unprepared, "agent.md"));
    } else if (request.tools === "none") {
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
    // bounds its length, the same as the other argv-only harnesses. Every run
    // asks for the stream-json wire (0.31.1 prints it; the session driver
    // rests on the same floor), not only --result-json ones: the plain path
    // reads the reply and the wire-log usage off the same stream
    // (kimiPlainResult), so a plain run records tokens like claude, zai, agy,
    // codex, and opencode plain runs do. A plain run never captures that
    // stream whole — prepareRun hangs KimiPlainFold on the context, which
    // drops the tool payloads as they arrive, so tool volume cannot reach
    // the capture bound (the opencode/codex rule).
    cmd.push("--output-format", "stream-json");
    cmd.push("--prompt", request.prompt);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext, failure?: ExperimentFailure): RunResult {
    // The leak scan covers the whole printed output, shed tool payloads included (round 17, contracts-2 1).
    result = { ...result, scanSurface: result.stdout + result.stderr + foldScanEvidence(context?.stdoutSink) };
    if (request.resultJson || request.experimentMcp) {
      if (request.hermetic && !context?.kimiHermeticHome && !failure) {
        throw new Error("kimi hermetic home was not prepared before reading results");
      }
      let model = request.model;
      try { model = this.modelFor(model); } catch (error) { if (!failure) throw error; }
      const brandHome = context?.kimiHermeticHome?.kimiHome ?? (failure
        ? join(this.effectiveHome(), ".kimi-code") : this.realBrandHome(request.passthroughEnv));
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
    // do, while stdout keeps the plain contract (the reply, never the wire);
    // a binary that ignored --output-format keeps its verbatim, bullet
    // unwrapped text and records no usage (kimiPlainResult's hatch). When
    // the launch streamed (the context's KimiPlainFold), result.stdout is
    // already the folded subset — the hatch's raw bytes or the kept wire
    // lines — and the unwrap below parses it unchanged.
    if (result.captureLimitExceeded) {
      // The 125 said only that a line passed 16 MiB; the fold held the
      // offender's first bytes as it latched, so the failure names the
      // line instead of leaving the run's killer nameless (lane C30,
      // item 2). Controls escape with the helper the other stderr-bearing
      // paths use, so a hostile line cannot repaint the terminal from the
      // failure message itself.
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
    const brandHome = context?.kimiHermeticHome?.kimiHome ?? this.realBrandHome(request.passthroughEnv);
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
      assertNoKimiHermeticProjectConfig(cwd);
    } else assertNoKimiProjectExecutionConfig(cwd);
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

  /** The kimi login read: the credential file's expiry and refresh token. */
  override loginState(): LoginState {
    return kimiLoginState(loginHome(this.environment), this.environment);
  }
}
