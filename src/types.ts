export const AGENT_IDS = Object.freeze([
  "aider",
  "claude",
  "cline",
  "codex",
  "copilot",
  "cursor",
  "droid",
  "goose",
  "gemini",
  "opencode",
  "pi",
  "qwen",
  "zai",
] as const);
export type AgentId = (typeof AGENT_IDS)[number];

export const AUTONOMY_LEVELS = Object.freeze(["read-only", "low", "medium", "high"] as const);
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const REASONING_EFFORT_LEVELS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const);
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

export function isAutonomyLevel(value: string): value is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface RunRequest {
  agent: AgentId;
  prompt: string;
  model?: string;
  autonomy?: AutonomyLevel;
  effort?: ReasoningEffort;
  cwd?: string;
  // True when codemux wraps execution in scode.
  sandboxed?: boolean;
  timeoutMs?: number;
  // Explicitly authorized names of otherwise-sensitive parent variables.
  passthroughEnv?: readonly string[];
  // Trusted opt-in; never inferred from a repository environment file.
  enablePlaywrightMcp?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface AdapterCapabilities {
  supportsNonInteractive: boolean;
  supportsInteractive: boolean;
  supportsModel: boolean;
  supportsAutonomy: boolean;
  autonomyLevels: AutonomyLevel[];
  supportsEffort: boolean;
  effortLevels: ReasoningEffort[];
}

export type ModelMapping = Partial<Record<AgentId, string>>;

export interface CodemuxConfig {
  defaultAgent: AgentId;
  models: {
    [alias: string]: ModelMapping;
  };
}
