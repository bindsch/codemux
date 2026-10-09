import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import {
  assertTrustedDirectory,
  createCodexHermeticHome,
  prepareRunDirParent,
} from "../hermetic-home.js";
import {
  CODEX_MULTI_AGENT_ENV,
  CODEX_PROVIDER_KEY_ENV,
  readCodexMultiAgent,
  writeCodexProviderConfig,
  writeCodexProviderConfigInto,
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
import { validateWorkingDirectory } from "../validation.js";
import { readUtf8FileBounded } from "../file-io.js";
import { codexResult } from "../result-envelope.js";
import { codexPlainResult } from "../plain-unwrap.js";
import type { ScodeTrustLevel } from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

// Hermetic runs get a private HOME and CODEX_HOME (see hermetic-home.ts),
// which removes everything Codex reads from disk. These overrides remove what
// the working directory and the account would still contribute. A feature key
// Codex no longer knows only logs a warning, so a removed key cannot break a
// launch.
const CODEX_HERMETIC_FLAGS = [
  // The login is the linked auth.json; the Keychain entry is keyed by the
  // real CODEX_HOME path and would not be found from the private one.
  "-c", 'cli_auth_credentials_store="file"',
  // A zero budget skips AGENTS.md discovery entirely (agents_md.rs).
  "-c", "project_doc_max_bytes=0",
  "-c", "project_doc_fallback_filenames=[]",
  // Account-level app connectors add instructions and tools of their own.
  "-c", "include_apps_instructions=false",
  "--disable", "apps",
  "--disable", "plugins",
  "--disable", "remote_plugin",
  "--disable", "recommended_plugins",
  "--disable", "hooks",
  "--disable", "memories",
  "--disable", "goals",
  "--disable", "skill_mcp_dependency_install",
  // The shell snapshot sources the operator's shell profile.
  "--disable", "shell_snapshot",
  // Not disabled: Codex's bundled system skills (imagegen, openai-docs,
  // plugin-creator, skill-creator, skill-installer at 0.154), which it
  // extracts into any home. They ship with the harness, like its base
  // prompt. `skip_host_skill_discovery` does not remove them and only
  // adds an under-development warning.
] as const;

// `--tools none`: every tool Codex 0.154 registers that reaches the machine,
// the network, or another agent, except `apply_patch`, which Codex ties to
// the model rather than to a feature (tools/spec_plan.rs). The adapter
// therefore accepts `--tools none` only at read-only autonomy, where the
// sandbox denies writes to the working directory (locations scode keeps
// writable, such as harness state and temp, remain reachable). The plan
// tool remains; it has no effect outside the conversation.
const CODEX_NO_TOOLS_FLAGS = [
  "--disable", "shell_tool",
  "--disable", "unified_exec",
  "--disable", "view_image",
  "--disable", "multi_agent",
  "--disable", "multi_agent_v2",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "image_generation",
  "--disable", "tool_suggest",
  // The top-level mode; a boolean `tools.web_search` is silently dropped.
  "-c", 'web_search="disabled"',
  "-c", "tools.view_image=false",
] as const;

// The --output-last-message file holds model output, so it gets the same
// bound a prompt file gets: 16 MiB, generous for a reply and small enough
// that a runaway file cannot exhaust the read.
const MAX_FINAL_MESSAGE_BYTES = 16 * 1024 * 1024;

// The file's name inside its per-run directory (or the private hermetic
// home): the directory gives the run its uniqueness, so the file itself
// needs none.
const LAST_MESSAGE_BASENAME = "last-message";

// Where a plain run's per-run fallback directory lives: inside the real
// CODEX_HOME, harness state scode keeps writable on every platform (its
// Linux sandbox mounts a fresh /tmp that would hide a temp-root file from
// the parent). The private hermetic home follows the same rule for the
// same reason (see hermetic-home.ts).
const SCRATCH_PARENT_DIR_NAME = ".codemux-scratch";

export class CodexAdapter extends BaseAdapter {
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
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      supportsHermetic: true,
      supportsToolSelection: true,
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
   * already promised).
   */
  private realCodexHome(request: RunRequest): string {
    const passedThrough = request.passthroughEnv?.includes("CODEX_HOME") ?? false;
    const configured = this.environment.CODEX_HOME;
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("CODEX_HOME must be an absolute path");
      }
      if (configured.trim() !== configured) {
        throw new Error(
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
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Codex home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  /**
   * The provider override, validated: a base URL and a key routed through a
   * private per-run CODEX_HOME (codex-provider.ts), plus the model the
   * endpoint serves. The output-token cap is refused — no release Codemux
   * supports reads one — while the context cap rides `model_context_window`
   * in the same config.toml. The multi-agent knob rides that config too, so
   * it is validated here as well: every launch path (validateRunRequest
   * through modelFor, the TUI check, prepareRun's writers) fails loudly on
   * a value that is not on/off or on a knob set without an override.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("codex", this.environment);
    this.assertMultiAgentKnob(override);
    if (override === null) return null;
    assertProviderCap(
      "codex",
      override,
      "maxOutputTokens",
      "no release Codemux supports reads a model_max_output_tokens key — the " +
        "0.160 config reference lists model_context_window but no output cap, " +
        "and the key never existed in the source through 0.160"
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
    throw new Error(
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
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined && override !== null) {
      throw new Error(
        "codex needs a model for the provider override; pass --model or set CODEMUX_CODEX_PROVIDER_MODEL"
      );
    }
    return resolved;
  }

  override getEnvOmissions(): readonly string[] {
    // With an override the provider key is the credential, so the operator's
    // own Codex/OpenAI keys stay out of the child environment: a stray
    // CODEX_API_KEY would hand the run a second, operator-funded
    // authentication path codemux never chose. Without one, both keep
    // forwarding as before (ALLOWED_CREDENTIAL_ENV.codex).
    return this.validatedProvider() === null ? [] : ["CODEX_API_KEY", "OPENAI_API_KEY"];
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];
    const override = this.validatedProvider();

    if (request.hermetic) {
      // The private HOME reaches Codex through env(1), not through the
      // environment codemux hands to scode: scode derives its deny rules
      // (~/Documents, ~/.aws, ...) from $HOME, so moving HOME for the whole
      // launch would move the sandbox's protected paths off the real home.
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and Codex refuses a missing CODEX_HOME, so a
      // command built without prepareRun fails closed.
      const unprepared = join(this.realCodexHome(request), ".codemux-hermetic", "unprepared");
      const home = context?.hermeticHome ?? {
        home: unprepared,
        codexHome: join(unprepared, ".codex"),
      };
      cmd.push("env", `HOME=${home.home}`, `CODEX_HOME=${home.codexHome}`);
    } else if (override !== null) {
      // A non-hermetic override run also gets a private CODEX_HOME — the
      // per-run directory holding this run's config.toml (codex-provider.ts)
      // — delivered the same way, so the operator's config.toml and
      // auth.json are not read by construction. Same fail-closed placeholder
      // rule as the hermetic home: without prepareRun the home does not
      // exist and Codex refuses a missing CODEX_HOME.
      const unprepared = join(this.realCodexHome(request), ".codemux-provider", "unprepared");
      cmd.push("env", `CODEX_HOME=${context?.codexProviderHome?.codexHome ?? unprepared}`);
    }
    cmd.push("codex");

    if (request.hermetic) {
      cmd.push(...CODEX_HERMETIC_FLAGS);
    }
    if (request.tools === "none") {
      cmd.push(...CODEX_NO_TOOLS_FLAGS);
    }

    if (request.model && override === null) {
      // On an override run the model rides the config.toml, never -m: the
      // two could disagree across a config rewrite, and one source is
      // checkable.
      cmd.push("-m", request.model);
    }

    if (request.sandboxed) {
      // codemux is already enforcing scode sandbox boundaries.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    cmd.push("exec", "--skip-git-repo-check");
    // No run of this adapter persists a session: a thread codex would write
    // under CODEX_HOME dies with the run instead of staying resumable.
    cmd.push("--ephemeral");
    cmd.push("--ignore-rules");
    // A plain run keeps human mode (review ul3): `--json` streams every
    // event, tool output included, so an agentic run's stream is tens of
    // MiB and fills the 16 MiB stdout capture -- exit 125, reply lost,
    // no receipt. Human mode prints the reply on stdout (the contract a
    // plain run always had) and one blended `tokens used` figure on
    // stderr, which processRunResult records as the run's usage
    // (plain-unwrap.ts). Only --result-json asks for the event stream,
    // which it reduces to the promised envelope.
    if (request.resultJson) {
      // Events as JSONL on stdout (one per line; codex-rs exec lib.rs),
      // which processRunResult reduces to the envelope --result-json
      // promises: the final assistant message plus the codemux usage
      // block. Human mode carries only a blended token total on stderr
      // and no message boundary, so the event stream is the robust
      // source.
      cmd.push("--json");
      // The stream's one blind spot is a turn that ends with a Plan and no
      // agent_message: codex treats that Plan as the final message, but its
      // JSONL mapper drops the item, so the recorded final message is the
      // only carrier (see CODEX_FINAL_MESSAGE_FALLBACK_NOTE). prepareRun
      // puts the file in a per-run directory under `.codemux-scratch/` in
      // the real CODEX_HOME -- harness state, which every scode platform
      // keeps writable and none shadows -- or inside the private home on a
      // hermetic run. An untrusted sandbox denies harness state, so that
      // launch prepares no file and the stream is the result's only source.
      // A static preview (`verify`) has no prepared context, so it names a
      // placeholder under a directory that cannot exist, failing closed the
      // way the hermetic home's preview does.
      const fallbackPath = context?.lastMessagePath;
      if (fallbackPath !== undefined) {
        cmd.push("--output-last-message", fallbackPath);
      } else if (context === undefined) {
        const placeholder = join(
          this.realCodexHome(request),
          request.hermetic ? ".codemux-hermetic" : SCRATCH_PARENT_DIR_NAME,
          "unprepared",
          LAST_MESSAGE_BASENAME
        );
        cmd.push("--output-last-message", placeholder);
      }
      // A prepared context with no lastMessagePath is the untrusted launch:
      // there is no file to name, by design.
    }
    if (request.hermetic && override === null) {
      // Belt and braces: the private CODEX_HOME holds no config.toml anyway.
      // An override run is the exception that proves the rule's wording —
      // `--ignore-user-config` skips "$CODEX_HOME/config.toml" itself, which
      // is exactly where the override lives (verified in the 0.160 binary's
      // own help text), so it is never passed on one.
      cmd.push("--ignore-user-config");
    }
    cmd.push("-");

    return cmd;
  }

  /**
   * Whether the run authenticates with an API key. Only the variable Codex
   * itself reads counts (CODEX_API_KEY at 0.154): a hermetic run must use
   * the same credential a plain run would, never switch an operator with a
   * stray OPENAI_API_KEY from the account login to API billing.
   */
  private apiKeyAuth(): boolean {
    return Boolean(this.environment.CODEX_API_KEY?.trim());
  }

  /**
   * Builds this run's context: the `--output-last-message` file a `--json`
   * launch will name, and the private hermetic home a hermetic run needs.
   * Nothing is recorded on the adapter; the launcher owns the returned
   * context, so two launches through this singleton -- even two through
   * the same request object -- each carry their own.
   */
  override prepareRun(request: RunRequest, sandboxTrust?: ScodeTrustLevel): RunContext {
    const context: RunContext = {};
    const override = this.validatedProvider();
    if (request.hermetic) {
      // One home per run, never shared: a previous run's files or refreshed
      // login state must not reach the next one. hermetic-home.ts tracks
      // live homes itself (signal handling, the exit sweep), so the context
      // holds the home as plain data and the adapter holds nothing. An
      // override run never links the operator's auth.json either — the
      // provider key is the credential — so the home starts empty and holds
      // only the override's config.toml, written below.
      context.hermeticHome = createCodexHermeticHome(
        this.realCodexHome(request),
        this.apiKeyAuth() || override !== null
      );
      if (override !== null) {
        writeCodexProviderConfigInto(
          context.hermeticHome.codexHome,
          override,
          this.modelFor(request.model)!,
          readCodexMultiAgent(this.environment)
        );
      }
    } else if (override !== null) {
      // The plain-run variant of the same rule: one private CODEX_HOME per
      // launch, owned by the run and finalized in cleanupRun (and swept, by
      // the age-gated rule the hermetic homes use, only once it is stale and
      // its owning process is gone — codex-provider.ts).
      context.codexProviderHome = writeCodexProviderConfig(
        this.realCodexHome(request),
        override,
        this.modelFor(request.model)!,
        readCodexMultiAgent(this.environment)
      );
    }
    if (request.resultJson) {
      // The --output-last-message file of THIS run, placed where the child
      // can write it and the parent can read it back: scode keeps harness
      // state writable on every platform and never shadows it, unlike the
      // OS temp root, which its Linux sandbox replaces with a fresh /tmp
      // the parent never sees. Under hermetic the file lives inside the
      // private home (itself under the real CODEX_HOME), and finalize
      // removes it with the home; otherwise it gets a per-run directory
      // under `.codemux-scratch/` in the real CODEX_HOME, so two runs never
      // see each other's message, and prepareRunDirParent sweeps
      // directories a dead codemux left behind. An untrusted sandbox denies
      // harness state -- no location is both writable by the child and
      // readable by the parent -- so that run passes no file at all and the
      // event stream is the result's only source; a Plan-only turn then
      // reports a null result, the documented cost (README). Hermetic runs
      // keep their file whatever the trust: an untrusted sandbox denies the
      // private home itself, so the fallback is not what decides that run.
      // processRunResult removes the file once read; cleanupRun removes the
      // directory. A plain run prepares none of this: it launches in human
      // mode and names no fallback file (review ul3).
      // prepareRun creates the home above whenever request.hermetic is set,
      // so a home here is the hermetic case; a hermetic run that somehow has
      // none fails closed at getRunEnv before anything launches.
      const home = context.hermeticHome;
      if (home !== undefined) {
        context.lastMessagePath = join(home.home, LAST_MESSAGE_BASENAME);
      } else if (sandboxTrust !== "untrusted") {
        const scratchParent = prepareRunDirParent(
          this.realCodexHome(request),
          SCRATCH_PARENT_DIR_NAME
        );
        context.lastMessageDir = mkdtempSync(
          join(scratchParent, `run-${process.pid}-`)
        );
        context.lastMessagePath = join(
          context.lastMessageDir,
          LAST_MESSAGE_BASENAME
        );
      }
    }
    return context;
  }

  override cleanupRun(context?: RunContext): void {
    // A launch that rejects (a captured stdout that is not UTF-8, say) can
    // reject after codex already wrote its --output-last-message file, and
    // processRunResult's read-and-remove never runs: without this path the
    // model output in that file would outlive the run, so the per-run
    // directory under the real CODEX_HOME's `.codemux-scratch/` goes with
    // it. A hermetic run needs no separate removal -- the file lives inside
    // the private home, which dies with the run below (it holds a link to
    // the real login, and a run that never launched needs none of it). An
    // untrusted run carries neither piece of state and returns above.
    if (
      context?.lastMessageDir === undefined &&
      context?.hermeticHome === undefined &&
      context?.codexProviderHome === undefined
    ) {
      return;
    }
    if (context.lastMessageDir !== undefined) {
      // The same revalidation the result reader applies
      // (readFinalMessageFallback): a run with write access to ~/.codex could
      // have replaced `.codemux-scratch` with a symlink after prepareRun made
      // it, and the recursive removal resolves that intermediate component
      // like any path operation would -- following the link into a directory
      // codemux never chose, outside the sandbox. rm does not follow a symlink
      // at the run directory's own name (it removes the link), so the parent
      // is the one component to check. A parent that fails keeps its
      // directory: the refusal says so, the reader's wording, and the launch's
      // own rejection stays the failure the caller needs.
      let parentTrusted = true;
      try {
        assertTrustedDirectory(dirname(context.lastMessageDir));
      } catch (error) {
        parentTrusted = false;
        console.error(
          "codemux: refusing to remove codex's --output-last-message directory: " +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (parentTrusted) {
        try {
          rmSync(context.lastMessageDir, { recursive: true, force: true });
        } catch (error) {
          // A cleanup that cannot remove the directory says so and stays out
          // of its way.
          console.error(
            "codemux: could not remove codex's --output-last-message directory: " +
              `${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    try {
      context.hermeticHome?.finalize();
    } catch (error) {
      console.error(
        "codemux: could not remove codex's private hermetic home: " +
          `${error instanceof Error ? error.message : String(error)}`
        );
    }
    try {
      // A hermetic override run has no codexProviderHome — its config rides
      // the hermetic home above — so this finalizes exactly the plain-run
      // home this launch created.
      context.codexProviderHome?.finalize();
    } catch (error) {
      console.error(
        "codemux: could not remove codex's provider-override home: " +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    // The passed-through CODEX_HOME is checked exactly as the child reads
    // it here (the round10/round13 rule), before prepareRun creates the
    // run's `.codemux-scratch/` directory under it: validation owns the
    // refusal, so a value the run would refuse never touches disk.
    this.realCodexHome(request);
    // Fail before launch on a half-configured override and surface the model
    // requirement early (validatedProvider's output-cap refusal is reached
    // through the same call): the config.toml cannot be written without
    // both, and a run that reached prepareRun would die mid-write.
    this.modelFor(request.model);
    const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
    assertNoCodexProjectExecutionConfig(cwd);
    if (request.hermetic) {
      assertNoCodexProjectSkills(cwd, this.effectiveHome());
    }
    if (request.tools === "none" && (request.autonomy ?? "read-only") !== "read-only") {
      throw new Error(
        "codex cannot remove its apply_patch tool; --tools none needs --auto read-only, " +
          "where the sandbox denies writes to the working directory"
      );
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
    // The private CODEX_HOME's lifecycle rides prepareRun, which only the
    // headless launch path calls; an interactive session has no hook to
    // write and remove the override's config.toml, and pointing one at the
    // operator's real CODEX_HOME would mean writing codemux's provider
    // table into the operator's config.
    if (this.validatedProvider() !== null) {
      throw new Error(
        "the codex provider override supports headless runs only; unset CODEMUX_CODEX_PROVIDER_* for an interactive session"
      );
    }
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(
    result: RunResult,
    request: RunRequest,
    context?: RunContext
  ): RunResult {
    // A plain run keeps human mode (review ul3): stdout is the reply
    // verbatim -- exactly what a plain run printed before the ledger -- and
    // the only usage carrier is the `tokens used` figure on stderr, so the
    // receipt's usage is that blended total and nothing else
    // (plain-unwrap.ts).
    if (!request.resultJson) return codexPlainResult(result);
    // Read (and remove) this run's --output-last-message file first: the
    // launch named one, and whether or not the stream needs it, the file must
    // not outlive the run that wrote it.
    const finalMessageFallback = this.readFinalMessageFallback(context);
    // The run was launched with --json, so stdout is the JSONL event stream
    // rather than the reply; codexResult builds the envelope --result-json
    // promises (result = final assistant message, codemux block = usage).
    // An override run's model rode the config.toml, never -m, so the request
    // may carry none while the run used one; resolve it the way prepareRun
    // did, so the envelope's model fallback (and the reroute note) sees the
    // model codemux actually selected.
    const override = this.validatedProvider();
    const effective =
      override === null ? request : { ...request, model: this.modelFor(request.model) };
    return codexResult(result, effective, finalMessageFallback);
  }

  /**
   * Reads and removes this run's --output-last-message file, returning its
   * text as the fallback final message: null when this run launched without
   * one (no context path -- an untrusted sandbox launch passes no file), when
   * the directory holding it is not a real user-owned directory (a swapped
   * symlink, the check above), when codex wrote nothing (no file, or an
   * empty one -- upstream warns and writes an empty file for a turn without
   * a final message), or when the file cannot be read, in which case a
   * warning says so, because a message codemux cannot read must not quietly
   * become the run's result.
   */
  private readFinalMessageFallback(context?: RunContext): string | null {
    const path = context?.lastMessagePath ?? null;
    if (path === null) return null;
    // The noFollow below refuses a symlink at the file's own name only:
    // a compromised child could instead replace the directory holding the
    // file -- this run's per-run directory, or its `.codemux-scratch` /
    // `.codemux-hermetic` parent -- with a symlink, and both the read and
    // the removal would follow it into a directory codemux never chose,
    // outside the sandbox (an intermediate path component is followed
    // however the final one is opened, and Node has no dirfd-relative
    // open). The same lstat check prepareRunDirParent applied when it
    // created the parent refuses both directories first, so a swapped
    // directory loses the fallback with a warning rather than lending the
    // run -- and the delete -- a file it cannot vouch for.
    try {
      assertTrustedDirectory(dirname(path));
      assertTrustedDirectory(dirname(dirname(path)));
    } catch (error) {
      console.error(
        "codemux: refusing codex's --output-last-message file: " +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
    let contents: string | null = null;
    try {
      const read = readUtf8FileBounded(path, {
        maxBytes: MAX_FINAL_MESSAGE_BYTES,
        label: path,
        // The name is one this adapter just generated (in this run's
        // private per-run directory, or its private hermetic home), so a
        // link standing in its place is an attack on the run, not a path
        // codemux should follow.
        noFollow: true,
      });
      // Codex writes the message plus one trailing newline; both consumers
      // (the plain path's println shape, the envelope's result text) add
      // their own, so the file's newline is stripped here. Only the file's
      // own newline is: interior lines are the message.
      const trimmed = read.endsWith("\n") ? read.slice(0, -1) : read;
      contents = trimmed.length === 0 ? null : trimmed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          "codemux: could not read codex's --output-last-message file: " +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // Same rule as cleanupRun: a cleanup that cannot remove the file says
      // so and stays out of the run's way, so a finished run's result is
      // never replaced by a cleanup error.
      console.error(
        "codemux: could not remove codex's --output-last-message file: " +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return contents;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    sandboxed = false
  ): string[] {
    const cmd = ["codex"];
    if (model) {
      cmd.push("-m", model);
    }
    if (sandboxed) {
      // codemux is already enforcing scode sandbox boundaries.
      cmd.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
