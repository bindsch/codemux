export const AGENT_IDS = Object.freeze([
  "agy",
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
  // Ask the harness for a machine-readable result envelope on stdout instead of plain text,
  // so a caller can read what the run actually consumed. Headless runs only: there is no
  // envelope to parse in an interactive session. The envelope's shape is the harness's, not
  // codemux's -- codemux re-emits it with every harness field unchanged plus its own
  // `codemux` block (usage, model, session id), and stdout that is not the envelope the
  // launch asked for fails the run rather than passing through as plain text.
  resultJson?: boolean;
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
  // The model's answer when the harness's stdout is a transcript around it
  // (aider's banner, summaries and cost lines), extracted by
  // processRunResult from the run's own record while the run context is
  // alive. Absent when stdout is the answer; `codemux run` prints stdout
  // either way, so the field is for callers (the hermetic check's exact-OK
  // test) that need the answer itself.
  reply?: string;
  // Stdout plus everything else the run recorded (aider's chat history
  // keeps reasoning the endpoint returned and stdout omits), so a leak
  // scan covers the whole record, not just what was printed. Absent when
  // stdout is the whole record.
  scanSurface?: string;
}

// Token usage inside the codemux block of a --result-json envelope. Every
// field is null rather than guessed when the harness did not report it.
// Semantics, so the fields mean the same thing for every harness:
// input_tokens counts input NOT served from a prompt cache,
// cached_input_tokens counts input served from or written to one, and
// total_tokens is their sum plus output.
export interface ResultUsageBlock {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

// The one codemux-owned field on every --result-json envelope, carrying what
// codemux normalized across harnesses: which adapter ran, the model that
// served the run when it is known, and token usage. `session_id` is always
// null in this release -- reserved for the live-sessions design that will
// add `--session` back.
export interface CodemuxResultBlock {
  agent: string;
  model: string | null;
  usage: ResultUsageBlock;
  session_id: string | null;
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
  // `--tools none` is offered on hermetic runs only; a plain run cannot
  // guarantee the mechanism (OpenCode: the operator's config can override
  // the deny per agent). `check --hermetic --tools none` refuses the whole
  // combination for such a harness: its control must repeat the tools
  // selection without `--hermetic`, and that plain run is refused.
  toolsNoneRequiresHermetic?: boolean;
  // The harness can return a structured result envelope carrying token usage
  // (`--result-json`). Absent means unsupported and the flag is refused.
  supportsResultJson?: boolean;
}

export type ModelMapping = Partial<Record<AgentId, string>>;

export interface CodemuxConfig {
  defaultAgent: AgentId;
  models: {
    [alias: string]: ModelMapping;
  };
}
