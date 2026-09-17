import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import {
  createOpencodeHermeticHome,
  type OpencodeHermeticHome,
} from "../opencode-hermetic.js";
import {
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_KEY_ENV,
  writeOpencodeProviderConfig,
  type OpencodeProviderConfig,
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
  AdapterCapabilities,
} from "../types.js";

// Hermetic runs point OpenCode's XDG world at a private home (see
// opencode-hermetic.ts) and close the two channels a home cannot with these
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
  // The private home reaches OpenCode through env(1), never through the
  // environment codemux hands to scode: scode derives its deny rules from
  // $HOME, and these assignments override any XDG_* the sanitized child
  // environment carries.
  `HOME=${home}`,
  `XDG_CONFIG_HOME=${join(home, ".config")}`,
  `XDG_CACHE_HOME=${join(home, ".cache")}`,
  `XDG_STATE_HOME=${join(home, ".local", "state")}`,
  // The login lives in the real data directory (auth.json, rewritten in
  // place), so it stays real while everything else moves.
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
// JSON merges after every config layer (config.ts), so it holds in plain
// runs too, where the operator's config is loaded.
const OPENCODE_NO_TOOLS_PERMISSION = 'OPENCODE_PERMISSION={"*":"deny"}';

export class OpencodeAdapter extends BaseAdapter {
  readonly id: AgentId = "opencode";
  readonly binaryName = "opencode";

  private hermeticHome: OpencodeHermeticHome | null = null;
  // Every home this adapter created and has not disposed; earlier runs
  // through the same instance may still be using theirs.
  private readonly hermeticHomes: OpencodeHermeticHome[] = [];
  private providerConfig: OpencodeProviderConfig | null = null;
  // Every provider config this adapter created and has not disposed.
  private readonly providerConfigs: OpencodeProviderConfig[] = [];

  // Seams so tests can point the real data directory at a scratch directory.
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super();
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
      // (docs/HERMETIC.md).
      supportsHermetic: true,
      supportsToolSelection: true,
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

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("opencode home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  /**
   * The XDG data parent a plain run sees, holding the real OpenCode data
   * directory and its login: the sanitized child environment passes
   * XDG_DATA_HOME through, so an operator who relocated it keeps their
   * login in both kinds of run.
   */
  private realDataParent(): string {
    const configured = this.environment.XDG_DATA_HOME?.trim();
    if (configured) {
      if (!isAbsolute(configured)) {
        throw new Error("XDG_DATA_HOME must be an absolute path");
      }
      return configured;
    }
    return join(this.effectiveHome(), ".local", "share");
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

  buildRunCommand(request: RunRequest): string[] {
    const cmd: string[] = [];

    const envPrefix: string[] = [];
    if (request.hermetic) {
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and getRunEnv refuses a launch without one, so
      // a command built without prepareRun fails closed. The same holds for
      // the provider config's path.
      const unprepared = join(this.realDataParent(), "opencode", ".codemux-hermetic", "unprepared");
      const home = this.hermeticHome?.home ?? unprepared;
      envPrefix.push(
        ...OPENCODE_HERMETIC_ENV(
          home,
          this.realDataParent(),
          this.providerConfig?.path ?? null
        )
      );
    }
    if (request.tools === "none") {
      envPrefix.push(OPENCODE_NO_TOOLS_PERMISSION);
    }
    if (envPrefix.length > 0) {
      cmd.push("env", ...envPrefix);
    }
    cmd.push("opencode", "--pure", "run");

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

  override prepareRun(request: RunRequest): void {
    // The provider config rides every run with an override, hermetic or not:
    // one file per run, never shared, removed at exit. Hermetic runs also
    // get their private home; earlier artifacts stay until process exit,
    // since a run started earlier through this same (singleton) adapter may
    // still be using its own.
    const override = this.validatedProvider();
    if (override !== null) {
      const model = this.rawModelFor(request.model);
      if (model !== undefined) {
        this.providerConfig = writeOpencodeProviderConfig(
          join(this.realDataParent(), "opencode"),
          override,
          model
        );
        this.providerConfigs.push(this.providerConfig);
      }
    }
    if (!request.hermetic) return;
    this.hermeticHome = createOpencodeHermeticHome(
      join(this.realDataParent(), "opencode")
    );
    this.hermeticHomes.push(this.hermeticHome);
  }

  /** Finalizes every hermetic home of this adapter now rather than at exit. */
  disposeHermeticHome(): void {
    for (const home of this.hermeticHomes.splice(0)) home.finalize();
    this.hermeticHome = null;
  }

  /** Finalizes every provider config of this adapter now rather than at exit. */
  disposeProviderConfigs(): void {
    for (const config of this.providerConfigs.splice(0)) config.finalize();
    this.providerConfig = null;
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // OpenCode's side only in effect, so this is the codemux-side guarantee.
    if (request.hermetic && this.hermeticHome === null) {
      throw new Error("opencode hermetic home was not prepared before launch");
    }
    const override = this.validatedProvider();
    if (override === null) return {};
    if (this.providerConfig === null) {
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
      OPENCODE_CONFIG: this.providerConfig.path,
    };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the operator's own login and default model
    // would otherwise silently answer.
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
