import { BaseAdapter } from "./base.js";
import { assertNoCopilotProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

// `--hermetic` has no claimable mechanism: no switch closes every operator
// channel, and the check's control probe can never leak the planted code
// word, because `--no-custom-instructions` ("Disable loading of custom
// instructions from AGENTS.md and related files", 1.0.85 `--help`) rides
// every codemux run — dropping the flag from plain runs to let the control
// leak would un-harden them, so the two-probe check has no way to verify
// any candidate mechanism (docs/HERMETIC.md records the control's answer
// "Peter" on the 2026-09-17 live pass, a leak of the user-skill channel).
// A private-home mechanism the branch implemented behind the refusal was
// removed in 0.7.0 as dead surface; the refusal stands.

// `--tools none` has no mapping: `--available-tools` is the documented
// model-visible allowlist ("Only these tools will be available to the model",
// 1.0.85 --help), but no argv spelling of an empty allowlist disarms the
// tools — verified live at 1.0.85 through the provider override, where a
// bare `--available-tools`, `--available-tools=`, and `--available-tools ""`
// all left the read and shell tools armed (the probes produced the planted
// secret and a true byte count under every spelling). See docs/HERMETIC.md.

export class CopilotAdapter extends BaseAdapter {
  readonly id: AgentId = "copilot";
  readonly binaryName = "copilot";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      // Both refusals verified live at 1.0.85 through the provider
      // override. Hermetic: the check's control probe can never leak the
      // planted code word, because --no-custom-instructions rides every
      // codemux run — and dropping the flag from plain runs to let the
      // control leak would un-harden them, so the two-probe check has no
      // way to verify the private-home mechanism (docs/HERMETIC.md records
      // the control's answer "Peter", a live leak of the user-skill
      // channel, which the check cannot credit because it plants its code
      // word elsewhere). Tools: no argv spelling of an empty
      // --available-tools allowlist disarms the tools.
      supportsHermetic: false,
      supportsToolSelection: false,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--plan"];
      case "low":
        return ["--allow-tool", "read"];
      case "medium":
        return ["--allow-all-tools"];
      case "high":
        return ["--allow-all"];
    }
  }

  override mapEffort(level: ReasoningEffort): string[] {
    // `--reasoning-effort`, not `--effort`. `--effort` was a shorthand alias upstream added in
    // v1.0.10 and has since dropped; `--reasoning-effort` has been the canonical flag since
    // v1.0.4. Codemux kept passing the alias, so every `codemux run -a copilot --effort <level>`
    // failed on an unknown option. The
    // installed-contract suite pins the real name and `make release-gate` runs it on every PR. It
    // caught nothing because it skips a binary absent from the machine, and no machine in the loop
    // had copilot installed -- CI runners carry no harness CLIs.
    //
    // Verified 2026-09-21 against copilot 1.0.85's own `--help`: it lists
    // `--reasoning-effort <level>` with `[possible values: none, minimal, low, medium, high,
    // xhigh, max]` and no `--effort`. The values are unchanged, so the level passes through raw --
    // unlike Droid, which maps `none` to `off` for the same flag name. An end-to-end run was not
    // possible here: copilot needs a writable cache under ~/Library/Caches that the sandbox
    // denies, which is a pre-existing environment limit unrelated to this flag.
    return ["--reasoning-effort", level];
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd: string[] = [
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
    ];
    if ((request.autonomy ?? "read-only") !== "high") {
      cmd.push("--disable-builtin-mcps");
    }
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }
    cmd.push(`--prompt=${request.prompt}`);
    cmd.push("--silent");
    return cmd;
  }

  override getStdinInput(_request: RunRequest): string | null {
    return null;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCopilotProjectExecutionConfig(
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
    assertNoCopilotProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
    _sandboxed?: boolean
  ): string[] {
    const cmd = [
      "copilot",
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
    ];
    if ((autonomy ?? "read-only") !== "high") {
      cmd.push("--disable-builtin-mcps");
    }
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
