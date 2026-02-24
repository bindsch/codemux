export type AgentId =
  | "claude"
  | "codex"
  | "droid"
  | "goose"
  | "gemini"
  | "opencode"
  | "pi"
  | "qwen"
  | "zai";

export const AUTONOMY_LEVELS = ["read-only", "low", "medium", "high"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const REASONING_EFFORT_LEVELS = ["none", "low", "medium", "high"] as const;
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

export interface ModelMapping {
  [agentId: string]: string;
}

export interface CodemuxConfig {
  defaultAgent: AgentId;
  models: {
    [alias: string]: ModelMapping;
  };
}
