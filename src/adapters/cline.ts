import { BaseAdapter } from "./base.js";
import type { LaunchIntent } from "../types.js";
import { assertNoClineProjectExecutionConfig } from "../project-safety.js";
import { withStreamScanSurface } from "../stream-marker-scan.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import { clineResult } from "../result-envelope/cline.js";
import { CLINE_PROVIDER, clineProvider, createClineConfig, type ClineRunContext } from "../cline-config.js";
import { loginHome } from "../harness-health.js";
import { join } from "node:path";
import { assertCleanInstructionFiles } from "../clean-cwd.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import { validateClineProjectSettings } from "../cline-project-settings.js";
import { assertClineToolIsolation, assertClineToolVersion } from "../cline-experiment-policy.js";
import { readExperimentRunSpec } from "../experiment-mcp.js";
import { ClineExperimentRun } from "../cline-experiment-run.js";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions, type ScodeTrustLevel } from "../sandbox.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
} from "../types.js";

export class ClineAdapter extends BaseAdapter {
  // The environment the adapter sees is the one its factory was handed:
  // `verify` passes only PATH so an exported override cannot
  // change its rows, and a run passes the real one.
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }
  readonly id: AgentId = "cline";
  readonly binaryName = "cline";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "low", "medium", "high", "xhigh"],
      supportsHermetic: true,
      hermeticRequiresProviderOverride: true,
      supportsToolSelection: true,
      supportsResultJson: true,
      supportsProviderOverride: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        return ["--auto-approve", "false"];
      case "medium":
      case "high":
        return ["--auto-approve", "true"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--thinking", level];
  }

  buildRunCommand(request: RunRequest, context?: ClineRunContext): string[] {
    // Exact-name tool denial must not silently miss a new builtin. The list
    // was read at cli-v3.0.74; unknown/newer binaries need a fresh source audit.
    if (request.tools === "none" && context) assertClineToolVersion(context.harnessVersion);
    if (request.experimentMcp && !context?.experimentCline?.isPrepared) throw new Error("cline experiment was not prepared before command construction");
    const cmd = ["cline", "--json"];
    const provider = clineProvider(this.environment);
    if (provider !== null) cmd.push("--provider", CLINE_PROVIDER);
    if (request.model ?? provider?.model) {
      cmd.push("--model", (request.model ?? provider?.model)!);
    }
    // Static verify builds argv with no context at all and writes no
    // state (the agy pattern): it names an unprepared placeholder. Every
    // launch passes the context prepareRun returned, and a context without
    // a prepared configuration still refuses here and in getRunEnv.
    const hermeticHome = request.hermetic
      ? context === undefined
        ? join(loginHome(this.environment), ".cline", ".codemux-unprepared")
        : context.clineConfig?.home
      : undefined;
    if (request.hermetic) {
      if (context !== undefined && !context.clineConfig) throw new Error("cline hermetic launch has no prepared configuration");
      cmd.push("--config", context?.clineConfig?.configDir ?? join(hermeticHome!, ".cline"));
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    // cli-v3.0.74 main.ts:794 checks for an argv prompt before reading stdin.
    // A space satisfies that guard without exposing the caller's prompt in argv.
    // main.ts:1142-1152 appends the piped prompt after two newlines (read 2026-11-09):
    // https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/main.ts#L1142-L1152
    cmd.push("--", " ");
    // Keep the private HOME authoritative when a check adds its control HOME.
    return request.hermetic ? ["env", `HOME=${hermeticHome!}`, ...cmd] : cmd;
  }

  override getStdinInput(request: RunRequest): string { return request.prompt; }

  override processRunResult(result: RunResult, request: RunRequest, context?: ClineRunContext): RunResult {
    // The answer replaces the --json capture; the hermetic check scans the
    // whole capture, tool results included (stream-marker-scan.ts).
    return withStreamScanSurface(clineResult(result, request, context?.experimentCline?.recordingPath ?? null,
      context?.experimentCline?.scanSurface()), result.stdout, context?.stdoutSink);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    clineProvider(this.environment);
    const cwd = validateWorkingDirectory(request.cwd) ?? process.cwd();
    if (request.tools === "none") {
      if (clineProvider(this.environment) === null) throw new UsageRefusalError("cline --tools none requires an explicit custom provider override");
      if (request.passthroughEnv?.some((name) => name.startsWith("CLINE_") || name.startsWith("OneDrive"))) {
        throw new UsageRefusalError("cline --tools none cannot combine with native configuration passthrough overrides");
      }
      const home = loginHome(this.environment);
      const control = request.experimentMcp && readExperimentRunSpec(request).control === true;
      assertClineToolIsolation({ cwd, home,
        configDir: join(home, ".cline"), checkGlobal: !request.hermetic && !control, providerId: CLINE_PROVIDER });
    }
    if (request.experimentProjectSettings) validateClineProjectSettings({
      agent: "cline", hermetic: request.hermetic === true, sandbox: request.sandboxed === true,
      autonomy: request.autonomy ?? "read-only", cwd, tools: request.tools,
      experimentMcp: request.experimentMcp, passthroughEnv: request.passthroughEnv,
    });
    if (request.hermetic) {
      if (!request.cwd) throw new UsageRefusalError("cline --hermetic requires an explicit --cwd owned by this run");
      // cli-v3.0.74 has no project discovery suppression switch (read 2026-11-09):
      // https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L495-L639
      if (!request.experimentProjectSettings) {
        assertCleanInstructionFiles("cline", cwd, ["AGENTS.md", ".cline", ".clinerules", ".agents", ".claude/skills"]);
      }
      if (clineProvider(this.environment) === null) {
        throw new UsageRefusalError("cline --hermetic requires a provider override for the private configuration");
      }
    }
    if (!request.experimentProjectSettings) assertNoClineProjectExecutionConfig(cwd);
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
    clineProvider(this.environment);
    assertNoClineProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["cline", "--tui"];
    const provider = clineProvider(this.environment);
    if (provider !== null) cmd.push("--provider", CLINE_PROVIDER);
    if (model ?? provider?.model) {
      cmd.push("--model", (model ?? provider?.model)!);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }

  override resultModel(request: RunRequest): string | undefined {
    return request.model ?? clineProvider(this.environment)?.model;
  }

  private validatedProvider() { return clineProvider(this.environment); }

  override providerOverrideIssue(): string | null {
    try { this.validatedProvider(); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  override prepareRun(request: RunRequest, _trust?: ScodeTrustLevel, sandbox?: SandboxOptions, launch: LaunchIntent = {}): ClineRunContext {
    if (launch.printOnly && request.experimentMcp) throw new UsageRefusalError("Cline experiment MCP cannot be prepared for a print-only preview");
    const playwright = buildPlaywrightSandboxMcp(request.sandboxed,
      { enabled: request.enablePlaywrightMcp, pathEnv: this.environment.PATH ?? "", forbiddenRoot: request.cwd });
    const context: ClineRunContext = request.hermetic || request.tools === "none" || request.web === false || request.enablePlaywrightMcp || clineProvider(this.environment) !== null
      ? { clineConfig: createClineConfig(join(loginHome(this.environment), ".cline"), this.environment,
        { printOnly: launch.printOnly, model: request.model, hermetic: request.hermetic || Boolean(request.experimentMcp), noWeb: request.web === false, toolsNone: request.tools === "none",
          ...(playwright.args[1] ? { mcpServers: JSON.parse(playwright.args[1]).mcpServers } : {}) }),
        playwrightMcpCheck: playwright.check } : {};
    try {
      if (request.experimentMcp) {
        const spec = readExperimentRunSpec(request);
        if ((!request.hermetic && !spec.control) || request.tools !== "none" || request.autonomy !== "read-only" || !request.sandboxed) {
          throw new UsageRefusalError("cline --experiment-mcp requires --hermetic, --tools none, and the scode sandbox");
        }
        context.experimentCline = new ClineExperimentRun(spec, request.cwd ?? process.cwd(),
          context.clineConfig!.configDir, this.environment, request.prompt);
        context.stdoutSink = context.experimentCline;
        context.experimentRecording = context.experimentCline.recordingPath;
      }
      if (sandbox && context.clineConfig) {
        const directories = [...(sandbox.harnessStateDirs ?? []), context.clineConfig.home];
        assertNoCallerBlockOverStateDirs(sandbox.blockPaths ?? [], directories);
        sandbox.harnessStateDirs = directories;
      }
      return context;
    } catch (error) { this.cleanupRunSync(context); throw error; }
  }

  override getRunEnv(request: RunRequest, context?: ClineRunContext): Record<string, string> {
    if ((request.hermetic || request.web === false || request.enablePlaywrightMcp || clineProvider(this.environment) !== null) && !context?.clineConfig) {
      throw new Error("cline launch has no prepared configuration");
    }
    return { ...context?.clineConfig?.env, ...context?.experimentCline?.env };
  }

  override cleanupRunSync(context?: ClineRunContext): void {
    try { context?.experimentCline?.closeSync(); } finally { context?.clineConfig?.finalize(); }
  }

  override cleanupRun(context?: ClineRunContext): void | Promise<void> {
    if (context?.experimentCline) return context.experimentCline.close().finally(() => this.cleanupRunSync(context));
    this.cleanupRunSync(context);
  }

  override prepareTuiEnvironment(model?: string, _autonomy?: AutonomyLevel, _effort?: ReasoningEffort,
    _sandboxed?: boolean, _passthroughEnv?: readonly string[], printOnly = false) {
    if (clineProvider(this.environment) === null) return { env: {}, finalize: () => {} };
    const config = createClineConfig(join(loginHome(this.environment), ".cline"), this.environment, { model, printOnly });
    return { env: config.env, finalize: config.finalize };
  }
}
