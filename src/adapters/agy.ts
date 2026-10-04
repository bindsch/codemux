import { BaseAdapter } from "./base.js";
import { assertNoAgyProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import { agyResult } from "../result-envelope.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

/**
 * Google Antigravity CLI (`agy`), pinned against 1.2.14 -- the binary
 * installed while this adapter was written -- and the official docs
 * (https://antigravity.google/docs/cli/overview,
 * https://antigravity.google/docs/cli/headless).
 *
 * Flag forms are load-bearing here: agy pre-parses its enum flags
 * (`--effort`, `--mode`, `--input-format`, `--output-format`) and rejects
 * the space form outright (`--effort high` exits 2 with "flags provided
 * but not defined: -effort high"), so the adapter always emits
 * `--flag=value` for those. `--model` rides in the same single-token form:
 * its space form was never exercised against the pinned 1.2.14 while its
 * sibling value flags reject theirs, and the `=`-form is the one the live
 * captures ran. The prompt rides in argv as `--print=<prompt>` (verified
 * to parse; keeps a leading-dash prompt inside the option), which leaves
 * stdin closed and lets BaseAdapter's argv prompt guards apply.
 *
 * An unrecognized `--mode` value only warns and continues with the
 * default mode, so this adapter must never emit a value outside
 * {plan, accept-edits} -- a typo would silently change autonomy rather
 * than fail the launch.
 */
export class AgyAdapter extends BaseAdapter {
  readonly id: AgentId = "agy";
  readonly binaryName = "agy";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      // 1.2.14's help lists low|medium|high|xhigh|max; the official docs
      // table names only low/medium/high. The binary is the contract, so
      // all five are accepted and the docs gap is recorded in the ledger.
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      // --output-format=json (the `=` form the class comment requires)
      // prints the documented result envelope (status/response/usage);
      // see result-envelope.ts.
      supportsResultJson: true,
      // No verified hermetic mode and no tool-removal flag; see
      // docs/HERMETIC.md for both refusals.
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--mode=plan"];
      case "low":
        // Default prompting. Headless turns unverifiable approvals into
        // soft denials and still exits 0, so the boundary is scode's.
        return [];
      case "medium":
        return ["--mode=accept-edits"];
      case "high":
        return ["--dangerously-skip-permissions"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    // `=` form; see the class comment.
    return [`--effort=${level}`];
  }

  buildRunCommand(request: RunRequest): string[] {
    // Slash commands and skills are prompt text to codemux, not a command
    // surface, so print mode never expands them.
    const cmd = ["agy", "--disable-slash-commands"];

    if (request.model) {
      cmd.push(`--model=${request.model}`);
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.resultJson) {
      cmd.push("--output-format=json");
    }

    cmd.push(`--print=${request.prompt}`);
    return cmd;
  }

  override processRunResult(result: RunResult, request: RunRequest): RunResult {
    if (!request.resultJson) return result;
    return agyResult(result, request);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoAgyProjectExecutionConfig(
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
    assertNoAgyProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = ["agy"];
    if (model) {
      cmd.push(`--model=${model}`);
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }
}
