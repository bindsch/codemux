import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoCodexSystemMcp, CODEX_EXPERIMENT_PROVIDER_ID } from "../experiment-codex-config.js";
import { codexExperimentModel, type CodexExperimentModel } from "../experiment-codex-model.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../experiment-records.js";
import {
  assertNoCodexStoreKnob,
  CODEX_MULTI_AGENT_ENV,
  CODEX_PROVIDER_ID,
  CODEX_PROVIDER_KEY_ENV,
  readCodexMultiAgent,
  writeCodexProviderConfig,
} from "../codex-provider.js";
import {
  assertProviderCap,
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import {
  assertNoCodexProjectExecutionConfig,
  assertNoCodexProjectSkills,
} from "../project-safety.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { codexNoToolsCatalogBody, needsCodexNoToolsCatalog } from "../codex-no-tools.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export abstract class CodexPolicy extends BaseAdapter {
  readonly id: AgentId = "codex";
  readonly binaryName = "codex";

  // Seams so tests can point the real CODEX_HOME at a scratch directory.
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
      // rust-v0.166.0 protocol/openai_models.rs:61-80,137-151 maps None
      // to "none"; app-server TurnStartParams uses the same enum.
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      supportsHermetic: true,
      supportsToolSelection: true,
      // Writable autonomy uses a sanitized native model_catalog_json file.
      toolsNoneRequiresReadOnly: false,
      // `codex exec --json` prints its events as JSONL, which processRunResult
      // reduces to the result envelope.
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // The sandbox flag is shared state between the root and exec parsers, so
    // it lands wherever it is placed (cli/src/main.rs copies SharedCliOptions
    // into the exec CLI, and the exec parser accepts it after `exec` too, for
    // fresh runs and `exec resume` alike). The approval policy is not:
    // `-a` before `exec` is parsed by the root and then dropped -- the exec
    // handoff copies only SharedCliOptions -- `exec` has no `-a` of its own,
    // and at 0.159.x `-a` accepts only on-request and never anyway (so the
    // old `-a untrusted` was an invalid value). The config override is the
    // one channel that reaches every mode (exec, exec resume, and the TUI),
    // which is also how mapEffort already passes effort.
    switch (level) {
      case "read-only":
        return ["-s", "read-only", "-c", 'approval_policy="never"'];
      case "low":
        return ["-s", "workspace-write", "-c", 'approval_policy="untrusted"'];
      case "medium":
        return ["-s", "workspace-write", "-c", 'approval_policy="never"'];
      case "high":
        return ["-s", "danger-full-access", "-c", 'approval_policy="never"'];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["-c", `model_reasoning_effort="${level}"`];
  }

  /**
   * The real CODEX_HOME whose login a hermetic run may use: the same one a
   * plain run of this request sees. The sanitized child environment drops
   * CODEX_HOME unless the operator passes it through with --pass-env, in
   * which case both kinds of run use that profile. The check and the return
   * read the value exactly as the child receives it: codex does not trim
   * CODEX_HOME, so a padded value is relative at launch and validating a
   * trimmed copy would wave it through (the round10 CLAUDE_CONFIG_DIR
   * finding's rule, applied to this sibling boundary). An absolute value
   * with surrounding whitespace is refused too: codex keeps the padding, so
   * the harness state would land in a directory whose name still carries it
   * (the round13 doc-drift finding -- the checks now match what the docs
   * already promised). An empty value is refused rather than treated as
   * unset (review round 381, kimi's rule): the child still receives the
   * empty value while codemux falls back to the default home, so the run's
   * directories and the harness state would disagree.
   */
  protected realCodexHome(request: RunRequest): string {
    const passedThrough = request.passthroughEnv?.includes("CODEX_HOME") ?? false;
    const configured = this.environment.CODEX_HOME;
    if (passedThrough && configured === "") {
      throw new UsageRefusalError(
        "CODEX_HOME must not be empty when passed through; the child still " +
          "receives the empty value while codemux falls back to the default " +
          "home — unset the variable or give it an absolute path"
      );
    }
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new UsageRefusalError("CODEX_HOME must be an absolute path");
      }
      if (configured.trim() !== configured) {
        throw new UsageRefusalError(
          `CODEX_HOME must not be whitespace-padded when passed through; ` +
            `'${configured}' carries leading or trailing whitespace, and ` +
            "codex reads the variable without trimming, so the harness state " +
            "would live in a directory whose name still carries the padding"
        );
      }
      return configured;
    }
    return join(this.effectiveHome(), ".codex");
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  protected effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Codex home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  /**
   * The provider override, validated: a base URL and a key routed through a
   * private per-run CODEX_HOME (codex-provider.ts), plus the model the
   * endpoint serves. The pinned native schema has no output-token cap,
   * while the context cap rides `model_context_window`
   * in the same config.toml. The multi-agent knob rides that config too, so
   * it is validated here as well: every launch path (validateRunRequest
   * through modelFor, the TUI check, prepareRun's writers) fails loudly on
   * a value that is not on/off or on a knob set without an override.
   */
  protected validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    // Refused before EVERY override check — the multi-agent knob's
    // included (round al21, contracts-2 minor 2: the call sat below
    // assertMultiAgentKnob, so a malformed multi-agent override masked
    // it and the "fires with or without an override" guarantee below did
    // not hold) — so it fires with or without an override, well-formed
    // or not: the knob names a key no supported release has, so even the
    // "on" reading would be a silent no-op on a real override run.
    assertNoCodexStoreKnob(this.environment);
    const override = readProviderOverride("codex", this.environment);
    this.assertMultiAgentKnob(override);
    if (override === null) return null;
    assertProviderCap(
      "codex",
      override,
      "maxOutputTokens",
      "Codex 0.166.0 has no model output cap in its config schema, native " +
        "ModelInfo catalog, or ResponsesApiRequest; context/compaction limits " +
        "and tool-output truncation do not cap generated model tokens"
    );
    return requireProviderOverride("codex", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /**
   * The multi-agent knob (codex-provider.ts) rides the config.toml the
   * override owns, so a knob set without an override fails loudly — exactly
   * like a token cap without one — instead of sitting silently on a plain
   * run's operator config, which codemux never writes. The value check
   * (on/off) happens inside readCodexMultiAgent and fires on every path
   * that reaches this method, override or not.
   */
  private assertMultiAgentKnob(override: ProviderOverride | null): void {
    const setting = readCodexMultiAgent(this.environment);
    if (setting === null || override !== null) return;
    throw new UsageRefusalError(
      `${CODEX_MULTI_AGENT_ENV} is set but no provider override is; the ` +
        "knob rides the override's own config.toml, so also set " +
        "CODEMUX_CODEX_PROVIDER_BASE_URL, CODEMUX_CODEX_PROVIDER_API_KEY " +
        "and CODEMUX_CODEX_PROVIDER_MODEL"
    );
  }

  /**
   * The model an override run uses: the request's, else the override's. With
   * an override one must exist — the config.toml pins `model`, and falling
   * back to Codex's built-in default would hit the operator's endpoint with
   * an OpenAI catalog name it may not serve.
   */
  protected modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new UsageRefusalError(
        "codex needs a model for the provider override; pass --model or set CODEMUX_CODEX_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  protected experimentModel(request: RunRequest): CodexExperimentModel {
    const selection = codexExperimentModel(request.model, this.realCodexHome(request));
    if (selection.catalog && this.validatedProvider() !== null) {
      throw new ExperimentFailure(Code.CodeMode,
        `Codex experiment catalog provider ${CODEX_EXPERIMENT_PROVIDER_ID} cannot run with the ` +
        `provider override ${CODEX_PROVIDER_ID}; unset CODEMUX_CODEX_PROVIDER_* for this experiment`);
    }
    return selection;
  }

  override getEnvOmissions(): readonly string[] {
    // With an override the provider key is the credential, so the operator's
    // own Codex/OpenAI keys stay out of the child environment: a stray
    // CODEX_API_KEY would hand the run a second, operator-funded
    // authentication path codemux never chose. Without one, both keep
    // forwarding as before (ALLOWED_CREDENTIAL_ENV.codex).
    return this.validatedProvider() === null ? [] : ["CODEX_API_KEY", "OPENAI_API_KEY"];
  }

  override getRunEnv(request: RunRequest, context?: RunContext): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // Codex's side, and this is the codemux-side guarantee.
    if (request.hermetic && context?.hermeticHome === undefined) {
      throw new Error("codex hermetic home was not prepared before launch");
    }
    const override = this.validatedProvider();
    if (override === null) return {};
    if (!request.hermetic && context?.codexProviderHome === undefined) {
      throw new Error("codex provider config was not prepared before launch");
    }
    // The key the config.toml's env_key names, delivered through the
    // environment codemux provides: never argv, never an operator file, and
    // immune to the sanitizer because it is adapter-provided.
    return { [CODEX_PROVIDER_KEY_ENV]: override.apiKey };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    if (request.experimentMcp) assertNoCodexSystemMcp();
    // The passed-through CODEX_HOME is checked exactly as the child reads
    // it here (the round10/round13 rule), before prepareRun creates the
    // run's `.codemux-scratch/` directory under it: validation owns the
    // refusal, so a value the run would refuse never touches disk.
    this.realCodexHome(request);
    // Fail before launch on a half-configured override and surface the model
    // requirement early (validatedProvider's output-cap refusal is reached
    // through the same call): the config.toml cannot be written without
    // both, and a run that reached prepareRun would die mid-write.
    if (request.experimentMcp) this.experimentModel(request);
    else this.modelFor(request.model);
    const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
    // The project-settings mode is the one caller that wants exactly the
    // repository inputs these guards refuse: its validator (reached at
    // prepareRun, validateProjectSettingsRunRequest) has already required
    // hermetic isolation and the sandbox, so the guards flip rather than
    // fire (codex-project-settings.ts).
    if (request.experimentProjectSettings !== true) {
      assertNoCodexProjectExecutionConfig(cwd);
      if (request.hermetic) {
        assertNoCodexProjectSkills(cwd, this.effectiveHome());
      }
    }
    if (needsCodexNoToolsCatalog(request)) {
      codexNoToolsCatalogBody(this.modelFor(request.model), this.realCodexHome(request));
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
    assertNoCodexProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // An override in TUI mode carries the run path's model requirement
    // (modelFor): a session without one would write no model into the
    // private config.toml. A caller mistake, so it fires at validation —
    // before any launch-owned directory exists (claude's TUI rule).
    if (this.validatedProvider() !== null) this.modelFor(model);
  }

  /** The TUI twin of the run path's private provider home. Both launch
   * paths (the sandboxed tui command and the plain interactive one) call
   * this before spawning and finalize it on every exit, so the override's
   * config.toml gets the same per-launch CODEX_HOME a run gets — never a
   * merge into the operator's config — and the key the config's env_key
   * names rides the environment codemux provides (codex-provider.ts). */
  override prepareTuiEnvironment(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed?: boolean,
    passthroughEnv?: readonly string[],
    _printOnly = false
  ) {
    const override = this.validatedProvider();
    if (override === null) {
      return super.prepareTuiEnvironment(model, autonomy, effort, sandboxed, passthroughEnv, _printOnly);
    }
    const home = writeCodexProviderConfig(
      this.realCodexHome({ agent: "codex", prompt: "", passthroughEnv }),
      override,
      this.modelFor(model)!,
      readCodexMultiAgent(this.environment), _printOnly
    );
    return {
      env: { CODEX_HOME: home.codexHome, [CODEX_PROVIDER_KEY_ENV]: override.apiKey },
      finalize: home.finalize,
    };
  }

}
