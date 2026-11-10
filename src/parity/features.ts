import type { AgentId } from "../types.js";

/** Public capability cells. Conditional support has its own narrower cell. */
export const PARITY_FEATURES = [
  "run.model", "run.autonomy.all-four", "run.effort", "run.effort.none-native",
  "run.hermetic", "run.hermetic.any-cwd",
  "run.tools-none", "run.tools-none.writable-autonomy", "run.tools-none.plain",
  "run.result-json", "run.empty-answer-fails", "run.answer-complete", "run.served-model-evidence", "run.max-budget-usd",
  "run.provider-override", "run.provider-override.max-output-tokens",
  "run.provider-override.max-context-tokens", "run.no-web",
  "run.experiment-project-settings", "run.experiment-mcp", "run.playwright-mcp",
  "run.prompt-stdin", "run.usage", "run.cost",
  "check.experiment-mcp", "check.hermetic", "check.provider-override.served-model",
  "tui.model", "tui.effort", "tui.provider-override",
  "session.driver", "session.interrupt", "session.resume", "session.tools",
  "session.provider-override", "session.experiment-project-settings",
  "session.permission-policy-deny", "session.print-sandbox", "session.playwright-mcp",
  "session.usage", "session.hermetic", "session.final", "session.private-home", "session.harness-home",
  "session.empty-answer-fails",
] as const;

export type ParityFeature = (typeof PARITY_FEATURES)[number];
export type RunFeature = Extract<ParityFeature, `run.${string}` | `check.${string}`>;
export type TuiFeature = Extract<ParityFeature, `tui.${string}`>;
export type SessionFeature = Extract<ParityFeature, `session.${string}`>;
export type ParityTest = `tests/${string}.test.ts`;

export type FeatureState =
  | { state: "supported"; test: ParityTest; note?: string }
  | { state: "harness-limitation"; reason: string; evidence: string; refusal: string; test: ParityTest };

export type ParityDeclaration = Readonly<Record<AgentId, Readonly<Record<ParityFeature, FeatureState>>>>;

export function supported(test: ParityTest, note?: string): FeatureState {
  return { state: "supported", test, ...(note === undefined ? {} : { note }) };
}

export function limitation(reason: string, evidence: string, refusal: string, test: ParityTest): FeatureState {
  return { state: "harness-limitation", reason, evidence, refusal, test };
}

/** Every session agent opens a caller-owned home; the per-agent recipes are in src/session/harness-home.ts. */
export function sessionHarnessHome(agent: AgentId): FeatureState {
  if (agent === "claude" || agent === "zai" || agent === "codex") {
    return supported("tests/session-cli-harness-home-launch.test.ts");
  }
  if (agent === "cline") {
    return supported("tests/session-cli-cline-harness-home.test.ts",
      "Requires a provider override: Cline's provider settings file stores API keys beside settings. Requested options ride overlay files under <home>/.cline.");
  }
  return supported("tests/session-harness-home-agents.test.ts",
    "Caller-owned native roots preserve settings and login links; mixed credential stores require a provider override.");
}
