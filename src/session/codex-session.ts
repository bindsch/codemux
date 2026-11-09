import { join } from "node:path";
import { featureFloor } from "../harness-contracts.js";
import { CODEX_PROVIDER_ID, CODEX_PROVIDER_KEY_ENV, readCodexMultiAgent } from "../codex-provider.js";
import type { ProviderOverride } from "../provider-override.js";
import { codexSessionConfigArgs, type CodexSessionSettings } from "./codex-config.js";
/**
 * The codex app-server session wiring (design §4.7): the version floor,
 * the spawn command, the capability record, and the parse-result
 * vocabulary the driver and parser share. The policy pair, method
 * allowlist, request builders, and usage normalization live in
 * src/session/codex-protocol-builders.ts; the approval ceiling in
 * src/session/codex-session-approvals.ts; the stream parser in
 * src/session/codex-stream-parser.ts, with its shared facts in
 * src/session/codex-parse-facts.ts. All live state lives in the
 * launcher-owned driver chain (src/session/codex-driver.ts at the head,
 * through codex-driver-input.ts, codex-driver-events.ts,
 * codex-driver-responses.ts, codex-turns.ts, codex-driver-approvals.ts,
 * and codex-ledger.ts down to codex-driver-io.ts).
 *
 * Wire facts are pinned by the step-0 fixture
 * (tests/fixtures/live/codex-app-server.ndjson, codex 0.159.3); the
 * split modules record the openclaw cross-check and the approval-shape
 * caveat against it.
 */

import type { ResultUsageBlock } from "../types.js";
import type { SessionCapabilities } from "./protocol.js";
import type { RequestId } from "./codex-protocol-builders.js";
import type { CodexApprovalKind } from "./codex-session-approvals.js";

/** The session-only version floor (design §4.3): 0.159.3, the build the
 * app-server method table was recorded against. The value lives in
 * FEATURE_FLOORS (harness-contracts.ts), the one table the session
 * drivers, the experiment path, and doctor read. */
export const CODEX_SESSION_FLOOR = featureFloor("codex", "sessions");

/** The spawn command: one dedicated app-server per session, never the
 * shared daemon (§4.7) — a singleton escapes per-session sandbox and
 * account boundaries. Everything else rides JSON-RPC. The optional env
 * prefix is the provider-override launch (CODEX_HOME pointing at the
 * session's persistent provider home) or the hermetic launch (HOME and
 * CODEX_HOME pointing at the session's private home,
 * codexSessionHermeticEnvPrefix), shaped exactly like the run path's
 * `["env", …, "codex", …]` so the two spawn shapes cannot drift. The
 * extra args are the Playwright MCP `-c` overrides
 * (codex-playwright-mcp.ts): `codex app-server` accepts `-c,
 * --config <key=value>` (0.166.0 `--help`, checked 2026-11-09), and an
 * MCP server entry is config, not a subcommand. */
export function buildCodexSessionCommand(
  envPrefix?: string[], extraArgs: readonly string[] = [], settings: CodexSessionSettings = {}
): string[] {
  const prefix = envPrefix === undefined || envPrefix.length === 0 ? [] : ["env", ...envPrefix];
  return [...prefix, settings.noToolsCatalog?.binary ?? "codex", "app-server", ...codexSessionConfigArgs(settings), ...extraArgs];
}

/** The env prefix a HERMETIC session's spawn carries: the private home
 * as both HOME and CODEX_HOME, the run path's own rule (no operator
 * config, instructions, plugins, or rules load from a home codemux made
 * empty). `codex app-server` (0.166.0) accepts `-c, --config
 * <key=value>`; startup suppression and tool policy use that channel in
 * buildCodexSessionCommand. This helper supplies only the two home
 * variables. The private config carries the credential store, while
 * thread builders reapply project-document suppression and tool policy. */
export function codexSessionHermeticEnvPrefix(privateHomeDir: string): string[] {
  return [`HOME=${privateHomeDir}`, `CODEX_HOME=${join(privateHomeDir, ".codex")}`];
}

/** Codex 0.166.0, Caskroom/codex/0.166.0/bin/codex strings: app-server
 * CliConfigOverrides and cli_auth_credentials_store. CLI overrides keep
 * caller config.toml intact and select the linked file login explicitly. */
export function codexCallerHomeConfigArgs(override: ProviderOverride | null, model?: string): string[] {
  const settings = ['cli_auth_credentials_store="file"'];
  if (override !== null) {
    settings.push(
      `model_provider=${JSON.stringify(CODEX_PROVIDER_ID)}`,
      `model=${JSON.stringify(model)}`,
      `model_providers.${CODEX_PROVIDER_ID}.name="codemux provider override"`,
      `model_providers.${CODEX_PROVIDER_ID}.base_url=${JSON.stringify(override.baseUrl)}`,
      `model_providers.${CODEX_PROVIDER_ID}.env_key=${JSON.stringify(CODEX_PROVIDER_KEY_ENV)}`,
      `model_providers.${CODEX_PROVIDER_ID}.wire_api="responses"`,
      `shell_environment_policy.exclude=[${JSON.stringify(CODEX_PROVIDER_KEY_ENV)}]`,
    );
    if (override.maxContextTokens !== undefined) settings.push(`model_context_window=${override.maxContextTokens}`);
    if (readCodexMultiAgent() === false) settings.push("features.multi_agent=false");
  }
  return settings.flatMap((setting) => ["-c", setting]);
}

