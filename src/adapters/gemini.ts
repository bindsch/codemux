import { BaseAdapter } from "./base.js";
import { assertNoGeminiProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  writeGeminiNoToolsSettings,
  type GeminiNoToolsSettings,
} from "../gemini-no-tools.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export const GEMINI_SYSTEM_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/gemini-system-settings.json", import.meta.url)
);

export class GeminiAdapter extends BaseAdapter {
  readonly id: AgentId = "gemini";
  readonly binaryName = "gemini";

  private noToolsSettings: GeminiNoToolsSettings | null = null;
  private readonly noToolsFiles: GeminiNoToolsSettings[] = [];

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super();
  }

  override getEnv(): Record<string, string> {
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH };
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
      // Implemented but unclaimed: exercised live at 0.60.0 on 2026-09-17.
      // The --tools none settings file cannot load on a user-owned prefix
      // (the system-settings layer requires the file and every ancestor to
      // be root-owned), and hermetic has no mechanism at all; see
      // docs/HERMETIC.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Gemini home directory must be an absolute path");
    }
    const home = this.homeDirectory ?? this.environment.HOME;
    return home && isAbsolute(home) ? home : homedir();
  }

  /**
   * The gemini directory a plain run reads: `~/.gemini`, or under the
   * operator's passed-through GEMINI_CLI_HOME (which replaces the home
   * directory gemini derives every path from).
   */
  private realGeminiDir(request: RunRequest): string {
    const passedThrough = request.passthroughEnv?.includes("GEMINI_CLI_HOME") ?? false;
    const configured = this.environment.GEMINI_CLI_HOME?.trim();
    if (passedThrough && configured) {
      if (!isAbsolute(configured)) {
        throw new Error("passed-through GEMINI_CLI_HOME must be an absolute path");
      }
      return join(configured, ".gemini");
    }
    return join(this.effectiveHome(), ".gemini");
  }

  override prepareRun(request: RunRequest): void {
    if (request.tools !== "none") return;
    this.noToolsSettings = writeGeminiNoToolsSettings(
      this.realGeminiDir(request),
      GEMINI_SYSTEM_SETTINGS_PATH
    );
    this.noToolsFiles.push(this.noToolsSettings);
  }

  /** Drops every generated settings file this adapter created. */
  disposeNoToolsSettings(): void {
    for (const file of this.noToolsFiles.splice(0)) file.finalize();
    this.noToolsSettings = null;
  }

  override getRunEnv(request: RunRequest): Record<string, string> {
    if (request.tools !== "none") return {};
    if (this.noToolsSettings === null) {
      throw new Error("gemini tools-none settings file was not prepared before launch");
    }
    return {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: this.noToolsSettings.path,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        return ["--approval-mode", "auto_edit"];
      case "high":
        return ["--approval-mode", "yolo"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["gemini", "--sandbox=false"];

    if (request.model) {
      cmd.push("-m", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    cmd.push("-p", request.prompt);

    return cmd;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoGeminiProjectExecutionConfig(
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
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
    assertNoGeminiProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["gemini", "--sandbox=false"];
    if (model) {
      cmd.push("-m", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
