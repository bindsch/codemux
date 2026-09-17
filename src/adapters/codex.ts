import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import { createCodexHermeticHome, type HermeticHome } from "../hermetic-home.js";
import {
  assertNoCodexProjectExecutionConfig,
  assertNoCodexProjectSkills,
} from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
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

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = "codex";
  readonly binaryName = "codex";

  private hermeticHome: HermeticHome | null = null;

  // Seams so tests can point the real CODEX_HOME at a scratch directory.
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
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      supportsHermetic: true,
      supportsToolSelection: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["-s", "read-only", "-a", "never"];
      case "low":
        return ["-s", "workspace-write", "-a", "untrusted"];
      case "medium":
        return ["-s", "workspace-write", "-a", "never"];
      case "high":
        return ["-s", "danger-full-access", "-a", "never"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["-c", `model_reasoning_effort="${level}"`];
  }

  /**
   * The real CODEX_HOME whose login a hermetic run may use: the same one a
   * plain run of this request sees. The sanitized child environment drops
   * CODEX_HOME unless the operator passes it through with --pass-env, in
   * which case both kinds of run use that profile.
   */
  private realCodexHome(request: RunRequest): string {
    const passedThrough = request.passthroughEnv?.includes("CODEX_HOME") ?? false;
    const configured = this.environment.CODEX_HOME?.trim();
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("CODEX_HOME must be an absolute path");
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

  buildRunCommand(request: RunRequest): string[] {
    const cmd: string[] = [];

    if (request.hermetic) {
      // The private HOME reaches Codex through env(1), not through the
      // environment codemux hands to scode: scode derives its deny rules
      // (~/Documents, ~/.aws, ...) from $HOME, so moving HOME for the whole
      // launch would move the sandbox's protected paths off the real home.
      // A static preview (`verify`) has no prepared home; the placeholder
      // path does not exist, and Codex refuses a missing CODEX_HOME, so a
      // command built without prepareRun fails closed.
      const unprepared = join(this.realCodexHome(request), ".codemux-hermetic", "unprepared");
      const home = this.hermeticHome ?? {
        home: unprepared,
        codexHome: join(unprepared, ".codex"),
      };
      cmd.push("env", `HOME=${home.home}`, `CODEX_HOME=${home.codexHome}`);
    }
    cmd.push("codex");

    if (request.hermetic) {
      cmd.push(...CODEX_HERMETIC_FLAGS);
    }
    if (request.tools === "none") {
      cmd.push(...CODEX_NO_TOOLS_FLAGS);
    }

    if (request.model) {
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

    cmd.push("exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules");
    if (request.hermetic) {
      // Belt and braces: the private CODEX_HOME holds no config.toml anyway.
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

  override prepareRun(request: RunRequest): void {
    if (!request.hermetic) return;
    // One home per run, never shared: a previous run's files or refreshed
    // login state must not reach the next one through the same adapter.
    // Earlier homes stay until process exit, since a run started earlier
    // through this same (singleton) adapter may still be using its own.
    this.hermeticHome = createCodexHermeticHome(this.realCodexHome(request), this.apiKeyAuth());
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    // Both launch paths call this right before spawning; a static preview
    // never does. The placeholder home in buildRunCommand fails closed on
    // Codex's side, and this is the codemux-side guarantee.
    if (request.hermetic && this.hermeticHome === null) {
      throw new Error("codex hermetic home was not prepared before launch");
    }
    return {};
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
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
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
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
