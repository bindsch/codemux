import { join } from "node:path";
import { BaseAdapter, type RunContext } from "./base.js";
import type { LaunchIntent } from "../types.js";
import { appendDiagnostic } from "../result-envelope.js";
import { assertNoOpenHandsProjectExecutionConfig } from "../project-safety.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { assertCleanInstructionFiles } from "../clean-cwd.js";
import { createOpenhandsHermeticHome } from "../openhands-hermetic.js";
import { plantOpenhandsPlaywrightMcp } from "../openhands-mcp.js";
import { writeOpenhandsTaskFile } from "../openhands-task-file.js";
import { validateOpenhandsProjectSettings } from "../openhands-project-settings.js";
import { refuseOpenhandsExperiment } from "../openhands-experiment-run.js";
import { openhandsPlainResult, openhandsResult } from "../result-envelope/openhands.js";
import { withStreamScanSurface } from "../stream-marker-scan.js";
import {
  assertProviderCap,
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
} from "../types.js";
import { envKeyLoginState, loginHome, type LoginState } from "../harness-health.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";

/**
 * OpenHands CLI (`openhands`), audited against 1.16.0.
 *
 * Two properties shape this adapter, both verified against the installed CLI:
 *
 * Non-interactive runs require `--headless`, which the CLI documents as
 * "no UI output, auto-approve actions". The TUI code makes it exact:
 * `tui/textual_app.py` selects the NeverConfirm policy whenever
 * `--headless` is set (`if headless or always_approve:`, openhands 1.16.0,
 * read 2026-11-08), and the parser's full option list — version, task,
 * file, headless, json, exit-without-confirmation, the confirmation group,
 * resume — carries no tool allowlist. There is no headless mode that keeps
 * an approval gate, so a headless run has no native restraint at any level
 * and the boundary is entirely scode's, with high as the headless default
 * state. Interactive sessions default to `always-ask`, which confirms
 * every action.
 *
 * `--llm-approve` is deliberately never emitted. It confirms only the actions an
 * LLM predicts are high-risk, which is not a weaker form of human approval but a
 * different mechanism, and Codemux will not advertise it as one of its graded
 * levels. `--always-approve` is the honest mapping for `high`.
 *
 * There is no `--model` flag. Model selection exists only through
 * `--override-with-envs`, which makes the CLI read LLM_MODEL, LLM_API_KEY, and
 * LLM_BASE_URL from the environment it would otherwise ignore — the same
 * channel a provider override rides.
 */
/** The line OpenHands prints before it exits 0 without a task. */
export const OPENHANDS_NO_SETTINGS_MARKER = "Headless mode requires existing settings.";
const OPENHANDS_NO_SETTINGS_HINT =
  "codemux: openhands ran no task: headless mode requires existing settings; run `openhands` once to configure it";
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/**
 * Whether stdout is OpenHands' complete no-settings startup output: the
 * marker line, then its "Please run: ... --headless" instruction, then a
 * "Goodbye!" line, each a whole line once its color codes are removed. A
 * reply that merely quotes the marker does not match (review round 334).
 */
export function openHandsRanNoTask(stdout: string): boolean {
  const lines = stdout.split("\n").map((line) => line.replace(ANSI_SGR, "").trimEnd());
  const marker = lines.indexOf(OPENHANDS_NO_SETTINGS_MARKER);
  if (marker < 0) return false;
  const instruction = lines[marker + 1] ?? "";
  if (!instruction.startsWith("Please run:") || !instruction.includes("--headless")) return false;
  return lines.slice(marker + 2).includes("Goodbye!");
}

