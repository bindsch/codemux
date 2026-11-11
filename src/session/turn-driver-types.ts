/**
 * The shared turn-per-process engine's vocabulary (turn-driver-core.ts
 * holds the state and end path, turn-driver-turns.ts the turn
 * machinery, turn-driver.ts the caller edges): the seven-agent id, the
 * unified turn verdict and stream-event shapes every profile maps onto,
 * the per-turn command input, and the driver options record. Pure
 * types, no behavior — split from the core so each module stays small
 * (tests/file-size.test.ts).
 */
import type { AgentId, AutonomyLevel, ReasoningEffort, ResultUsageBlock, ToolSelection } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";
import type { SandboxTrust } from "./registry.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { SessionProcess } from "./process.js";

/** How the turn's prompt reaches the harness process. */
export type TurnPromptCarrier = "stdin" | "argv";

/** The agents this engine serves (one profile each,
 * src/session/<agent>-driver.ts). */
export type TurnAgentId =
  | "cline"
  | "cursor"
  | "droid"
  | "pi"
  | "qwen"
  | "gemini"
  | "copilot"
  | "goose"
  | "openhands";

/** The unified verdict a whole-stdout turn parse resolves to. Each
 * agent's profile maps its module's parse onto this shape. */
export interface TurnAgentTurnVerdict {
  answer: string | null;
  usage: ResultUsageBlock;
  /** The model the turn's wire named as served (pi's servedModel),
   * null when none did — the ledger's model_effective. */
  modelEffective: string | null;
  /** The session id the turn's output named, when it carried a usable
   * one (the deferred identity arrives here). */
  sessionId: string | null;
  noSessionId: boolean;
  wrongSession: boolean;
  noWire: boolean;
  /** True when the output itself reports a failed turn (an is_error
   * result object, a failure subtype, a structured stop reason) — the
   * turn fails on the structured report, not just the exit code. */
  failed: boolean;
  failureReason: string | null;
}

/** One line-stream parse result (gemini's stream-json wire). */
export type TurnAgentStreamEvent =
  | { kind: "confirmed"; sessionId: string; model: string | null }
  | { kind: "assistant"; text: string; delta: boolean }
  | {
      kind: "tool_use";
      callId: string;
      name: string;
      input: unknown;
    }
  | { kind: "tool_result"; callId: string; output: unknown; isError: boolean }
  | {
      kind: "error";
      message: string;
      /** True when this error fails the turn (gemini severity "error");
       * false for notices (other severities), which report without
       * failing. */
      failsTurn: boolean;
    }
  | {
      kind: "result";
      usage: ResultUsageBlock;
      failed: boolean;
      failureReason: string | null;
    }
  | { kind: "unknown" }
  | { kind: "grammar_error"; message: string }
  | { kind: "unusable"; excerpt: string; bytes: number };

/** The per-turn provider artifacts the launcher's spawn closure
 * resolves (one adapter prepareRun per turn): droid's BYOK settings
 * file path and entry model id. The other agents' overrides ride the
 * child environment and need no argv. */
export interface TurnProviderExtras {
  sessionDir?: string;
  mcpExtensionPath?: string;
  providerSettingsPath?: string;
  providerModelId?: string;
  geminiHome?: string;
  geminiPolicyPath?: string;
  qwenPlaywrightPath?: string;
}

/** What one turn's command is built from. */
export interface TurnCommandInput {
  tools?: ToolSelection;
  sessionDir?: string;
  mcpExtensionPath?: string;
  /** The prompt, author prefix applied — the stdin payload or the argv
   * tail. */
  text: string;
  /** The session id this turn runs under: the mint (fresh, minted
   * identity), the resumed id, or null while a deferred identity still
   * waits for the first turn's output. */
  sessionId: string | null;
  /** True on a FRESH session's first turn only: a resumed session's
   * first turn in this process still resumes (the flag picks
   * --session-id/--new-session-id vs --resume/-s). */
  firstTurn: boolean;
  /** The session private home's directory, when the session is hermetic
   * and the agent's wire relocates through it; null otherwise. */
  hermeticHome: string | null;
  /** Persistent caller root; does not disable native customization. */
  callerHome?: string;
  autonomy: AutonomyLevel;
  model?: string;
  effort?: ReasoningEffort;
  /** The per-turn provider artifacts (TurnProviderExtras), flattened. */
  providerSettingsPath?: string;
  providerModelId?: string;
  geminiHome?: string;
  geminiPolicyPath?: string;
  qwenPlaywrightPath?: string;
  /** The sandbox-scoped Playwright server reapply (goose's per-turn
   * --with-extension carrier; the session gate refused a non-sandboxed
   * session long before this could be set). */
  playwrightMcp?: boolean;
}

