import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
import { validateWorkingDirectory } from "../validation.js";
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
import { OpenCodePlainFold, opencodePlainResult } from "../plain-unwrap.js";

// Hermetic runs point OpenCode's XDG world at a private home (see
// opencode-hermetic.ts) and close the channels a home cannot with these
// env-only switches, read in packages/core/src/flag/flag.ts and
// packages/opencode/src/effect/runtime-flags.ts at 1.18.18. The config
// variables are REMOVED, not blanked: Global.Path.config reads
// `Flag.OPENCODE_CONFIG_DIR ?? Path.config` (packages/core/src/global.ts),
// and an empty string survives `??`, degenerating `path.join(global.config,
// "AGENTS.md")` into a project-relative file the ungated global-files loop
// then loads — a leak, not a neutralizer (verified live: the empty
// assignment carried a planted canary into the system prompt at 1.18.18).
// A provider override sets OPENCODE_CONFIG to codemux's own config file —
// the one channel hermetic deliberately keeps, because codemux wrote it.
const OPENCODE_HERMETIC_ENV = (
  home: string,
  realDataParent: string,
  providerConfigPath: string | null
): string[] => [
  "-u",
  "OPENCODE_CONFIG",
  "-u",
  "OPENCODE_CONFIG_DIR",
  "-u",
  "OPENCODE_CONFIG_CONTENT",
  // Auth.all reads OPENCODE_AUTH_CONTENT before the auth.json file
  // (packages/opencode/src/auth/index.ts), so a passed-through value is a
  // login state codemux never inspected — removed like the config
  // variables, and for the same reason: hermetic carries no channel the
  // operator named.
  "-u",
  "OPENCODE_AUTH_CONTENT",
  // The private home reaches OpenCode through env(1), never through the
  // environment codemux hands to scode: scode derives its deny rules from
  // $HOME, and these assignments override any XDG_* the sanitized child
  // environment carries.
  `HOME=${home}`,
  `XDG_CONFIG_HOME=${join(home, ".config")}`,
  `XDG_CACHE_HOME=${join(home, ".cache")}`,
  `XDG_STATE_HOME=${join(home, ".local", "state")}`,
  // The login lives in the real data directory (auth.json, rewritten in
  // place), so it stays real while everything else moves — and is
  // inspected for remote-config carriers before the launch
  // (opencode-remote-config.ts).
  `XDG_DATA_HOME=${realDataParent}`,
  // Project AGENTS.md/CLAUDE.md/CONTEXT.md discovery, opencode.json and
  // .opencode directories come from the working directory
  // (packages/opencode/src/session/instruction.ts, config/paths.ts).
  "OPENCODE_DISABLE_PROJECT_CONFIG=1",
  // ~/.claude/CLAUDE.md and the .claude skills fallback; the paths are
  // already unreachable under the private home, and the flag holds even if a
  // future release resolves them elsewhere.
  "OPENCODE_DISABLE_CLAUDE_CODE=1",
  // ~/.claude/skills and ~/.agents/skills (packages/opencode/src/skill/index.ts).
  "OPENCODE_DISABLE_EXTERNAL_SKILLS=1",
  ...(providerConfigPath === null ? [] : [`OPENCODE_CONFIG=${providerConfigPath}`]),
];

// `--tools none`: a pattern-"*" deny in the permission rules removes every
// tool from the model's request (packages/opencode/src/permission/index.ts
// disabled() and session/llm/request.ts resolveTools drop them). The env
// JSON merges after every config layer (config.ts). That is the whole
// story only where no later fold can append per-agent permission rules
// after the global ones (agent config at packages/opencode/src/agent/
// agent.ts: `item.permission = Permission.merge(item.permission, …)`, and
// the `mode` entries fold into agents after even OPENCODE_CONFIG_CONTENT;
// the last matching rule wins, `findLast` in permission.ts). On a plain
// run the operator's own config can do exactly that, and a hermetic run
// keeps the real data directory for the login, so a login carrying remote
// configuration can too: OpenCode fetches a well-known login's
// `.well-known/opencode` document and an active organization's `/api/config`
// and merges them as global config (config.ts at 1.18.18), verified live
// through this adapter's own plain-run path for the operator config (h2
// review): with `"agent": {"build": {"permission": {"bash": "allow"}}}`,
// a `--tools none` run's request carried the bash tool. No environment
// variable spells per-agent or mode permissions and a codemux-written
// config layer still merges before the mode fold, so plain runs refuse the
// capability; the login's remote configuration is refused the same way
// (opencode-remote-config.ts, h3 review). Admin-managed settings — the
// machine administrator's layer, `/Library/Application Support/opencode`,
// `/etc/opencode`, MDM plists — can also append and cannot be refused;
// they are the documented residual (docs/HERMETIC.md, "What hermetic does
// not cover").
const OPENCODE_NO_TOOLS_PERMISSION = 'OPENCODE_PERMISSION={"*":"deny"}';

/** Why a hermetic run refuses a login that carries remote configuration. */
const hermeticRemoteConfigRefusal = (carrier: string): string =>
  `opencode --hermetic is refused while the login carries remote configuration: ${carrier}; ` +
  "agent permissions from it would override the --tools none deny (docs/HERMETIC.md)";

