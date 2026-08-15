import { BaseAdapter } from "./base.js";
import { assertNoOpenHandsProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

/**
 * OpenHands CLI (`openhands`), audited against 1.16.0.
 *
 * Two properties shape this adapter, both verified against the installed CLI:
 *
 * Non-interactive runs require `--headless`, which the CLI documents as
 * "no UI output, auto-approve actions". There is no headless mode that keeps an
 * approval gate, so a headless run has no native restraint at any level and the
 * boundary is entirely scode's. Interactive sessions default to `always-ask`,
 * which confirms every action.
 *
 * `--llm-approve` is deliberately never emitted. It confirms only the actions an
 * LLM predicts are high-risk, which is not a weaker form of human approval but a
 * different mechanism, and Codemux will not advertise it as one of its graded
 * levels. `--always-approve` is the honest mapping for `high`.
 *
 * There is no `--model` flag. Model selection exists only through
 * `--override-with-envs`, which makes the CLI read LLM_MODEL, LLM_API_KEY, and
 * LLM_BASE_URL from the environment it would otherwise ignore.
 */
export class OpenHandsAdapter extends BaseAdapter {
  readonly id: AgentId = "openhands";
  readonly binaryName = "openhands";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      // Only via --override-with-envs; there is no model flag.
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // 1.16.0 exposes no reasoning-effort control.
      supportsEffort: false,
      effortLevels: [],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // Interactive only. `read-only`, `low`, and `medium` all leave the CLI in
    // its default always-ask mode and are separated by the scode policy that
    // each of them requires.
    return level === "high" ? ["--always-approve"] : [];
  }

  /** The environment is ignored unless --override-with-envs is passed. */
  override getRunEnv(request: RunRequest): Record<string, string> {
    return request.model ? { LLM_MODEL: request.model } : {};
  }

  override getTuiEnv(model?: string): Record<string, string> {
    return model ? { LLM_MODEL: model } : {};
  }

  buildRunCommand(request: RunRequest): string[] {
    // --headless is mandatory for non-interactive use and auto-approves on its
    // own, so no autonomy flag is added here: it would be redundant at `high`
    // and misleading at every other level.
    const cmd = ["openhands", "--headless"];

    if (request.model) {
      cmd.push("--override-with-envs");
    }

    // 1.16.0 has no stdin transport; the task is an argv value that BaseAdapter
    // bounds, or a file via -f.
    cmd.push("--task", request.prompt);
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoOpenHandsProjectExecutionConfig(
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
    assertNoOpenHandsProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel): string[] {
    const cmd = ["openhands"];
    if (model) {
      cmd.push("--override-with-envs");
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