/** The per-agent facts the shared engine runs on. One profile per agent,
 * declared in src/session/<agent>-driver.ts. */
export interface TurnAgentProfile {
  agent: AgentId;
  capabilities: SessionCapabilities;
  /** "minted": codemux mints the id before anything spawns and
   * session_started is announced at run() start (the aider/claude
   * model). "deferred": the first turn's output names the id and the
   * announcement waits for it (the opencode model). */
  identity: "minted" | "deferred";
  promptCarrier: TurnPromptCarrier;
  /** The per-turn argv over the agent's pure session module. */
  buildTurnCommand(input: TurnCommandInput): string[];
  /** The whole-stdout turn parse. Exactly one of parseTurnOutput and
   * parseStreamLine is set: the line-stream wire (gemini) parses per
   * line and emits as the turn runs; the whole-stdout wires parse once
   * at the turn's exit. */
  parseTurnOutput?(stdout: string, knownSessionId: string | null): TurnAgentTurnVerdict;
  parseStreamLine?(line: string, knownSessionId: string): TurnAgentStreamEvent;
}

/** The shared engine's options — the opencode driver's options record
 * plus the private-home block the hermetic-capable agents carry (the
 * agy/kimi shape) and the agent profile. */
export interface TurnAgentDriverOptions {
  turnTimeoutMs?: number | null;
  tools?: ToolSelection;
  profile: TurnAgentProfile;
  /** The native session id to resume, or null to start fresh. */
  resumeSessionId: string | null;
  /** The codemux-minted session id for a MINTED identity's fresh
   * session (turn-driver-launch.ts mints it once, so the private home,
   * the registry record, and the first turn's --session-id all name one
   * id). Null for a deferred identity's fresh session — the first
   * turn's output names the harness's own mint — and ignored on a
   * resume, where resumeSessionId carries the recorded id. */
  mintedSessionId?: string | null;
  autonomy: AutonomyLevel;
  model?: string;
  /** The `-m` value as typed when it resolved through `config.models`,
   * else null (design P5) — the ledger's model_alias. */
  modelAlias?: string | null;
  effort?: ReasoningEffort;
  cwd: string;
  hermetic: boolean;
  sandboxed: boolean;
  sandboxTrust: SandboxTrust;
  sandboxNoNet: boolean;
  sandboxBlock?: readonly string[];
  sandboxScrubEnv: boolean;
  sandboxStrict?: boolean;
  passEnv: readonly string[];
  authorPrefix: boolean;
  sessionTimeoutMs: number | null;
  registryPath: string | null;
  registryStartBudget?: { attempts: number; retryMs: number };
  /** The harness state home recorded for this session (§4.8) — the
   * plain-session home; a hermetic session records its settled private
   * home instead (the record and the announcement below). */
  harnessHome: string;
  providerBaseUrl: string | null;
  /** Spawns one turn process. The argv arrives as a builder so the
   * closure can run its per-turn adapter prepareRun (droid's BYOK
   * settings file) FIRST and hand the artifact to the command — the
   * same one-context-per-turn discipline a run launch follows. */
  spawnTurn: (
    buildArgv: (extras: TurnProviderExtras) => string[],
    abandoned?: () => boolean
  ) => Promise<SessionProcess>;
  spawnGraceMs?: number;
  /** The hermetic session's private home (turn-driver-homes.ts), null
   * for a plain session and for the agents whose hermetic mode keeps no
   * session-keyed home (qwen — safe mode needs none, the opencode
   * rule). */
  privateHome: SessionPrivateHome | null;
  /** --final on a hermetic session: the end path removes the private
   * home (both attempts) BEFORE the end stamp releases the record, and
   * only a removal that settled removed makes the resumable verdict say
   * false (the claude/agy rule). */
  final: boolean;
  projectSettings?: boolean;
  playwrightMcp?: boolean;
  sink?: (line: string) => Promise<void> | void;
}
