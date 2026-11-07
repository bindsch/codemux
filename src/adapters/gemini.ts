import { BaseAdapter } from "./base.js";
import { assertNoGeminiProjectExecutionConfig, assertNoGeminiRepositoryEnv } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";
import { geminiLoginState, loginHome, type LoginState } from "../harness-health.js";

export const GEMINI_SYSTEM_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/gemini-system-settings.json", import.meta.url)
);

/** The file reads behind the loadability check, injectable for tests. */
export const geminiSettingsHost = {
  statSync,
  platform: (): NodeJS.Platform => process.platform,
};

/**
 * Whether the Gemini CLI will load codemux's system settings file. The CLI
 * loads the file `GEMINI_CLI_SYSTEM_SETTINGS_PATH` names only when it and
 * every ancestor directory are owned by root; otherwise it prints "Skipping
 * system settings file ... is not owned by root" and loads none of it. A
 * checkout and a Homebrew prefix are user-owned, so the layer, and the
 * `advanced.ignoreLocalEnv` protection it carries, never load there (live
 * matrix, 2026-11-07). An unreadable path counts as not loadable.
 */
export function geminiSystemSettingsLoadable(path: string = GEMINI_SYSTEM_SETTINGS_PATH): boolean {
  if (geminiSettingsHost.platform() === "win32") return true;
  try {
    let current = path;
    for (;;) {
      if (geminiSettingsHost.statSync(current).uid !== 0) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  } catch {
    return false;
  }
}

export class GeminiAdapter extends BaseAdapter {
  // The environment the adapter sees is the one its factory was handed:
  // `verify` passes only PATH so an exported override cannot
  // change its rows, and a run passes the real one.
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    super(environment);
  }
  readonly id: AgentId = "gemini";
  readonly binaryName = "gemini";

  override getEnv(): Record<string, string> {
    // Named only when the CLI will load it: on a user-owned prefix the
    // variable bought a warning on every run and no protection, and the
    // repository .env it was meant to shut out is refused instead
    // (validateRunRequest, assertNoGeminiRepositoryEnv).
    return geminiSystemSettingsLoadable()
      ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: GEMINI_SYSTEM_SETTINGS_PATH }
      : {};
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
      // Exercised live at 0.60.0 on 2026-09-17: nothing closes the
      // workspace context-file channels, so --hermetic is refused, and the
      // tools.core allowlist a --tools none mapping would ride sits in the
      // system-settings layer, which never loads on a user-owned prefix
      // (the file and every ancestor must be root-owned), so the
      // capability is refused rather than claimed on a layer that cannot
      // load; see docs/isolation.md.
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--approval-mode", "plan"];
      case "low":
        return ["--approval-mode", "default"];
      case "medium":
        // auto_edit denies shell commands headless; scode is the boundary.
        return ["--approval-mode", "yolo"];
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
    const workdir = validateWorkingDirectory(request.cwd) ?? process.cwd();
    assertNoGeminiProjectExecutionConfig(workdir);
    if (!geminiSystemSettingsLoadable()) assertNoGeminiRepositoryEnv(workdir);
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
    const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
    assertNoGeminiProjectExecutionConfig(workdir);
    if (!geminiSystemSettingsLoadable()) assertNoGeminiRepositoryEnv(workdir);
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

  /** The gemini login read: the oauth creds file, or an API key. */
  override loginState(): LoginState {
    return geminiLoginState(loginHome(this.environment), this.environment);
  }
}