export class OpenHandsAdapter extends BaseAdapter {
  readonly id: AgentId = "openhands";
  readonly binaryName = "openhands";

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      // Only via --override-with-envs; there is no model flag.
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // No reasoning-effort control exists at 1.16.0: the CLI's argparse
      // surface (openhands_cli/argparsers/main_parser.py and the installed
      // package) defines headless/task/file/json/resume/always-approve/
      // llm-approve/override-with-envs and no effort or thinking key, and
      // no LLM_* effort variable is read (LLMEnvOverrides.from_env reads
      // exactly LLM_API_KEY, LLM_BASE_URL, LLM_MODEL; read 2026-11-09). A
      // harness limitation, not a codemux one.
      supportsEffort: false,
      effortLevels: [],
      supportsProviderOverride: true,
      // Hermetic: a private HOME closes the ~/.openhands channel (settings,
      // agent specs, hooks, microagents — the whole agent spec is operator
      // customization, so nothing is carried; src/openhands-hermetic.ts),
      // and the clean-cwd rule closes the working directory's .openhands
      // (setup.py's HookConfig.load reads {working_dir}/.openhands/
      // hooks.json at 1.16.0, read 2026-11-09). The private home also
      // empties the settings store, and headless mode refuses to start
      // without settings UNLESS env overrides supply the LLM
      // (SettingsScreen.is_initial_setup_required → AgentStore.
      // load_or_create(env_overrides_enabled), textual_app.py at 1.16.0),
      // so a hermetic run requires the provider override and is refused
      // without one. Result JSON: `--json` with `--headless`
      // (entrypoint.py's json_mode; src/result-envelope/openhands.ts holds
      // the field evidence).
      supportsHermetic: true,
      hermeticRequiresProviderOverride: true,
      supportsResultJson: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // Interactive only. `read-only`, `low`, and `medium` all leave the CLI in
    // its default always-ask mode and are separated by the scode policy that
    // each of them requires.
    return level === "high" ? ["--always-approve"] : [];
  }

  /**
   * The provider override, validated: `--override-with-envs` reads
   * LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (`LLMEnvOverrides.from_env`,
   * `agent_store.py` at 1.16.0), and the model string reaches litellm
   * unchanged, so a custom OpenAI-compatible endpoint needs litellm's
   * `openai/` prefix — the same convention aider documents for the same
   * reason. The override needs a base URL and a key; both token caps are
   * refused, because that trio is the entire surface the flag reads.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("openhands", this.environment);
    if (override === null) return null;
    const noCapSurface =
      "OpenHands' --override-with-envs reads exactly LLM_API_KEY, LLM_BASE_URL " +
      "and LLM_MODEL (LLMEnvOverrides.from_env, agent_store.py at 1.16.0), so " +
      "no output or context cap can ride it";
    assertProviderCap("openhands", override, "maxOutputTokens", noCapSurface);
    assertProviderCap("openhands", override, "maxContextTokens", noCapSurface);
    return requireProviderOverride("openhands", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The LLM_MODEL value: with an override, the openai/ prefix routes to it. */
  private modelFor(model: string | undefined): string | undefined {
    const override = this.validatedProvider();
    const resolved = model ?? override?.model;
    if (resolved === undefined) {
      if (override !== null) {
        throw new UsageRefusalError(
          "openhands needs a model for the provider override; pass --model or set CODEMUX_OPENHANDS_PROVIDER_MODEL"
        );
      }
      return undefined;
    }
    if (override === null) return resolved;
    return resolved.startsWith("openai/") ? resolved : `openai/${resolved}`;
  }

  /**
   * The override key is visible to the model, and the operator is told so
   * on every launch that carries an override. OpenHands has no exclusion
   * knob: both terminal implementations (subprocess and tmux) build the
   * shell's environment from the CLI process's own, and the sanitizer in
   * between strips only `SESSION_API_KEY` (`sanitized_env`, openhands.sdk
   * at CLI 1.16.0 — verified 2026-10-07), so any command the model runs
   * can read `LLM_API_KEY`. Codex excludes its key via
   * `shell_environment_policy` and claude scrubs subprocesses with
   * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`; OpenHands offers neither, so the
   * honest fix is disclosure plus a scoped, revocable key (README).
   */
  override beforeLaunch(): void {
    if (this.validatedProvider() === null) return;
    console.error(
      "openhands: provider override active — LLM_API_KEY is visible to the " +
        "model (its terminal inherits the CLI environment; OpenHands has no " +
        "exclusion knob); use a key you can revoke and scope to the endpoint"
    );
  }

  /** The environment is ignored unless --override-with-envs is passed.
   *
   * Ambient `LLM_BASE_URL`/`LLM_API_KEY` (review round 153): sanitize
   * keeps those names in the launch environment because they are
   * OpenHands's own credential variables, so an operator who exported
   * them has OpenHands itself configured that way — codemux changes
   * nothing when no override is set. A codemux provider override
   * REPLACES them (both keys below are set unconditionally), and the
   * flag below makes OpenHands read the environment at all. */
  override getRunEnv(request: RunRequest): Record<string, string> {
    const override = this.validatedProvider();
    const model = this.modelFor(request.model);
    if (override === null) {
      return model ? { LLM_MODEL: model } : {};
    }
    return {
      LLM_BASE_URL: override.baseUrl,
      LLM_API_KEY: override.apiKey,
      ...(model ? { LLM_MODEL: model } : {}),
    };
  }

  override getTuiEnv(model?: string): Record<string, string> {
    const override = this.validatedProvider();
    const resolved = this.modelFor(model);
    if (override === null) {
      return resolved ? { LLM_MODEL: resolved } : {};
    }
    return {
      LLM_BASE_URL: override.baseUrl,
      LLM_API_KEY: override.apiKey,
      ...(resolved ? { LLM_MODEL: resolved } : {}),
    };
  }

  buildRunCommand(request: RunRequest, context?: RunContext): string[] {
    const cmd: string[] = [];
    if (request.hermetic) {
      // HOME is assigned inside the sandbox command, never the run
      // environment: scode derives its policy from the real home
      // (src/openhands-hermetic.ts). A static preview (verify) passes no
      // context and gets a placeholder path naming no real directory.
      const home = context?.openhandsHermeticHome?.home ??
        join(loginHome(this.environment), ".openhands", ".codemux-hermetic", "unprepared");
      cmd.push("env", `HOME=${home}`);
      // The persistence dir is env-relocatable (locations.py reads
      // OPENHANDS_PERSISTENCE_DIR before ~/.openhands), so an operator
      // who exported it would otherwise steer the private home's run
      // back at real state: settings, agent specs, hooks, microagents,
      // and mcp.json all resolve under it. Both overrides are pinned to
      // the private home, and conversations with them, so no ambient
      // value survives.
      cmd.push(`OPENHANDS_PERSISTENCE_DIR=${join(home, ".openhands")}`,
        `OPENHANDS_CONVERSATIONS_DIR=${join(home, ".openhands", "conversations")}`);
    }
    // --headless is mandatory for non-interactive use and auto-approves on its
    // own, so no autonomy flag is added here: it would be redundant at `high`
    // and misleading at every other level.
    cmd.push("openhands", "--headless");

    // A resolved model — the request's or the override's — exists only through
    // the environment, so the flag rides along whenever there is one. Without
    // a model the flag is absent and OpenHands reads its stored config only —
    // but an operator's exported LLM_BASE_URL/LLM_API_KEY still sit in the
    // environment (see getRunEnv); they are the operator's own OpenHands
    // configuration, not a codemux provider override (review round 153).
    // A hermetic run always carries the override (validateRunRequest), so
    // the flag always rides one there.
    if (this.modelFor(request.model) || request.hermetic) {
      cmd.push("--override-with-envs");
    }

    // 1.16.0 entrypoint.py: json_mode = args.json and args.headless; the
    // JSONL event stream replaces the rich UI output. Plain runs ride it
    // too (lane AN1): the answer is assembled from every agent text event
    // and printed in place of the rich UI's text.
    cmd.push("--json");

    // 1.16.0 has no stdin transport; the task is a file via -f on every
    // launch (prepareRun wrote it), with the argv `--task` spelling as
    // the static-preview fallback (no context, nothing spawned).
    if (context?.openhandsTaskFile !== undefined) {
      cmd.push("--file", context.openhandsTaskFile.path);
    } else {
      cmd.push("--task", request.prompt);
    }
    return cmd;
  }

  /** The real openhands directory the private home's parent lives under. */
  private realOpenhandsDir(): string {
    return join(loginHome(this.environment), ".openhands");
  }

  override prepareRun(
    request: RunRequest,
    _sandboxTrust?: ScodeTrustLevel,
    _sandboxOptions?: SandboxOptions,
    launch: LaunchIntent = {}
  ): RunContext {
    if (request.experimentMcp !== undefined) refuseOpenhandsExperiment();
    // Every launch carries its prompt in a task file (--file): openhands
    // has no stdin transport, and argv would bound the prompt
    // (src/openhands-task-file.ts).
    const taskFile = writeOpenhandsTaskFile(this.realOpenhandsDir(), request.prompt, launch.printOnly);
    if (!request.hermetic) return { openhandsTaskFile: taskFile };
    // Rechecked here, not only in validateRunRequest: the headless gate
    // passes only with env overrides, so a hermetic launch without the
    // override cannot run at all — and prepareRun creates disk state.
    if (this.validatedProvider() === null) {
      taskFile.finalize();
      throw new UsageRefusalError(
        "openhands --hermetic requires the provider override: a private home carries no settings, and headless mode starts only with LLM env overrides (set CODEMUX_OPENHANDS_PROVIDER_BASE_URL and CODEMUX_OPENHANDS_PROVIDER_API_KEY)"
      );
    }
    if (request.cwd === undefined) {
      taskFile.finalize();
      throw new UsageRefusalError("openhands --hermetic requires an explicit --cwd owned by this run");
    }
    const hermeticHome = createOpenhandsHermeticHome(this.realOpenhandsDir(), launch.printOnly);
    const context: RunContext = {
      openhandsTaskFile: taskFile,
      openhandsHermeticHome: hermeticHome,
    };
    // The Playwright carrier plants the trust-checked server in the
    // private persistence dir the env prefix pins (src/openhands-mcp.ts).
    if (request.enablePlaywrightMcp) {
      try {
        context.playwrightMcpCheck = plantOpenhandsPlaywrightMcp(
          join(hermeticHome.home, ".openhands"),
          { pathEnv: this.executionPathEnv(), forbiddenRoot: this.executionWorkingDirectory(request), printOnly: launch.printOnly }
        ).check;
      } catch (error) {
        hermeticHome.finalize();
        taskFile.finalize();
        throw error;
      }
    }
    return context;
  }

  override cleanupRunSync(context?: RunContext): void {
    try {
      context?.openhandsHermeticHome?.finalize();
    } finally {
      context?.openhandsTaskFile?.finalize();
    }
  }

  /** The prompt never rides argv on a launch: it travels in the task
   * file prepareRun owns, so the shared argv rules (the NUL refusal and
   * the argv byte bound) do not apply. A static preview (verify) builds
   * no context and falls back to `--task` in buildRunCommand — it never
   * spawns, so the argv it prints is advisory. */
  override promptInArgv(_request: RunRequest): boolean {
    return false;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  /**
   * OpenHands 1.16 without stored settings prints "Headless mode requires
   * existing settings." and "Goodbye!" to stdout and exits 0 without
   * running the task (live matrix, 2026-11-07). Reported as what it is: a
   * failed run with exit 1 and a diagnostic, never a reply, so a caller
   * reading the exit code or the result envelope cannot count the setup
   * text as the model's answer. Only an exit-0 run is reclassified, and
   * only on the complete startup output (openHandsRanNoTask): a nonzero
   * exit is already a failure, and a reply quoting the phrase is a reply.
   */
  override processRunResult(result: RunResult, request: RunRequest, _context?: RunContext): RunResult {
    // Both result paths replace the --json event stream with the answer,
    // and the parser reads agent text alone; the hermetic check scans the
    // whole stream, tool observations included (stream-marker-scan.ts).
    if (request.resultJson) return withStreamScanSurface(openhandsResult(result, request), result.stdout, undefined);
    if (result.exitCode !== 0 || !openHandsRanNoTask(result.stdout)) {
      return withStreamScanSurface(openhandsPlainResult(result) ?? { ...result, reply: "" }, result.stdout, undefined);
    }
    return {
      ...result,
      success: false,
      exitCode: 1,
      stderr: appendDiagnostic(result.stderr, OPENHANDS_NO_SETTINGS_HINT),
    };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    const workdir = validateWorkingDirectory(request.cwd) ?? process.cwd();
    // The project-settings mode loads the working directory's .openhands
    // on purpose, so the plain-run guard against project execution
    // config does not apply to it; every other run keeps the guard. The
    // shared agent gate passes openhands (PROJECT_SETTINGS_AGENTS) and
    // the shared request validator dispatches to this arm's validator
    // (src/openhands-project-settings.ts).
    if (request.experimentProjectSettings) {
      validateOpenhandsProjectSettings({
        agent: "openhands",
        hermetic: request.hermetic === true,
        autonomy: request.autonomy ?? "read-only",
        sandbox: request.sandboxed === true,
        cwd: workdir,
        tools: request.tools,
        experimentMcp: request.experimentMcp,
        passthroughEnv: request.passthroughEnv,
      });
    } else {
      assertNoOpenHandsProjectExecutionConfig(workdir);
    }
    // The only per-run MCP channel is the private persistence dir a
    // hermetic run owns (src/openhands-mcp.ts): a plain run shares the
    // operator's, and planting there would outlive the run, so the flag
    // is refused instead of silently attaching nothing.
    if (request.enablePlaywrightMcp && !request.hermetic) {
      throw new UsageRefusalError(
        "openhands --enable-playwright-mcp requires --hermetic: openhands resolves MCP servers only from its persistence dir, and only a hermetic run owns a private one"
      );
    }
    // Fail before launch on a half-configured override, and surface the
    // model requirement early: the CLI's stored default model would hit the
    // custom endpoint and fail opaquely.
    this.modelFor(request.model);
    if (request.hermetic) {
      if (this.validatedProvider() === null) {
        throw new UsageRefusalError(
          "openhands --hermetic requires the provider override: a private home carries no settings, and headless mode starts only with LLM env overrides (set CODEMUX_OPENHANDS_PROVIDER_BASE_URL and CODEMUX_OPENHANDS_PROVIDER_API_KEY)"
        );
      }
      if (request.cwd === undefined) {
        throw new UsageRefusalError("openhands --hermetic requires an explicit --cwd owned by this run");
      }
      // The workspace channel the private HOME cannot close: the working
      // directory's .openhands directory (hooks at 1.16.0, and the
      // project-skill tree under it). A dangling symlink counts (lstat):
      // the harness resolves it. The project-settings mode is the
      // exception — loading that directory is its whole point.
      if (!request.experimentProjectSettings) {
        assertCleanInstructionFiles("openhands", validateWorkingDirectory(request.cwd)!, [
          ".openhands",
        ]);
      }
    }
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
    assertNoOpenHandsProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    this.modelFor(model);
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel): string[] {
    const cmd = ["openhands"];
    if (this.modelFor(model)) {
      cmd.push("--override-with-envs");
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  /** The openhands login read: a credential variable in the environment. */
  override loginState(): LoginState {
    return envKeyLoginState(this.id, this.environment);
  }
}
