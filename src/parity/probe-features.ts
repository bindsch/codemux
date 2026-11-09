import type { ProbeLetter } from "../../scripts/live-gate/probes.js";
import type { ParityFeature } from "./features.js";

/** Null denotes a probe that applies to every agent. */
export const PROBE_FEATURE: Readonly<Record<ProbeLetter, ParityFeature | null>> = {
  A: null, B: null, C: "run.result-json", D: "check.hermetic",
  E: "run.tools-none", F: "session.driver", G: "run.experiment-mcp",
  H: "check.provider-override.served-model", H2: "run.provider-override",
  I: "run.model", I2: "run.effort", J: null, K: "session.hermetic", P: null,
};

export interface RefusalFeature {
  file: string;
  /** Stable literal part of the actual validation message, without interpolation. */
  message: string;
  feature: ParityFeature;
}

const base = "src/adapters/base-validate.ts";
const options = "src/cli-runtime/options.ts";
const session = "src/session/cli-request.ts";
const run = "src/run-command.ts";
const tui = "src/tui-command.ts";
const check = "src/check-command.ts";
const experiment = "src/experiment-mcp.ts";

/** Capability refusals only: malformed values and incompatible flag pairs
 * that apply uniformly are not harness limitations. Repeated entries bind a
 * shared refusal to each separately declared command or conditional feature. */
