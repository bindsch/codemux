import { join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { createOpencodeHermeticHome } from "../opencode-hermetic.js";
import { opencodeRemoteConfigCarrier } from "../opencode-remote-config.js";
import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_KEY_ENV,
  opencodeBareModel,
  opencodeLimit,
  writeOpencodeProviderConfig,
} from "../opencode-provider.js";
import { assertNoOpenCodeProjectExecutionConfig } from "../project-safety.js";
import { assertNoAncestorOpenCodeProjectConfig } from "../opencode-project-settings.js";
import { validateProjectSettingsRunRequest } from "../claude-project-settings.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";
import { OpenCodePlainFold, openCodeResultData, opencodePlainResult } from "../plain-unwrap.js";
import { opencodeResult } from "../result-envelope/opencode.js";
import {
  hermeticRemoteConfigRefusal,
  OPENCODE_HERMETIC_ENV,
  OPENCODE_NO_TOOLS_PERMISSION,
  PLAIN_NO_TOOLS_REFUSAL,
} from "./opencode-env.js";
import { assertAbsoluteOpencodeXdgHome, opencodeRealDataDir, opencodeRealDataParent, opencodeRealStateDir } from "./opencode-home.js";
import { fileStoreLoginState, type LoginState } from "../harness-health.js";

export { opencodeRealDataParent, opencodeRealDataDir } from "./opencode-home.js";

export class OpencodeAdapter extends BaseAdapter {
  readonly id: AgentId = "opencode";
  readonly binaryName = "opencode";

  // Seams so tests can point the real data directory at a scratch directory.
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
      effortLevels: ["low", "medium", "high"],
      // Verified live on 2026-09-17 through a provider override (GLM-5.3
      // via Z.AI): the two-probe check passed with and without --tools
      // none, and the read and shell probes fail under --tools none
      // (docs/isolation.md). The h2 review scoped --tools none to hermetic
      // runs: a plain run's operator config can override the deny per
      // agent (see OPENCODE_NO_TOOLS_PERMISSION above). The h3 review
      // added the matching login-side refusal: a login carrying remote
      // configuration (a well-known login, an active organization) breaks
      // both guarantees on hermetic runs too, so the run refuses while one
      // exists (opencode-remote-config.ts). The h7 review adds the
      // check-level consequence: `check --hermetic --tools none` refuses
      // for this harness, because its control probe would be a plain
      // --tools none run.
      supportsHermetic: true,
      supportsToolSelection: true,
      toolsNoneRequiresHermetic: true,
      // The wire --format json asks for is the same one every plain run
      // folds, so the envelope (result-envelope/opencode.ts) is built over
      // that fold's finished outcome: reply and step_finish usage, never
      // the raw event lines (dropped as they arrive to stay under the
      // capture bound).
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--agent", "plan"];
      case "low":
        return ["--agent", "build"];
      case "medium":
        return ["--agent", "build"];
      case "high":
        return ["--agent", "build", "--auto"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--variant", level];
  }

  override supportsTuiEffort(): boolean {
    return false;
  }

  /**
   * The real OpenCode data directory holding the login state the
   * remote-config inspection reads (opencode-remote-config.ts).
   */
  private realDataDir(): string {
    return opencodeRealDataDir(this.environment, this.homeDirectory);
  }

  /**
   * The remote-config carriers in the real login state, or null when the
   * login carries none. Read fresh on every call: the store can change
   * between validation and launch, and a hermetic run must refuse the
   * moment one appears (see hermeticRemoteConfigRefusal).
   */
  private remoteConfigCarrier(): string | null {
    return opencodeRemoteConfigCarrier(this.realDataDir());
  }

