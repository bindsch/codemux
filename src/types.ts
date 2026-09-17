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
  "kimi",
  "opencode",
  "openhands",
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

// Which built-in tools a headless run exposes. "default" keeps the harness's
// own set; "none" removes the harness's own tools (see docs/HERMETIC.md for
// the one documented residue, Codex's apply_patch).
export const TOOL_SELECTIONS = Object.freeze(["default", "none"] as const);
export type ToolSelection = (typeof TOOL_SELECTIONS)[number];

export function isToolSelection(value: string): value is ToolSelection {
  return (TOOL_SELECTIONS as readonly string[]).includes(value);
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
  // Load none of the operator's customizations: user or project instruction
  // files, skills, plugins, hooks, MCP servers, memories. The model sees only
  // the prompt and the harness's own base instructions; the login still works.
  // Independent of `tools`: a hermetic run keeps the harness's built-in tools
  // unless `tools` removes them. See docs/HERMETIC.md.
  hermetic?: boolean;
  // Which built-in tools the harness exposes; undefined means "default".
  // "none" removes the harness's own tool set; a harness that cannot drop
  // one of them (Codex's apply_patch) says so in its adapter.
  tools?: ToolSelection;
  // Directories whose instruction files the harness should load in addition
  // to the working directory's, for harnesses that otherwise read only the
  // working directory's own (Claude Code's --add-dir). The hermetic check
  // plants its code word there to prove the control probe sees it.
  instructionDirs?: readonly string[];
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
  // A verified mechanism loads no operator customization (docs/HERMETIC.md).
  // Absent means unsupported: `--hermetic` is refused for the harness.
  supportsHermetic?: boolean;
  // The harness can remove its built-in tools on request (`--tools none`).
  supportsToolSelection?: boolean;
}

export type ModelMapping = Partial<Record<AgentId, string>>;

export interface CodemuxConfig {
  defaultAgent: AgentId;
  models: {
    [alias: string]: ModelMapping;
  };
}
