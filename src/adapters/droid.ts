import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoDroidProjectExecutionConfig } from "../project-safety.js";
import { assertCleanInstructionFiles } from "../clean-cwd.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import {
  writeDroidProviderSettings,
  writeDroidTuiSettings,
  droidProviderModelId,
  DROID_PROVIDER_KEY_ENV,
} from "../droid-provider.js";
import {
  createDroidHermeticHome,
  DROID_HERMETIC_ENV_ASSIGNMENTS,
  DROID_HERMETIC_ENV_OMISSIONS,
} from "../droid-hermetic.js";
import {
  assertProviderCap,
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import { droidPlainResult, droidResult, droidStreamFold } from "../result-envelope/droid.js";
import { answerFoldScanEvidence } from "../answer-stream-fold.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { envKeyLoginState, type LoginState } from "../harness-health.js";

// `--tools none`: droid's tool controls are `--only-tools`/`--add-tools`/
// `--remove-tools` with validated IDs ("Use only tool IDs or
// MCP:<server>[/<tool>] selectors", droid 0.186.0 `exec --help`; the flags
// are unchanged in the installed 0.221.0). An empty `--only-tools ""` is
// silently ignored -- every tool stays on -- and `--remove-tools` would
// have to name every ID, which varies with the model and the operator's
// MCP servers, so both fail open. `--only-tools ToolSearch` instead
// allowlists the one tool droid itself pins (a `--remove-tools` naming
// every other ID still leaves ToolSearch allowed): an unknown ID aborts
// the launch ("Unknown tool identifier(s)"), so a renamed tool fails
// closed, and the installed binary's free `--list-tools` inventory shows
// every Read, Edit, Execute and MCP tool blocked under it.
const DROID_NO_TOOLS_ONLY_TOOL = "ToolSearch";

/**
 * Factory's Droid CLI (`droid`), audited against 0.186.0.
 *
 * A provider override rides droid's BYOK settings: one `customModels` entry
 * in a per-run settings file passed as the root-level `--settings <path>`
 * ("merged for this process only"), with the key referenced as
 * `${CODEMUX_DROID_PROVIDER_API_KEY}` and delivered through the environment
 * codemux provides (see src/droid-provider.ts for the grounding). The
 * override needs no Factory login: the entry's own key authenticates every
 * request, which is what made the capability probe possible on a machine
 * whose stored login droid's self-update had removed.
 */
export class DroidAdapter extends BaseAdapter {
  readonly id: AgentId = "droid";
  readonly binaryName = "droid";

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
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Every root droid reads — settings.json, skills, hooks, the login
      // file, and the guideline directories .factory, .factory-dev,
      // .agents, .agent and .claude — resolves from one root:
      // FACTORY_HOME_OVERRIDE ?? HOME ?? USERPROFILE ?? cwd (droid 0.221.0
      // binary string, read 2026-11-09). A private HOME with the override
      // unset therefore removes them all at once (src/droid-hermetic.ts).
      supportsHermetic: true,
      // Verified live on 2026-09-17 through a provider override (GLM-5.3
      // via Z.AI): under --tools none neither the read nor the shell probe
      // could produce its secret, while a plain run produced both
      // (docs/isolation.md).
      supportsToolSelection: true,
      supportsProviderOverride: true,
      // `exec -o json` prints exactly one result object on stdout
      // (src/result-envelope/droid.ts).
      supportsResultJson: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // Read-only builds no flag because the default state IS read-only:
    // "DEFAULT (no flags)  Read-only mode - The safest mode for reviewing
    // planned changes without execution" and "By default, it runs in
    // read-only mode, requiring explicit flags to enable modifications"
    // (droid 0.221.0 binary strings, read 2026-11-08). --auto
    // low/medium/high carry the other levels natively.
    switch (level) {
      case "read-only":
        return [];
      case "low":
        return ["--auto", "low"];
      case "medium":
        return ["--auto", "medium"];
      case "high":
        return ["--auto", "high"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return [
      "--reasoning-effort",
      level === "none" ? "off" : level,
    ];
  }

  private mapEffortForModel(
    level: ReasoningEffort,
    model?: string
  ): string[] {
    // The bare `gpt-5.6` id is the family too (review round 361): the
    // suffixed check alone made an unsuffixed id fall to the generic `off`.
    if (level === "none" && (model === "gpt-5.6" || model?.startsWith("gpt-5.6-"))) {
      return ["--reasoning-effort", "none"];
    }
    return this.mapEffort(level);
  }

  /**
   * The provider override, validated: droid's BYOK entry needs a base URL
   * and a key (the model may come from `--model` instead of the variable).
   * The output cap rides the entry's maxOutputTokens; the context cap is
   * refused — the BYOK surface has no context-window field.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("droid", this.environment);
    if (override === null) return null;
    assertProviderCap(
      "droid",
      override,
      "maxContextTokens",
      "droid's BYOK customModels entries carry no context-window field " +
        "(docs.factory.ai model-independence/byok documents model, baseUrl, " +
        "apiKey and maxOutputTokens only), so a context cap cannot ride the override"
    );
    return requireProviderOverride("droid", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model id the BYOK entry routes: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "droid needs a model for the provider override; pass --model or set CODEMUX_DROID_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /**
   * The brand home whose `.codemux/` holds the per-run settings file: the
   * one a plain run reads settings.json, skills and hooks from. Droid
   * resolves that root from FACTORY_HOME_OVERRIDE, else HOME, else
   * USERPROFILE, else the cwd (0.221.0, the hermetic evidence), so this is
   * the REAL home's root: a hermetic run redirects the child's HOME on the
   * command line instead, and its `--settings` path stays absolute under
   * this root so an override composes with hermetic.
   */
  private realBrandHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Droid home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return join(home && isAbsolute(home) ? home : homedir(), ".factory");
  }

  override prepareRun(request: RunRequest): RunContext {
    // The hermetic home first, so a settings-file failure after it leaves
    // nothing private behind (cleanupRun finalizes what this returned).
    const context: RunContext = { stdoutSink: droidStreamFold() };
    if (request.hermetic) {
      context.droidHermeticHome = createDroidHermeticHome(this.realBrandHome());
    }
    // One settings file per run with an override, never shared and never
    // recorded on the adapter: the launcher owns the returned context and
    // finalizes the file in cleanupRun when this launch ends.
    const override = this.validatedProvider();
    if (override !== null) {
      const model = this.modelFor(request.model);
      if (model !== undefined) {
        context.droidProviderSettings = writeDroidProviderSettings(
          this.realBrandHome(),
          override,
          model
        );
      }
    }
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    context?.droidProviderSettings?.finalize();
    context?.droidHermeticHome?.finalize();
  }

  override getRunEnv(
    _request: RunRequest,
    context?: RunContext
  ): Record<string, string> {
    const override = this.validatedProvider();
    if (override === null) return {};
    if (context?.droidProviderSettings === undefined) {
      throw new Error("droid provider settings were not prepared before launch");
    }
    // The key rides the environment codemux provides; the settings file
    // holds only its name.
    return { [DROID_PROVIDER_KEY_ENV]: override.apiKey };
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    // A hermetic run redirects the child's home resolution on the command
    // line: FACTORY_HOME_OVERRIDE unset (an exported value would outrank
    // HOME), HOME pointed at the private home, self-update off. Scode must
    // keep the real HOME for policy and credential access, so only the
    // child is redirected (the kimi rule). A static preview (`verify`) has
    // no prepared home; the placeholder does not exist, and the child
    // fails its own login check there, so a command built without
    // prepareRun fails closed.
    const privateHome = context?.droidHermeticHome;
    const unpreparedHome = join(this.realBrandHome(), ".codemux-hermetic", "unprepared");
    const cmd: string[] = request.hermetic
      ? [
        "env",
        ...DROID_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
        ...DROID_HERMETIC_ENV_ASSIGNMENTS,
        `HOME=${privateHome?.home ?? unpreparedHome}`,
        "droid",
      ]
      : ["droid"];

    // With an override the per-run settings file supplies the BYOK entry
    // and the session's default model. `--settings` is a root-level flag,
    // so it precedes the subcommand. A static preview (`verify`) has no
    // prepared file; the placeholder path does not exist, and droid fails
    // to read it, so a command built without prepareRun fails closed.
    if (this.validatedProvider() !== null) {
      const model = this.modelFor(request.model)!;
      const unprepared = join(this.realBrandHome(), ".codemux", "unprepared", "settings.json");
      cmd.push("--settings", context?.droidProviderSettings?.path ?? unprepared);
      cmd.push("exec");
      // The entry's id, not its API model name: droid resolves `-m` by id.
      cmd.push("-m", droidProviderModelId(model));
    } else {
      cmd.push("exec");
      if (request.model) {
        cmd.push("-m", request.model);
      }
    }

    // Every run launches on the stream-json wire (lane AN1): text and
    // json print only the last assistant text block, so a reply written
    // before a tool call was lost. The adapter assembles every assistant
    // message (src/result-envelope/droid.ts); plain runs print it at the end.
    cmd.push("--output-format", "stream-json");

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      // The value must match the model the SESSION runs, which with an
      // override is the resolved one (request.model ?? the override's), not
      // the raw request: a gpt-5.6 override model with --effort none needs
      // that family's `none`, while `request.model` alone would look unset
      // and emit the generic `off`.
      cmd.push(...this.mapEffortForModel(request.effort, this.modelFor(request.model)));
    }

    if (request.tools === "none") {
      cmd.push("--only-tools", DROID_NO_TOOLS_ONLY_TOOL);
    }

    if (request.web === false) {
      // The web tools are first-class tool IDs — `WebSearch` ("Web
      // Search") and `FetchUrl` ("Web Fetch") — and `--remove-tools`
      // takes "a comma or space separated list" validated against the
      // ID table ("Unknown tool identifier(s)" aborts before any run;
      // droid 0.221.0 binary strings, read 2026-11-09), so `--no-web`
      // removes exactly the two and a renamed ID fails closed.
      cmd.push("--remove-tools", "WebSearch,FetchUrl");
    }

    return cmd;
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    // The stream fold shed tool payloads; their canary matches still reach
    // the leak scan (src/answer-stream-fold.ts).
    const scanSurface = `${result.stdout}\n${answerFoldScanEvidence(context?.stdoutSink)}`;
    return { ...(request.resultJson ? droidResult(result, request) : droidPlainResult(result)), scanSurface };
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    if (request.hermetic && request.passthroughEnv?.includes("FACTORY_HOME_OVERRIDE")) {
      // The child's argv unsets FACTORY_HOME_OVERRIDE (it outranks the
      // private HOME), so an operator pass-through would silently fight
      // the containment the run promised.
      throw new UsageRefusalError(
        "droid --hermetic redirects the home itself; remove --pass-env FACTORY_HOME_OVERRIDE"
      );
    }
    if (request.hermetic) {
      // The private HOME closes every personal channel, but droid still
      // loads project guidelines from the working directory and its
      // ancestors: the file names `["CLAUDE.md","Claude.md","AGENTS.md",
      // "Agents.md","agents.md"]` and the directories `[".factory",
      // ".factory-dev",".agents",".agent"]` (droid 0.221.0 bundle, read
      // 2026-11-09), with no flag that skips them. So a hermetic run needs
      // a clean directory owned by this run, as gemini and goose do.
      if (request.cwd === undefined) {
        throw new UsageRefusalError("droid --hermetic requires an explicit --cwd owned by this run");
      }
      assertCleanInstructionFiles("droid", validateWorkingDirectory(request.cwd)!, [
        "CLAUDE.md", "Claude.md", "AGENTS.md", "Agents.md", "agents.md",
        ".factory", ".factory-dev", ".agents", ".agent",
      ]);
    }
    // Fail before launch on a half-configured override, surface the model
    // requirement early (the operator's own login and default model would
    // otherwise silently answer), and refuse a model the settings file
    // cannot carry verbatim: droid expands ${VAR} templates inside it
    // (droid-provider.ts).
    const resolved = this.modelFor(request.model);
    if (resolved !== undefined && this.validatedProvider() !== null) {
      droidProviderModelId(resolved);
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
    assertNoDroidProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // An override, a model, or an effort all ride the same settings file
    // buildTuiCommand writes (the run path's root `--settings` carrier),
    // so a half-configured override and a brace-carrying model surface
    // here, before any file is written.
    const override = this.validatedProvider();
    const resolved = this.modelFor(model);
    if (resolved !== undefined && override !== null) {
      droidProviderModelId(resolved);
    }
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    // The TUI selects model and effort through the settings schema's
    // sessionDefaultSettings (src/droid-provider.ts), so an interactive
    // session that asked for either — or runs under an override, whose
    // BYOK entry must ride the file too — gets one per-launch settings
    // file named by the root-level `--settings` flag. The write happens
    // here, not in prepareTuiEnvironment, because the plain interactive
    // path builds its argv before it prepares the environment
    // (src/adapters/interactive.ts); the file's exit hook removes it.
    const override = this.validatedProvider();
    const resolved = this.modelFor(model);
    const cmd: string[] = ["droid"];
    if (override !== null || resolved !== undefined || effort !== undefined) {
      const settings = writeDroidTuiSettings(this.realBrandHome(), {
        model: override !== null ? resolved : undefined,
        defaultModel:
          override !== null && resolved !== undefined
            ? droidProviderModelId(resolved)
            : resolved,
        effort,
        override,
      });
      cmd.push("--settings", settings.path);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  override getTuiEnv(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort
  ): Record<string, string> {
    // The settings file's ${CODEMUX_DROID_PROVIDER_API_KEY} reference
    // expands from the child environment, exactly as on the run path.
    const override = this.validatedProvider();
    if (override === null) return {};
    return { [DROID_PROVIDER_KEY_ENV]: override.apiKey };
  }

  override supportsTuiModel(): boolean {
    return true;
  }

  override supportsTuiEffort(): boolean {
    return true;
  }

  /** The droid login read: a credential variable in the environment. */
  override loginState(): LoginState {
    return envKeyLoginState(this.id, this.environment);
  }
}