  /**
   * The provider override, validated: OpenCode reaches a custom provider only
   * through a config layer (there are no provider environment variables), so
   * the override needs a base URL and a key, delivered through a file codemux
   * writes and an environment name it provides (opencode-provider.ts).
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("opencode", this.environment);
    if (override === null) return null;
    return requireProviderOverride("opencode", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The bare model id: the request's, else the override's. */
  private rawModelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "opencode needs a model for the provider override; pass --model or set CODEMUX_OPENCODE_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  /** The `--model` value: with an override, the config's provider id routes to it. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = this.rawModelFor(model);
    if (resolved === undefined || override === null) return resolved;
    return resolved.startsWith(`${OPENCODE_PROVIDER_ID}/`)
      ? resolved
      : `${OPENCODE_PROVIDER_ID}/${resolved}`;
  }

  /** The wire `--model` value for a launch the caller builds itself (the
   * session driver's per-turn spawns): exactly what buildRunCommand would
   * pass, so the session turns and the run path cannot drift. */
  wireModelFor(model: string | undefined): string | undefined {
    return this.modelFor(model);
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];

    // A project-settings run without --hermetic would be a plain run with
    // the project's config loaded and none of the isolation — the env
    // prefix below IS the isolation. The CLI refuses it earlier with the
    // same words; this fails every other builder closed.
    if (request.experimentProjectSettings && !request.hermetic) {
      throw new UsageRefusalError("--experiment-project-settings requires --hermetic");
    }

    const envPrefix: string[] = [];
    if (request.hermetic) {
      // The remote-config refusal, ahead of everything else a hermetic run
      // builds: no env prefix removes the login's own configuration, so a
      // carrier breaks both guarantees and every builder — the CLI through
      // validateRunRequest, `verify` through this — fails closed.
      const carrier = this.remoteConfigCarrier();
      if (carrier !== null) {
        throw new UsageRefusalError(hermeticRemoteConfigRefusal(carrier));
      }
      // The project-settings ancestor refusal: dropping
      // OPENCODE_DISABLE_PROJECT_CONFIG reopens every ancestor the walk can
      // reach, so the run is refused before it is built, on this path and
      // validateRunRequest's alike.
      if (request.experimentProjectSettings) {
        assertNoAncestorOpenCodeProjectConfig(request.cwd ?? process.cwd());
      }
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and getRunEnv refuses a launch without one, so
      // a command built without prepareRun fails closed. The same holds for
      // the provider config's path.
      const unprepared = join(this.realDataDir(), ".codemux-hermetic", "unprepared");
      const home = context?.opencodeHermeticHome?.home ?? unprepared;
      envPrefix.push(
        ...OPENCODE_HERMETIC_ENV(
          home,
          // The XDG data parent a plain run sees (opencode-home.ts):
          // XDG_DATA_HOME passes through the sanitized child environment,
          // so an operator who relocated it keeps their login.
          opencodeRealDataParent(this.environment, this.homeDirectory),
          context?.opencodeProviderConfig?.path ?? null,
          request.experimentProjectSettings === true
        )
      );
    }
    if (request.tools === "none") {
      // Hermetic only: on a plain run the operator's config can override
      // the deny per agent (OPENCODE_NO_TOOLS_PERMISSION above), so the
      // capability refuses there instead of launching a run whose deny
      // silently does not hold. validateRunRequest answers the CLI path;
      // this fails every other builder closed.
      if (!request.hermetic) {
        throw new UsageRefusalError(PLAIN_NO_TOOLS_REFUSAL);
      }
      envPrefix.push(OPENCODE_NO_TOOLS_PERMISSION);
    }
    if (envPrefix.length > 0) {
      cmd.push("env", ...envPrefix);
    }
    // `--pure` sets OPENCODE_PURE, which drops every external plugin at the
    // plugin layer (plugin/index.ts reads the flag; the CLI middleware in
    // index.ts sets it). A project-settings run goes without it, so the
    // project's own plugins run — that is the channel under observation.
    cmd.push("opencode");
    if (!request.experimentProjectSettings) cmd.push("--pure");
    cmd.push("run");
    // Always the JSON event lines, plain runs included (the same wire the
    // session driver's per-turn spawns read): the launcher streams them
    // through the fold on the run context instead of capturing stdout
    // whole, and processRunResult reads the reply and usage back off that
    // fold — so stdout keeps its contract and the call ledger gets the
    // step_finish usage without tool output ever filling the capture
    // bound (review ul4).
    cmd.push("--format", "json");

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

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(
    result: RunResult,
    request: RunRequest,
    context?: RunContext
  ): RunResult {
    // The run was launched with --format json, so stdout is the event-line
    // wire — streamed through the fold prepareRun hung on the context, so
    // tool output never fills the capture bound (review ul4). Anything the
    // fold saw that was not the wire passed through verbatim with the run
    // unchanged (plain-unwrap.ts's escape hatch). Callers that reach here
    // without the context's sink (a result already captured whole) get the
    // same fold and verdict from the captured stdout. A --result-json run
    // reads the same fold's outcome and wraps it in the envelope.
    const sink = context?.stdoutSink;
    if (request.resultJson) {
      const data = sink instanceof OpenCodePlainFold
        ? sink.resultData()
        : openCodeResultData(result.stdout);
      return opencodeResult(
        result,
        request,
        data,
        context?.opencodeSelectedModel ?? request.model ?? null
      );
    }
    if (sink instanceof OpenCodePlainFold) return sink.verdict(result);
    return opencodePlainResult(result);
  }

  override prepareRun(request: RunRequest): RunContext {
    // The launch-path project-settings gate, from the request's own
    // fields (review round 2, edges 1): the CLI's early check — and the
    // two rules validateRunRequest surfaces early — are duplicates, so
    // a programmatic caller cannot reach the config state — or the
    // spawn — without the sandbox and an observing autonomy level.
    if (request.experimentProjectSettings) {
      validateProjectSettingsRunRequest(request);
    }
    // The provider config rides every run with an override, hermetic or
    // not: one file per run, never shared, finalized in cleanupRun. Hermetic
    // runs also get their private home. Nothing is recorded on the adapter;
    // the launcher owns the returned context, so two launches through this
    // singleton each carry their own artifacts.
    const context: RunContext = {};
    const override = this.validatedProvider();
    if (override !== null) {
      const model = this.rawModelFor(request.model);
      if (model !== undefined) {
        context.opencodeProviderConfig = writeOpencodeProviderConfig(
          this.realDataDir(),
          override,
          model
        );
      }
    }
    // The envelope's model contract: record what this launch runs with —
    // the request's model, else the override's selection.
    context.opencodeSelectedModel = this.rawModelFor(request.model);
    if (request.hermetic) {
      try {
        context.opencodeHermeticHome = createOpencodeHermeticHome(
          this.realDataDir(),
          opencodeRealStateDir(this.environment, this.homeDirectory)
        );
      } catch (error) {
        // The provider configuration above is already on disk; a context
        // that never reaches the launcher would strand it (review round 39).
        this.cleanupRunSync(context);
        throw error;
      }
    }
    // The JSON event stream carries every tool's output, so the launcher
    // feeds it to this fold instead of capturing stdout whole: the fold
    // keeps the reply text, the folded step_finish usage, and the break
    // notes — tool parts dropped as they arrive — so no volume of tool
    // output can reach the 16 MiB capture bound (review ul4).
    context.stdoutSink = new OpenCodePlainFold();
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    // The launcher calls this exactly once per context it created, after a
    // finished run and after a rejected one alike; each artifact dies with
    // its own launch only. Both finalizers run even when the first throws
    // (review round 87): a hermetic home that cannot be removed must not
    // strand the provider config too. One failure rethrows as itself;
    // several combine into one AggregateError naming each (kimi's
    // cleanupHome follows the same rule).
    const failures: unknown[] = [];
    for (const artifact of [context?.opencodeHermeticHome, context?.opencodeProviderConfig]) {
      if (artifact === undefined) continue;
      try { artifact.finalize(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const messages = failures.map((f) => f instanceof Error ? f.message : String(f));
      throw new AggregateError(failures, `codemux: opencode cleanup failed ${failures.length} times: ${messages.join("; ")}`);
    }
  }

  override getRunEnv(
    request: RunRequest,
    context?: RunContext
  ): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // OpenCode's side only in effect, so this is the codemux-side guarantee.
    if (request.hermetic && context?.opencodeHermeticHome === undefined) {
      throw new Error("opencode hermetic home was not prepared before launch");
    }
    const override = this.validatedProvider();
    if (override === null) return {};
    const config = context?.opencodeProviderConfig;
    if (config === undefined) {
      throw new Error("opencode provider config was not prepared before launch");
    }
    // The key rides the environment codemux provides, never argv and never a
    // file. OPENCODE_CONFIG reaches a hermetic run through the env prefix
    // (an env(1) assignment would clobber it here); a plain run has no
    // prefix, so it rides along.
    if (request.hermetic) {
      return { [OPENCODE_PROVIDER_KEY_ENV]: override.apiKey };
    }
    return {
      [OPENCODE_PROVIDER_KEY_ENV]: override.apiKey,
      OPENCODE_CONFIG: config.path,
    };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // The inherited XDG directories are refused while still relative,
    // before any walk or spawn: OpenCode resolves them against the run's
    // working directory, past every check below (review round 286).
    assertAbsoluteOpencodeXdgHome(this.environment);
    // The project-settings gates, surfaced early with their reasons (the
    // build path fails closed on the same two rules).
    if (request.experimentProjectSettings) {
      if (!request.hermetic) {
        throw new UsageRefusalError("--experiment-project-settings requires --hermetic");
      }
      assertNoAncestorOpenCodeProjectConfig(request.cwd ?? process.cwd());
    }
    // The working directory's own opencode.json/.opencode are the point of
    // --experiment-project-settings, so that mode exempts the working
    // directory itself; every ancestor this walk reaches is still refused.
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd(),
      request.experimentProjectSettings === true
    );
    // The plain-run --tools none refusal, surfaced early with its reason
    // (see OPENCODE_NO_TOOLS_PERMISSION for the channel that cannot be
    // closed). A usage refusal (exit 64), like every pre-launch refusal
    // of the request (review round 5, contracts-2 finding 2).
    if (request.tools === "none" && !request.hermetic) {
      throw new UsageRefusalError(PLAIN_NO_TOOLS_REFUSAL);
    }
    // The hermetic remote-config refusal, surfaced with its reason too:
    // the login's own configuration channel (opencode-remote-config.ts).
    if (request.hermetic) {
      const carrier = this.remoteConfigCarrier();
      if (carrier !== null) {
        throw new UsageRefusalError(hermeticRemoteConfigRefusal(carrier));
      }
    }
    // Fail before launch on a half-configured override, surface the model
    // requirement early (the operator's own login and default model would
    // otherwise silently answer), and refuse a model the config file
    // cannot carry verbatim: OpenCode substitutes {env:…}/{file:…} in
    // config text (opencode-provider.ts). A one-sided token cap is refused
    // here for the same reason it is refused at the write: the schema's
    // limit object takes the pair, not a half.
    const resolved = this.modelFor(request.model);
    const override = this.validatedProvider();
    if (resolved !== undefined && override !== null) {
      opencodeBareModel(resolved);
      opencodeLimit(override);
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
    // The inherited XDG directories, the run boundary's rule (review
    // round 286): a relative value resolves beneath the session's working
    // directory inside OpenCode, past the walk below.
    assertAbsoluteOpencodeXdgHome(this.environment);
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // The provider config's lifecycle rides prepareRun, which only the
    // headless launch path calls; an interactive session has no hook to
    // write and remove the file.
    if (this.validatedProvider() !== null) {
      throw new UsageRefusalError(
        "the opencode provider override supports headless runs only; unset CODEMUX_OPENCODE_PROVIDER_* for an interactive session"
      );
    }
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["opencode", "--pure"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  /** The opencode login read: auth.json in the real data directory. */
  override loginState(): LoginState {
    return fileStoreLoginState(join(this.realDataDir(), "auth.json"), "the opencode data directory's auth.json");
  }
}
