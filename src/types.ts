import type { ScodeTrustLevel } from "./sandbox.js";

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
// own set; "none" removes the harness's own tools (see docs/isolation.md for
// the one documented residue, Codex's apply_patch).
export const TOOL_SELECTIONS = Object.freeze(["default", "none"] as const);
export type ToolSelection = (typeof TOOL_SELECTIONS)[number];

export function isToolSelection(value: string): value is ToolSelection {
  return (TOOL_SELECTIONS as readonly string[]).includes(value);
}

/** What the launcher tells an adapter about this launch beyond the request:
 * `printOnly` is `--print-sandbox` (the argv is printed and nothing runs), so
 * preparation builds only the paths the argv needs and never reads or writes
 * a credential (agy: no private Keychain, no login mirror, no search-list
 * repair). Review rounds 36, 39, 41, 42. */
export interface LaunchIntent {
  printOnly?: boolean;
}

export interface RunRequest {
  agent: AgentId;
  prompt: string;
  // Operator metadata stored in the ledger and result envelope.
  labels?: Record<string, string> | null;
  model?: string;
  autonomy?: AutonomyLevel;
  effort?: ReasoningEffort;
  cwd?: string;
  // True when codemux wraps execution in scode.
  sandboxed?: boolean;
  // The requested network restriction, also checked against launch options.
  sandboxNoNet?: boolean;
  sandboxTrust?: ScodeTrustLevel;
  timeoutMs?: number;
  // Explicitly authorized names of otherwise-sensitive parent variables.
  passthroughEnv?: readonly string[];
  // Trusted opt-in; never inferred from a repository environment file.
  enablePlaywrightMcp?: boolean;
  // Load none of the operator's customizations: user or project instruction
  // files, skills, plugins, hooks, MCP servers, memories. The model sees only
  // the prompt and the harness's own base instructions; the login still works.
  // Independent of `tools`: a hermetic run keeps the harness's built-in tools
  // unless `tools` removes them. See docs/isolation.md.
  hermetic?: boolean;
  // One experiment-owned stdio MCP server, with harness-specific delivery evidence.
  experimentMcp?: string;
  // Load the repository's own permission rules on a hermetic Claude-family run,
  // so an experiment can observe the native permission system. See
  // claude-project-settings.ts.
  experimentProjectSettings?: boolean;
  // Headless Claude-family runs grant WebSearch and WebFetch at every autonomy level
  // (see claude-autonomy.ts); `--no-web` sets this false to keep them gated, for a
  // review of an untrusted tree whose content must not pick the URLs the model fetches.
  web?: boolean;
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
  // The scratch brand home a Kimi experiment control probe writes its
  // private MCP configuration into. Set only by experimentCanaryControl
  // from the check's planted home, so the control run's `mcp.json` and
  // `config.toml` writes are structurally inside the canary scratch rather
  // than depending on the planted adapter's environment. Internal: no CLI
  // flag sets it, and validateExperimentRequest refuses it on every
  // request that is not the control probe, with or without --experiment-mcp.
  kimiControlBrandHome?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  /** Set only when the runner exceeds its stdout or stderr capture bound. */
  captureLimitExceeded?: true;
  /** Set only when the runner's timeout timer fires, including after stdout EOF. */
  timedOut?: true;
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
  // The token usage a structured wire reported for the run, set by
  // processRunResult (the envelope paths for --result-json, the plain
  // unwrap otherwise). Absent when the harness reports no usage: the call
  // ledger records an all-null block then, never a fabricated one.
  usage?: ResultUsageBlock;
  // The model the harness says served the run (an envelope's modelUsage
  // key; codex reports one when a reroute notice names it, which is not
  // evidence that an override was honored), when it names exactly one.
  // Absent when nothing reported it; the ledger falls back to null, not
  // to the request's model.
  servedModel?: string | null;
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
// add `--session` back. `recording` names the experiment's per-run
// JSONL on an `--experiment-mcp` run and is null on every other run.
// `failure_code` identifies an experiment verification failure; null otherwise.
export interface CodemuxResultBlock {
  agent: string;
  model: string | null;
  /** The model the PROVIDER reported serving the run (claude's and zai's
   * modelUsage key), when it names exactly one. Codex reports one only
   * when a reroute notice names the model — reported, but not evidence
   * that an override was honored (SERVED_MODEL_EVIDENCE_HARNESSES carries
   * claude and zai only). Null when the harness's wire exposes no
   * served-model field — opencode's pinned run wire and kimi's
   * stream-json and wire log carry none — so `model` above (the
   * selection, served when reported) and this field together distinguish
   * an honored override from an ignored one where the wire is evidence. */
  served_model: string | null;
  labels: Record<string, string> | null;
  usage: ResultUsageBlock;
  session_id: string | null;
  recording: string | null;
  failure_code: string | null;
}

export interface AdapterCapabilities {
  supportsNonInteractive: boolean;
  supportsInteractive: boolean;
  supportsModel: boolean;
  supportsAutonomy: boolean;
  autonomyLevels: AutonomyLevel[];
  supportsEffort: boolean;
  effortLevels: ReasoningEffort[];
  // A verified mechanism loads no operator customization (docs/isolation.md).
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
  // `--tools none` is accepted at read-only autonomy only (codex: its
  // apply_patch tool cannot be removed, so a run that may write keeps it).
  toolsNoneRequiresReadOnly?: boolean;
  // `--hermetic` and `--tools none` need read-only scode and a working
  // directory this run owns (agy). `list` prints the condition in its labels.
  isolationRequiresReadOnly?: boolean;
  // The harness can return a structured result envelope carrying token usage
  // (`--result-json`). Absent means unsupported and the flag is refused.
  supportsResultJson?: boolean;
  // The harness can route a run to an operator-named provider endpoint
  // (`CODEMUX_<AGENT>_PROVIDER_*`, src/provider-override.ts). Absent means
  // unsupported and a set override fails the run before launch.
  supportsProviderOverride?: boolean;
}

export type ModelMapping = Partial<Record<AgentId, string>>;

/** The pre-spend quota gate's policy (src/quota-gate.ts, configured under
 * the `quota` key). `false` disables the gate globally; every field is
 * resolved over its default in src/config.ts, so an absent key means the
 * defaults, not "off". */
export interface QuotaPolicy {
  // Refuse a launch when a bounding usage window's remaining percent is
  // below this.
  minRemainingPercent: number;
  // Warn (and proceed) when a weekly window's used percent is above this.
  weeklyWarnUsedPercent: number;
  // The usagemux budget for one gate check, in seconds: one number for
  // every agent, or a per-agent map ({default: 60, claude: 90}) whose
  // `default` covers the agents the map does not name.
  timeoutSeconds: number | QuotaTimeoutMap;
  // The usagemux client a harness spends from when it is not itself
  // (opencode: claude): the gate queries the mapped client instead and
  // names the harness in its messages.
  spendsFrom?: Partial<Record<AgentId, string>>;
}

/** The map form of `quota.timeoutSeconds`. Keys are agent ids or
 * `default`; values are integers from 1 to 300. */
export type QuotaTimeoutMap = Record<string, number>;

export interface CodemuxConfig {
  defaultAgent: AgentId;
  models: {
    [alias: string]: ModelMapping;
  };
  quota: QuotaPolicy | false;
}