export const REFUSAL_FEATURE: readonly RefusalFeature[] = [
  { file: base, message: "does not support model selection", feature: "run.model" },
  { file: base, message: "does not support autonomy level", feature: "run.autonomy.all-four" },
  { file: base, message: "does not support reasoning effort", feature: "run.effort" },
  { file: base, message: "does not support reasoning effort", feature: "run.effort.none-native" },
  { file: base, message: "--enable-playwright-mcp is supported only by", feature: "run.playwright-mcp" },
  { file: base, message: "cannot return a structured result envelope", feature: "run.result-json" },
  { file: base, message: "has no spend limit flag", feature: "run.max-budget-usd" },
  { file: base, message: "has no verified hermetic mode", feature: "run.hermetic" },
  { file: base, message: "cannot remove its built-in tools", feature: "run.tools-none" },
  { file: base, message: "cannot pass a NUL byte in an argv prompt", feature: "run.prompt-stdin" },
  { file: base, message: "passes prompts in argv; prompt exceeds the", feature: "run.prompt-stdin" },
  { file: base, message: "does not support model selection in TUI mode", feature: "tui.model" },
  { file: base, message: "in TUI mode", feature: "tui.effort" },
  { file: options, message: "cannot enforce requested autonomy", feature: "run.autonomy.all-four" },
  { file: options, message: "does not support autonomy level", feature: "run.autonomy.all-four" },
  { file: options, message: "does not support reasoning effort", feature: "run.effort" },
  { file: run, message: "--enable-playwright-mcp is supported only by", feature: "run.playwright-mcp" },
  { file: run, message: "--no-web applies to the", feature: "run.no-web" },
  { file: run, message: "does not support model selection", feature: "run.model" },
  { file: run, message: "autonomy without --sandbox", feature: "run.autonomy.all-four" },
  { file: tui, message: "--enable-playwright-mcp is supported only by", feature: "run.playwright-mcp" },
  { file: tui, message: "does not support model selection in TUI mode", feature: "tui.model" },
  { file: tui, message: "does not carry --effort in TUI mode", feature: "tui.effort" },
  { file: tui, message: "autonomy without --sandbox", feature: "run.autonomy.all-four" },
  { file: check, message: "does not support model selection", feature: "run.model" },
  { file: check, message: "autonomy without --sandbox", feature: "run.autonomy.all-four" },
  { file: check, message: "check --hermetic --tools none cannot run for", feature: "run.tools-none.plain" },
  { file: session, message: "sessions are not implemented for", feature: "session.driver" },
  { file: session, message: "--tools none is refused for sessions", feature: "session.tools" },
  { file: session, message: "--tools is not implemented for", feature: "session.tools" },
  { file: session, message: "--enable-playwright-mcp is supported only by", feature: "session.playwright-mcp" },
  { file: session, message: "--enable-playwright-mcp is not implemented for", feature: "session.playwright-mcp" },
  { file: session, message: "low has no caller approval bridge", feature: "session.playwright-mcp" },
  { file: session, message: "--enable-playwright-mcp cannot be combined with --hermetic --experiment-project-settings", feature: "session.playwright-mcp" },
  { file: session, message: "--harness-home is not implemented for", feature: "session.harness-home" },
  { file: session, message: "has no verified hermetic mode for sessions", feature: "session.hermetic" },
  { file: session, message: "has no verified hermetic mode for sessions", feature: "session.private-home" },
  { file: session, message: "has no verified hermetic mode for sessions", feature: "session.final" },
  { file: session, message: "--experiment-project-settings applies to the", feature: "session.experiment-project-settings" },
  { file: session, message: "--experiment-project-settings is not implemented for", feature: "session.experiment-project-settings" },
  { file: session, message: "--permission-policy deny", feature: "session.permission-policy-deny" },
  { file: session, message: "--print-sandbox is not available for this agent", feature: "session.print-sandbox" },
  { file: session, message: "--turn-timeout requires an agent whose sessions support interrupt", feature: "session.interrupt" },
  { file: session, message: "does not support model selection", feature: "run.model" },
  { file: session, message: "autonomy without --sandbox", feature: "run.autonomy.all-four" },
  { file: "src/adapters/base.ts", message: "does not support a provider override", feature: "run.provider-override" },
  { file: "src/adapters/base.ts", message: "does not support a provider override", feature: "session.provider-override" },
  { file: "src/adapters/base.ts", message: "does not support a provider override", feature: "tui.provider-override" },
  { file: "src/provider-override.ts", message: "cannot be honored:", feature: "run.provider-override.max-output-tokens" },
  { file: "src/provider-override.ts", message: "cannot be honored:", feature: "run.provider-override.max-context-tokens" },
  { file: "src/check-hermetic-plan.ts", message: "does not support a hermetic instruction check", feature: "check.hermetic" },
  { file: "src/check-hermetic-plan.ts", message: "check --hermetic cannot run for", feature: "check.hermetic" },
  { file: "src/hermetic-session-canary.ts", message: "has no session driver", feature: "session.driver" },
  { file: "src/hermetic-session-canary.ts", message: "has no verified hermetic mode", feature: "session.hermetic" },
  { file: "src/claude-project-settings.ts", message: "has no project setting source mapping", feature: "run.experiment-project-settings" },
  { file: experiment, message: "has no verified experiment MCP mechanism", feature: "run.experiment-mcp" },
  { file: experiment, message: "requires accept_harness_prefix:", feature: "run.experiment-mcp" },
  { file: experiment, message: "requires accept_harness_schema:", feature: "run.experiment-mcp" },
  { file: experiment, message: "uses a loopback HTTP relay and refuses --sandbox-no-net", feature: "run.experiment-mcp" },
  { file: experiment, message: "uses a loopback HTTP relay and refuses --sandbox-trust untrusted", feature: "run.experiment-mcp" },
  { file: "src/codex-no-tools.ts", message: "requires an explicit --model", feature: "run.tools-none.writable-autonomy" },
  { file: "src/codex-no-tools.ts", message: "cannot prepare its native model catalog", feature: "run.tools-none.writable-autonomy" },
  { file: "src/codex-no-tools.ts", message: "requires a sandbox-readable catalog file", feature: "run.tools-none.writable-autonomy" },
  { file: "src/codex-no-tools.ts", message: "requires verified Codex", feature: "run.tools-none.writable-autonomy" },
  { file: "src/adapters/opencode.ts", message: "opencode --tools none requires --hermetic", feature: "run.tools-none.plain" },
  { file: "src/adapters/gemini.ts", message: "gemini cannot set provider max-context-tokens", feature: "run.provider-override.max-context-tokens" },
  ...(["agy", "aider", "droid", "gemini", "goose", "openhands"] as const).map((name): RefusalFeature => ({
    file: `src/adapters/${name}.ts`, message: "requires an explicit --cwd owned by this run", feature: "run.hermetic.any-cwd",
  })),
];