/** Capability flags for codex sessions (§4.3): mid-turn input queues in
 * the codemux-side FIFO, steering and interrupts round-trip, approvals
 * surface as server requests (dormant under the never policy), deltas
 * stream through item/agentMessage/delta, and file changes are a native
 * item type rather than something derived from tool calls. */
export function codexSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: "queue",
    steer: true,
    interrupt: true,
    permissions: true,
    deltas: true,
    file_changes: "native",
    usage_stream: true,
    resume: true,
  };
}

/** What one harness line resolves to. The driver owns the FSM, the
 * pending request set, and the id correlation; these are the parser's
 * facts. */
export type CodexParse =
  | { kind: "response"; id: RequestId; result: unknown }
  | { kind: "response_error"; id: RequestId; message: string }
  | { kind: "thread_started"; threadId: string }
  | { kind: "turn_started"; threadId: string; turnId: string }
  | { kind: "assistant_delta"; threadId: string; turnId: string; text: string }
  | { kind: "assistant_text"; threadId: string; turnId: string; text: string }
  | { kind: "tool_call"; threadId: string; turnId: string; callId: string; input: Record<string, unknown> }
  | { kind: "tool_result"; threadId: string; turnId: string; callId: string; output: string | null; isError: boolean }
  | { kind: "file_change"; threadId: string; turnId: string; path: string; action: "add" | "edit" | "delete" }
  | { kind: "usage"; threadId: string; turnId: string; usage: ResultUsageBlock }
  /** The provider rerouted the turn's model (design P5): the to-model the
   * notification names. No recorded app-server frame exists, so the fact
   * carries no thread/turn scope — the driver attributes it to the open
   * turn and drops it when none is open. */
  | { kind: "model_rerouted"; model: string }
  | { kind: "turn_completed"; threadId: string; turnId: string; finish: "end" | "interrupted" | "failed"; reason: string | null }
  | { kind: "permission_request"; id: RequestId; requestId: string; kindOfApproval: CodexApprovalKind; input: Record<string, unknown> }
  | { kind: "unparseable_approval"; id: RequestId; method: string }
  | { kind: "server_request"; id: RequestId; method: string }
  | { kind: "unknown" }
  | { kind: "grammar_error"; message: string }
  | { kind: "unusable"; excerpt: string; bytes: number };

export interface CodexParseContext {
  /** The thread id once established (the thread/start response or the
   * thread/started notification, whichever lands first); null before. */
  threadId: string | null;
  /** The harness turn id of the open turn, set by the turn/start
   * response; null while no turn is open. */
  activeTurnId: string | null;
  /** The harness ids of turns that already closed. Item, delta, and
   * usage notifications naming one are that turn's stragglers (real
   * codex sends usage after `turn/completed`), accepted even once a later
   * turn is open; the driver labels them with no turn (review live20).
   * Every closed turn counts, not only the last one: a straggler can
   * outlive the next turn's whole lifetime (review live23). */
  closedTurnIds?: ReadonlySet<string>;
  /** True while a turn/start response is still in flight: a turn is open
   * codemux-side but the harness has not named it yet, so scoped
   * notifications arriving in that window cannot be identity-checked
   * against a turn id (review round 64). */
  turnPending?: boolean;
  /** The turn id the first scoped notification of the pending window
   * named: every later one in that window must name it, and the
   * turn/start response must confirm it (review round 67). */
  pendingTurnId?: string | null;
}

export {
  buildInitializeRequest,
  buildInitializedNotification,
  buildInterruptRequest,
  buildJsonRpcErrorResponse,
  buildJsonRpcResponse,
  buildSteerRequest,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  buildTurnStartRequest,
  codemuxClientVersion,
  codexSessionPolicy,
  normalizeCodexTokenUsage,
  steerElementBytes,
  CODEX_SESSION_METHODS,
} from "./codex-protocol-builders.js";
export type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSessionMethod,
  CodexSessionPolicy,
  RequestId,
} from "./codex-protocol-builders.js";
export {
  codexApprovalCeiling,
  offersRefusal,
  pickApprovalDecision,
  CODEX_APPROVAL_METHODS,
} from "./codex-session-approvals.js";
export type { CodexApprovalKind } from "./codex-session-approvals.js";
export { CodexStreamParser } from "./codex-stream-parser.js";
export { CODEX_THREAD_ID_PATTERN } from "./codex-parse-facts.js";
