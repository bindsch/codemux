import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import { assertNoKimiProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import {
  writeKimiNoToolsFile,
  type KimiNoToolsFile,
} from "../kimi-no-tools.js";
import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

/**
 * Kimi Code CLI (`kimi`), audited against 0.31.1.
 *
 * Autonomy maps onto three native switches in interactive sessions: the default
 * asks before acting, `--yolo` auto-approves tool calls while still asking
 * questions, `--auto` removes the questions too, and `--plan` is the read-only
 * equivalent. None of them may be combined with `--prompt`, so headless runs
 * carry no native control and depend on the scode boundary that every level
 * below `high` already requires.
 *
 * `--tools none`: no flag removes kimi's tools, but an agent definition's
 * `tools: []` frontmatter is the profile's own allowlist, and the tool
 * manager's gates are strict membership tests, so an empty list exposes no
 * built-in and no MCP tool (see src/kimi-no-tools.ts for the grounding). The
 * file's required prompt body is `${base_prompt}`, the default profile's own
 * prompt, so the run keeps kimi's base instructions. The capability stays
 * unclaimed until the live probe runs: kimi hit its weekly usage limit on
 * 2026-09-17.
 */
export class KimiAdapter extends BaseAdapter {
  readonly id: AgentId = "kimi";
  readonly binaryName = "kimi";

  private noToolsFile: KimiNoToolsFile | null = null;
  // Every file this adapter created and has not disposed; earlier runs
  // through the same instance may still be using theirs.
  private readonly noToolsFiles: KimiNoToolsFile[] = [];

  // Seams so tests can point the real brand home at a scratch directory.
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
      // 0.31.1 exposes no reasoning-effort or thinking-budget control.
      supportsEffort: false,
      effortLevels: [],
      // Implemented but not claimed: the capability probe needs usage
      // headroom (see docs/HERMETIC.md).
      supportsToolSelection: false,
    };
  }

  /**
   * The brand home whose `.codemux/` holds the generated agent file: the one
   * a plain run of this request reads config.toml, skills and agents from.
   * The sanitized child environment drops KIMI_CODE_HOME unless the operator
   * passes it through with --pass-env, in which case both kinds of run use
   * that directory.
   */
  private realBrandHome(request: RunRequest): string {
    const passedThrough =
      request.passthroughEnv?.includes("KIMI_CODE_HOME") ?? false;
    const configured = this.environment.KIMI_CODE_HOME?.trim();
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("KIMI_CODE_HOME must be an absolute path");
      }
      return configured;
    }
    return join(this.effectiveHome(), ".kimi-code");
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Kimi home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  override prepareRun(request: RunRequest): void {
    if (request.tools !== "none") return;
    this.noToolsFile = writeKimiNoToolsFile(this.realBrandHome(request));
    this.noToolsFiles.push(this.noToolsFile);
  }

  /** Drops every generated agent file this adapter created. */
  disposeNoToolsFiles(): void {
    for (const file of this.noToolsFiles.splice(0)) file.finalize();
    this.noToolsFile = null;
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        // The default already prompts before each tool call.
        return [];
      case "medium":
        return ["--yolo"];
      case "high":
        return ["--auto"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["kimi"];

    if (request.model) {
      cmd.push("--model", request.model);
    }
    // 0.31.1 rejects --plan, --yolo, and --auto when combined with --prompt
    // ("Cannot combine --prompt with --plan"), verified against the installed
    // binary. Headless Kimi therefore has no native autonomy control at all,
    // and the level is enforced entirely by the scode boundary that every level
    // below `high` already requires. The flags below are interactive-only and
    // are applied in buildTuiCommand.

    if (request.tools === "none") {
      // A static preview (`verify`) has no prepared file; the placeholder
      // path does not exist, and kimi fails to read it, so a command built
      // without prepareRun fails closed.
      const unprepared = join(
        this.realBrandHome(request),
        ".codemux",
        "unprepared"
      );
      cmd.push("--agent-file", this.noToolsFile?.path ?? unprepared);
    }

    // 0.31.1 has no stdin transport: the prompt is an argv value. BaseAdapter
    // bounds its length, the same as the other argv-only harnesses.
    cmd.push("--prompt", request.prompt);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoKimiProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
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
    assertNoKimiProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel): string[] {
    const cmd = ["kimi"];
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
