export type AgentId =
  | "claude"
  | "codex"
  | "droid"
  | "goose"
  | "gemini"
  | "opencode"
  | "qwen";

export type AutonomyLevel = "read-only" | "low" | "medium" | "high";

export interface RunRequest {
  agent: AgentId;
  prompt: string;
  model?: string;
  autonomy?: AutonomyLevel;
  cwd?: string;
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
