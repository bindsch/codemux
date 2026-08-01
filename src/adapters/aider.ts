import { BaseAdapter } from "./base.js";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import { assertNoAiderProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

export const AIDER_EMPTY_CONFIG_PATH = fileURLToPath(
  new URL("../../resources/aider-empty.yml", import.meta.url)
);
export const AIDER_MODEL_SETTINGS_PATH = fileURLToPath(
  new URL("../../resources/aider-model-settings.yml", import.meta.url)
);
export const AIDER_MODEL_METADATA_PATH = fileURLToPath(
  new URL("../../resources/aider-model-metadata.json", import.meta.url)
);
const HEADLESS_NEGATIVE_RESPONSES = "n\n".repeat(64);

export class AiderAdapter extends BaseAdapter {
  readonly id: AgentId = "aider";
  readonly binaryName = "aider";

  private baseCommand(): string[] {
    return [
      "aider",
      "--config",
      AIDER_EMPTY_CONFIG_PATH,
      "--env-file",
      devNull,
      "--model-settings-file",
      AIDER_MODEL_SETTINGS_PATH,
      "--model-metadata-file",
      AIDER_MODEL_METADATA_PATH,
      "--input-history-file",
      devNull,
      "--chat-history-file",
      devNull,
      "--no-gitignore",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-analytics",
      "--no-suggest-shell-commands",
      "--no-check-update",
      "--no-show-release-notes",
      "--disable-playwright",
    ];
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--dry-run"];
      case "low":
        return [];
      case "medium":
      case "high":
        return ["--yes-always"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return ["--reasoning-effort", level];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = this.baseCommand();
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    cmd.push(`--message=${request.prompt}`);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    // Aider treats EOF as acceptance for yes-default prompts. Headless runs
    // must explicitly decline OAuth, URL opening, and supervised tool prompts.
    return HEADLESS_NEGATIVE_RESPONSES;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoAiderProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    if (Buffer.byteLength(request.prompt, "utf8") > MAX_ARGV_PROMPT_BYTES) {
      throw new Error(
        `aider passes prompts in argv; prompt exceeds the ${MAX_ARGV_PROMPT_BYTES}-byte safe limit`
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
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    assertNoAiderProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = this.baseCommand();
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}
