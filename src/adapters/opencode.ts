import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import {
  createOpencodeHermeticHome,
  type OpencodeHermeticHome,
} from "../opencode-hermetic.js";
import { assertNoOpenCodeProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
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
// packages/opencode/src/effect/runtime-flags.ts at 1.18.18. Empty strings are
// falsy where OpenCode reads them, so the last three neutralize anything an
// operator passed through with --pass-env.
const OPENCODE_HERMETIC_ENV = (home: string, realDataParent: string): string[] => [
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
  "OPENCODE_CONFIG=",
  "OPENCODE_CONFIG_DIR=",
  "OPENCODE_CONFIG_CONTENT=",
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
      // The mapping below is implemented but not claimed: `codemux check
      // --hermetic -a opencode` could not run this week (usage limits), so
      // the live check is pending. See docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
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

  buildRunCommand(request: RunRequest): string[] {
    const cmd: string[] = [];

    const envPrefix: string[] = [];
    if (request.hermetic) {
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and getRunEnv refuses a launch without one, so
      // a command built without prepareRun fails closed.
      const unprepared = join(this.realDataParent(), "opencode", ".codemux-hermetic", "unprepared");
      const home = this.hermeticHome?.home ?? unprepared;
      envPrefix.push(...OPENCODE_HERMETIC_ENV(home, this.realDataParent()));
    }
    if (request.tools === "none") {
      envPrefix.push(OPENCODE_NO_TOOLS_PERMISSION);
    }
    if (envPrefix.length > 0) {
      cmd.push("env", ...envPrefix);
    }
    cmd.push("opencode", "--pure", "run");

    if (request.model) {
      cmd.push("--model", request.model);
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
    if (!request.hermetic) return;
    // One home per run, never shared: a previous run's seeded config or
    // state must not reach the next one through the same adapter. Earlier
    // homes stay until process exit, since a run started earlier through
    // this same (singleton) adapter may still be using its own.
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

  override getRunEnv(request: RunRequest): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // OpenCode's side only in effect, so this is the codemux-side guarantee.
    if (request.hermetic && this.hermeticHome === null) {
      throw new Error("opencode hermetic home was not prepared before launch");
    }
    return {};
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoOpenCodeProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
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