/** Why a plain (non-hermetic) run refuses `--tools none`. */
const PLAIN_NO_TOOLS_REFUSAL =
  "opencode --tools none requires --hermetic: the operator's opencode config can override the permission deny per agent";

/** The user home a run sees: the seam, else $HOME, else the account home. */
function opencodeEffectiveHome(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  if (homeDirectory !== undefined && !isAbsolute(homeDirectory)) {
    throw new Error("opencode home directory must be an absolute path");
  }
  const home = homeDirectory ?? environment.HOME;
  return home && isAbsolute(home) ? home : homedir();
}

/**
 * The XDG data parent a plain run sees, holding the real OpenCode data
 * directory and its login: the sanitized child environment passes
 * XDG_DATA_HOME through, so an operator who relocated it keeps their
 * login in both kinds of run. Exported because the session CLI records
 * the same directory as the opencode session's harness home (§4.8) —
 * the native sessions live there, so one rule computes both and they
 * cannot drift.
 */
export function opencodeRealDataParent(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  const configured = environment.XDG_DATA_HOME?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("XDG_DATA_HOME must be an absolute path");
    }
    return configured;
  }
  return join(opencodeEffectiveHome(environment, homeDirectory), ".local", "share");
}

/** The real OpenCode data directory holding the login state the
 * remote-config inspection reads (opencode-remote-config.ts) and the
 * native session database a `codemux session` resumes from. */
export function opencodeRealDataDir(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  return join(opencodeRealDataParent(environment, homeDirectory), "opencode");
}

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
      // (docs/HERMETIC.md). The h2 review scoped --tools none to hermetic
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
   * The XDG data parent a plain run sees, holding the real OpenCode data
   * directory and its login: the sanitized child environment passes
   * XDG_DATA_HOME through, so an operator who relocated it keeps their
   * login in both kinds of run. Shared with the session CLI (see
   * opencodeRealDataParent).
   */
  private realDataParent(): string {
    return opencodeRealDataParent(this.environment, this.homeDirectory);
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
      throw new Error(
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

    const envPrefix: string[] = [];
    if (request.hermetic) {
      // The remote-config refusal, ahead of everything else a hermetic run
      // builds: no env prefix removes the login's own configuration, so a
      // carrier breaks both guarantees and every builder — the CLI through
      // validateRunRequest, `verify` through this — fails closed.
      const carrier = this.remoteConfigCarrier();
      if (carrier !== null) {
        throw new Error(hermeticRemoteConfigRefusal(carrier));
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
          this.realDataParent(),
          context?.opencodeProviderConfig?.path ?? null
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
        throw new Error(PLAIN_NO_TOOLS_REFUSAL);
      }
      envPrefix.push(OPENCODE_NO_TOOLS_PERMISSION);
    }
    if (envPrefix.length > 0) {
      cmd.push("env", ...envPrefix);
    }
    cmd.push("opencode", "--pure", "run");
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
    _request: RunRequest,
    context?: RunContext
  ): RunResult {
    // The run was launched with --format json, so stdout is the event-line
    // wire — streamed through the fold prepareRun hung on the context, so
    // tool output never fills the capture bound (review ul4). Anything the
    // fold saw that was not the wire passed through verbatim with the run
    // unchanged (plain-unwrap.ts's escape hatch). Callers that reach here
    // without the context's sink (a result already captured whole) get the
    // same fold and verdict from the captured stdout.
    const sink = context?.stdoutSink;
    if (sink instanceof OpenCodePlainFold) return sink.verdict(result);
    return opencodePlainResult(result);
  }

  override prepareRun(request: RunRequest): RunContext {
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
    if (request.hermetic) {
      context.opencodeHermeticHome = createOpencodeHermeticHome(this.realDataDir());
    }
    // The JSON event stream carries every tool's output, so the launcher
    // feeds it to this fold instead of capturing stdout whole: the fold
    // keeps the reply text, the folded step_finish usage, and the break
    // notes — tool parts dropped as they arrive — so no volume of tool
    // output can reach the 16 MiB capture bound (review ul4).
    context.stdoutSink = new OpenCodePlainFold();
    return context;
  }

  override cleanupRun(context?: RunContext): void {
    // The launcher calls this exactly once per context it created, after a
    // finished run and after a rejected one alike; each artifact dies with
    // its own launch only.
    context?.opencodeHermeticHome?.finalize();
    context?.opencodeProviderConfig?.finalize();
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
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // The plain-run --tools none refusal, surfaced early with its reason
    // (see OPENCODE_NO_TOOLS_PERMISSION for the channel that cannot be
    // closed).
    if (request.tools === "none" && !request.hermetic) {
      throw new Error(PLAIN_NO_TOOLS_REFUSAL);
    }
    // The hermetic remote-config refusal, surfaced with its reason too:
    // the login's own configuration channel (opencode-remote-config.ts).
    if (request.hermetic) {
      const carrier = this.remoteConfigCarrier();
      if (carrier !== null) {
        throw new Error(hermeticRemoteConfigRefusal(carrier));
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
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    // The provider config's lifecycle rides prepareRun, which only the
    // headless launch path calls; an interactive session has no hook to
    // write and remove the file.
    if (this.validatedProvider() !== null) {
      throw new Error(
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
}
