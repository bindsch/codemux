import { AGENT_IDS, type AgentId } from "../types.js";
import { RUN_DECLARATIONS } from "./declarations-run.js";
import { SESSION_DECLARATIONS } from "./declarations-session.js";
import { TUI_DECLARATIONS } from "./declarations-tui.js";
import type { ParityDeclaration, ParityFeature } from "./features.js";

function declaration(agent: AgentId) {
  return { ...RUN_DECLARATIONS[agent], ...SESSION_DECLARATIONS[agent], ...TUI_DECLARATIONS[agent] };
}

/** Every adapter and feature is explicit: additions must pass type checking. */
export const PARITY = {
  agy: declaration("agy"), aider: declaration("aider"), claude: declaration("claude"),
  cline: declaration("cline"), codex: declaration("codex"), copilot: declaration("copilot"),
  cursor: declaration("cursor"), droid: declaration("droid"), goose: declaration("goose"),
  gemini: declaration("gemini"), kimi: declaration("kimi"), opencode: declaration("opencode"),
  openhands: declaration("openhands"), pi: declaration("pi"), qwen: declaration("qwen"),
  zai: declaration("zai"),
} satisfies ParityDeclaration;

export function agentsSupporting(feature: ParityFeature): AgentId[] {
  return AGENT_IDS.filter((agent) => PARITY[agent][feature].state === "supported");
}

export { PARITY_FEATURES } from "./features.js";
export type { FeatureState, ParityDeclaration, ParityFeature } from "./features.js";
