import type { TuiValidationInput } from "../adapters/base-validate.js";
import type { SessionCommandOptions } from "../session/cli-request.js";
import type { RunRequest } from "../types.js";
import type { ParityFeature } from "./features.js";

type OptionFeature = ParityFeature | "every-agent";

/** A new request field must declare its parity scope before type checking passes. */
export const RUN_OPTION_FEATURE = {
  agent: "every-agent", prompt: "every-agent", labels: "every-agent", cwd: "every-agent",
  model: "run.model", autonomy: "run.autonomy.all-four", effort: "run.effort",
  sandboxed: "every-agent", sandboxNoNet: "every-agent", sandboxTrust: "every-agent",
  timeoutMs: "every-agent", passthroughEnv: "every-agent",
  enablePlaywrightMcp: "run.playwright-mcp", hermetic: "run.hermetic",
  experimentMcp: "run.experiment-mcp", experimentProjectSettings: "run.experiment-project-settings",
  web: "run.no-web", resultJson: "run.result-json", maxBudgetUsd: "run.max-budget-usd",
  tools: "run.tools-none", instructionDirs: "check.hermetic", kimiControlBrandHome: "check.experiment-mcp",
  // The alias is the -m value as typed when config.models holds it: a
  // report field every agent carries, not a harness feature.
  modelAlias: "every-agent",
} satisfies Record<keyof RunRequest, OptionFeature>;

export const SESSION_OPTION_FEATURE = {
  agent: "session.driver", model: "run.model", resume: "session.resume", auto: "run.autonomy.all-four",
  effort: "run.effort", cwd: "every-agent", timeout: "every-agent", turnTimeout: "session.interrupt",
  permissionTimeout: "every-agent", shutdownGrace: "every-agent", authorPrefix: "every-agent",
  tools: "session.tools", enablePlaywrightMcp: "session.playwright-mcp", passEnv: "every-agent",
  hermetic: "session.hermetic", experimentProjectSettings: "session.experiment-project-settings",
  harnessHome: "session.harness-home",
  final: "session.final", permissionPolicy: "session.permission-policy-deny", sandbox: "every-agent",
  sandboxTrust: "every-agent", sandboxNoNet: "every-agent", sandboxScrubEnv: "every-agent",
  sandboxStrict: "session.sandbox-strict",
  sandboxBlock: "every-agent", printSandbox: "session.print-sandbox", quotaCeiling: "every-agent",
  quotaGate: "every-agent",
} satisfies Record<keyof SessionCommandOptions, OptionFeature>;

export const TUI_OPTION_FEATURE = {
  model: "tui.model", autonomy: "run.autonomy.all-four", effort: "tui.effort",
  passthroughEnv: "every-agent", enablePlaywrightMcp: "run.playwright-mcp", cwd: "every-agent",
} satisfies Record<keyof TuiValidationInput, OptionFeature>;
