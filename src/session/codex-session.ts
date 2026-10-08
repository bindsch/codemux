/**
 * The codex app-server session wiring (design §4.7): the spawn command,
 * the sandbox/approval policy pair, the JSON-RPC request builders and
 * their method allowlist, the notification/item translation under the
 * three tiers (§4.2), the token-usage normalization, and the approval
 * ceiling predicate. Pure functions and one parser class — all live
 * state lives in the launcher-owned driver (src/session/codex-driver.ts).
 *
 * Wire facts are pinned by the step-0 fixture
 * (tests/fixtures/live/codex-app-server.ndjson, codex 0.159.3) and
 * cross-checked against the openclaw client
 * (extensions/codex/src/app-server/ in the OSS checkout): requests carry
 * `jsonrpc` while responses omit it, `thread/started` arrives exactly
 * once after the thread/start response, `turn/started` follows the
 * turn/start response, and `thread/tokenUsage/updated` carries `{total,
 * last}`. The approval-request traffic is NOT in the recorded fixture —
 * those shapes come from the hand-written fake app-server and the
 * openclaw cross-check alone, so approvals are the one surface here
 * without recorded-reality backing.
 */

import { readFileSync } from "node:fs";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import type { CeilingVerdict } from "./ceiling.js";
import { pathInsideScope } from "./ceiling.js";
import { unusableFacts } from "./process.js";
import type { SessionCapabilities } from "./protocol.js";

/** The session-only version floor (design §4.3): 0.159.3, the build the
 * app-server method table was recorded against. */
export const CODEX_SESSION_FLOOR = "0.159.3";

/** Codex thread ids codemux will resume (§4.5): the fixture's ids are
 * UUIDv7-shaped and fit; claude-family ids stay UUIDs. Anything else is
 * exit 64 before it reaches the wire. */
export const CODEX_THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** The spawn command: one dedicated app-server per session, never the
 * shared daemon (§4.7) — a singleton escapes per-session sandbox and
 * account boundaries. Everything else rides JSON-RPC. The optional env
 * prefix is the provider-override launch (CODEX_HOME pointing at the
 * session's persistent provider home), shaped exactly like the run path's
 * `["env", …, "codex", …]` so the two spawn shapes cannot drift. */
export function buildCodexSessionCommand(envPrefix?: string[]): string[] {
  if (envPrefix === undefined || envPrefix.length === 0) {
    return ["codex", "app-server"];
  }
  return ["env", ...envPrefix, "codex", "app-server"];
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

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "never";

export interface CodexSessionPolicy {
  /** The thread/start carrier (§4.7). */
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  /** The turn/start carrier of the same policy: an object, not a string. */
  sandboxPolicy: Record<string, unknown>;
}

/**
 * The sandbox/approval pair every thread start, thread/resume included,
 * and every turn start carries (§4.7). A scode-wrapped session passes the
 * bypass pair at every level — scode is the boundary and the approval
 * mapping is not even consulted — mirroring `run`'s
 * `--dangerously-bypass-approvals-and-sandbox`. The unsandboxed shape is
 * high-only (the CLI refuses below high without a sandbox); its pair is
 * the adapter's mapAutonomy mapping (src/adapters/codex.ts) translated
 * to the JSON-RPC carriers, so app-server's config.toml fallback is
 * never the source of sandbox or approval behavior.
 */
export function codexSessionPolicy(
  level: AutonomyLevel,
  sandboxed: boolean,
  cwd: string
): CodexSessionPolicy {
  if (sandboxed) {
    return {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  switch (level) {
    case "read-only":
      return {
        sandbox: "read-only",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
    case "low":
    case "medium":
      return {
        sandbox: "workspace-write",
        approvalPolicy: level === "low" ? "untrusted" : "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "high":
      return {
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

/** Every method codemux may send (§4.7), pinned by a grammar test. Never
 * fs/*, remoteControl/*, thread/realtime/*, thread/queue/*,
 * turn/settings/update, command/*, process/*, or review/start. */
export const CODEX_SESSION_METHODS = [
  "initialize",
  "notifications/initialized",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export type CodexSessionMethod = (typeof CODEX_SESSION_METHODS)[number];

/** The codemux version reported in the initialize handshake. Read the
 * same way src/index.ts reads it; a missing or malformed package.json
 * falls back to a probe-style 0.0.0 rather than failing the session. */
export function codemuxClientVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

// --- request builders ----------------------------------------------------

/** JSON-RPC ids keep their type on the wire: a numeric request id must be
 * answered numerically or the server cannot correlate the reply. */
export type RequestId = number | string;

/** Requests carry `jsonrpc`, as every client line in the fixture does. */
function request(id: RequestId, method: CodexSessionMethod, params?: unknown): string {
  const frame: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) frame.params = params;
  return JSON.stringify(frame);
}

export function buildInitializeRequest(id: RequestId): string {
  return request(id, "initialize", {
    clientInfo: { name: "codemux", title: "codemux", version: codemuxClientVersion() },
  });
}

export function buildInitializedNotification(): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
}

/** The thread-level config object (§4.7): the same project-doc overrides
 * run's hermetic flags use, skipping AGENTS.md discovery on the one
 * carrier the app-server contract verifies. It is NOT the app-server
 * equivalent of run's `--ignore-rules` — execpolicy rules
 * (`~/.codex/rules`) have no verified thread-config carrier, so a codex
 * session still loads them where a run does not. That parity gap is
 * recorded in docs/HARNESS-COMPATIBILITY.md; the pinned test asserts
 * the config carries exactly these two keys so the gap stays visible. */
const IGNORE_RULES_CONFIG = {
  project_doc_max_bytes: 0,
  project_doc_fallback_filenames: [],
} as const;

function threadParams(
  policy: CodexSessionPolicy,
  cwd: string,
  model: string | undefined
): Record<string, unknown> {
  return {
    cwd,
    sandbox: policy.sandbox,
    approvalPolicy: policy.approvalPolicy,
    config: IGNORE_RULES_CONFIG,
    ...(model !== undefined ? { model } : {}),
  };
}

export function buildThreadStartRequest(
  id: RequestId,
  policy: CodexSessionPolicy,
  cwd: string,
  model?: string
): string {
  return request(id, "thread/start", threadParams(policy, cwd, model));
}

export function buildThreadResumeRequest(
  id: RequestId,
  threadId: string,
  policy: CodexSessionPolicy,
  cwd: string,
  model?: string
): string {
  return request(
    id,
    "thread/resume",
    { threadId, ...threadParams(policy, cwd, model) }
  );
}

/** The turn/start params: explicit policy pair on every turn (§4.7), the
 * fixture-pinned input shape, and the effort override on the one carrier
 * the app-server contract verifies. */
export function buildTurnStartRequest(
  id: RequestId,
  threadId: string,
  text: string,
  policy: CodexSessionPolicy,
  effort?: ReasoningEffort
): string {
  return request(id, "turn/start", {
    threadId,
    input: [{ type: "text", text }],
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy: policy.sandboxPolicy,
    ...(effort !== undefined && effort !== "none" ? { effort } : {}),
  });
}

/** Steer texts batch into one request, as openclaw's client does; the
 * shape carries `text_elements` the way its toCodexTextInput does. */
export function buildSteerRequest(
  id: RequestId,
  threadId: string,
  expectedTurnId: string,
  texts: string[]
): string {
  return request(id, "turn/steer", {
    threadId,
    expectedTurnId,
    input: texts.map((text) => ({ type: "text", text, text_elements: [] })),
  });
}

export function buildInterruptRequest(
  id: RequestId,
  threadId: string,
  turnId: string
): string {
  return request(id, "turn/interrupt", { threadId, turnId });
}

/** Responses omit `jsonrpc`, matching both the server's own responses in
 * the fixture and the openclaw client's writer. */
export function buildJsonRpcResponse(id: RequestId, result: unknown): string {
  return JSON.stringify({ id, result });
}

export function buildJsonRpcErrorResponse(
  id: RequestId,
  code: number,
  message: string
): string {
  return JSON.stringify({ id, error: { code, message } });
}

// --- usage normalization ---------------------------------------------------

/**
 * Normalize one `tokenUsage` block (the `last` delta or the `total`
 * snapshot) into `ResultUsageBlock` semantics (§4.2): codex folds BOTH
 * cache reads and cache writes into `inputTokens` (each is a breakdown of
 * that total), so the uncached input subtracts both — the same unfolding
 * the `--result-json` code applies (src/result-envelope.ts). Each
 * normalized field is null when the raw fields it needs are unreported,
 * never guessed; cost is null because the app-server carries none.
 */
export function normalizeCodexTokenUsage(raw: unknown): ResultUsageBlock {
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : null;
  const record = isRecord(raw) ? raw : {};
  const input = count(record["inputTokens"]);
  const cached = count(record["cachedInputTokens"]);
  const cacheWrite = count(record["cacheWriteInputTokens"]);
  const output = count(record["outputTokens"]);
  return {
    input_tokens:
      input !== null && cached !== null && cacheWrite !== null
        ? Math.max(0, input - cached - cacheWrite)
        : null,
    output_tokens: output,
    cached_input_tokens:
      cached !== null && cacheWrite !== null ? cached + cacheWrite : null,
    total_tokens:
      input !== null && cached !== null && cacheWrite !== null && output !== null
        ? Math.max(0, input - cached - cacheWrite) + cached + cacheWrite + output
        : null,
    cost_usd: null,
  };
}

// --- approval ceiling ------------------------------------------------------

/** The three approval kinds the app-server surfaces (§4.1). */
export type CodexApprovalKind =
  | "commandExecution"
  | "fileChange"
  | "permissions";

/** The approval request methods codemux answers; anything else is an
 * unimplemented server request. */
export const CODEX_APPROVAL_METHODS: Readonly<Record<string, CodexApprovalKind>> = {
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
};

/**
 * Judge one codex approval request against the session's start-time
 * autonomy (§4.1). No launchable codex session surfaces a request — the
 * default sandboxed shape passes the bypass pair at every level and the
 * unsandboxed shape is high-only, both `never` — so this is dormant
 * defense against harness or config drift. Read-only denies all three
 * kinds; low is caller approval, so everything is allow-able; medium
 * allows workspace patches and denies commands; high's mapping is full
 * access, and requests within it are allow-able. Turn-scoped permission
 * grants widen beyond every mapping above low, so they deny everywhere
 * else. Fail-closed: a patch whose paths codemux cannot parse denies.
 */
export function codexApprovalCeiling(
  level: AutonomyLevel,
  kind: CodexApprovalKind,
  input: Record<string, unknown>,
  launchDir: string
): CeilingVerdict {
  if (level === "read-only") {
    return { allowable: false, reason: "read-only allows no tool use" };
  }
  if (level === "low") {
    return { allowable: true, reason: "low allows every request" };
  }
  if (kind === "permissions") {
    return {
      allowable: false,
      reason: `the ${level} mapping grants no turn-scoped permissions`,
    };
  }
  if (kind === "commandExecution") {
    return level === "high"
      ? { allowable: true, reason: "high's mapping is full access; the command is within it" }
      : { allowable: false, reason: "medium denies commands; only workspace patches are allow-able" };
  }
  if (level === "high") {
    return { allowable: true, reason: "high's mapping is full access; the patch is within it" };
  }
  const paths = fileChangePaths(input);
  if (paths.length === 0) {
    return { allowable: false, reason: "the patch carries no parsable paths" };
  }
  for (const path of paths) {
    const verdict = pathInsideScope(path, launchDir);
    if (!verdict.allowable) return verdict;
  }
  return { allowable: true, reason: "every patched path is inside the launch directory" };
}

/** The paths a fileChange approval would touch; empty when the changes
 * list is missing or unparsable (§4.1's opaque-action rule). An update
 * that moves a file names its destination separately (`kind.move_path`):
 * the destination is as much "where this patch writes" as the source,
 * so it is judged too — a move from inside the workspace to outside it
 * is not an in-scope patch (found by review live3; the shape is
 * openclaw's PatchChangeKind, `update` alone carries `move_path`). */
function fileChangePaths(input: Record<string, unknown>): string[] {
  const changes = input["changes"];
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) return [];
    const path = change["path"];
    if (typeof path !== "string" || path.length === 0) return [];
    paths.push(path);
    const kind = change["kind"];
    const movePath = isRecord(kind) ? kind["move_path"] : undefined;
    if (movePath !== undefined && movePath !== null) {
      if (typeof movePath !== "string" || movePath.length === 0) return [];
      paths.push(movePath);
    }
  }
  return paths;
}

/**
 * Pick the decision string for an approval response, respecting the
 * request's `availableDecisions` the way openclaw's bridge does: the
 * preferred decision when available (or when the list is absent), else
 * the other refusal, never `acceptForSession` — the session-persistent
 * variant is dropped, not forwarded (§4.1). A decline is only picked for
 * a request that `offersRefusal`: the driver keeps every other one away
 * from the decline paths, so the final "decline" fallback is never an
 * answer the server did not offer.
 */
export function pickApprovalDecision(
  available: unknown,
  preferred: "accept" | "decline"
): string {
  if (!Array.isArray(available)) return preferred;
  if (available.includes(preferred)) return preferred;
  const alternate = preferred === "decline" ? "cancel" : "decline";
  if (available.includes(alternate)) return alternate;
  return preferred === "accept" ? alternate : "decline";
}

/** Whether an approval's decision list lets codemux refuse it: an absent
 * list allows every decision, and a present one must name "decline" or
 * "cancel". A list without either has no refusal codemux may send
 * (review live17); the driver never forwards such a request. */
export function offersRefusal(available: unknown): boolean {
  if (!Array.isArray(available)) return true;
  return available.includes("decline") || available.includes("cancel");
}

// --- stream parser ---------------------------------------------------------

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
}

/** Bounds on the raw-newline rejoin buffer, matching openclaw's client:
 * fragments beyond these are the tier-3 fatal they would have been. */
const PARSE_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
const PARSE_BUFFER_MAX_LINES = 1_000;

interface PendingParse {
  text: string;
  lines: number;
}

/**
 * Parse the app-server NDJSON stream, one line at a time, under the §4.2
 * tiers. Never throws. The one codex-specific tolerance is openclaw's
 * raw-newline quirk: codex has emitted JSON with raw newlines inside
 * string values, so a line that starts an object and fails with
 * "Unterminated string" or "Unexpected end of JSON input" is buffered and
 * rejoined with an escaped newline once its continuation lines arrive —
 * bounded, and fatal once the bounds are passed. Responses are keyed on
 * id-without-method and notifications on method-without-id, exactly as
 * the recorded wire frames them.
 */
export class CodexStreamParser {
  private threadStartedSeen = false;
  private pendingParse: PendingParse | null = null;

  feed(line: string, context: CodexParseContext): CodexParse[] {
    if (this.pendingParse !== null) {
      return this.feedPending(line, context);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (bufferable(line, error)) {
        this.pendingParse = { text: line, lines: 1 };
        return [];
      }
      return [{ kind: "unusable", ...unusableFacts(line) }];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Tier 3 (§4.2): the stream grammar is one JSON object per line.
      return [{ kind: "unusable", ...unusableFacts(line) }];
    }
    return this.classify(parsed as Record<string, unknown>, context);
  }

  /** Take the buffered fragment the stream ended inside, as the tier-3
   * facts its report carries, or null when none is held. The driver calls
   * this once the child has settled: nothing more can complete the
   * fragment, and dropping it silently lost the output it held (review
   * live25). */
  takeFragment(): { excerpt: string; bytes: number } | null {
    const pending = this.pendingParse;
    this.pendingParse = null;
    return pending === null ? null : unusableFacts(pending.text);
  }

  private feedPending(line: string, context: CodexParseContext): CodexParse[] {
    const pending = this.pendingParse as PendingParse;
    // The raw newline becomes the two-character escape it should have
    // been, which is what makes the rejoined message parse.
    const candidate = `${pending.text}\\n${line}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      const lines = pending.lines + 1;
      if (
        bufferable(candidate, error) &&
        candidate.length <= PARSE_BUFFER_MAX_BYTES &&
        lines <= PARSE_BUFFER_MAX_LINES
      ) {
        this.pendingParse = { text: candidate, lines };
        return [];
      }
      this.pendingParse = null;
      return [{ kind: "unusable", ...unusableFacts(candidate) }];
    }
    this.pendingParse = null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [{ kind: "unusable", ...unusableFacts(candidate) }];
    }
    return this.classify(parsed as Record<string, unknown>, context);
  }

  private classify(
    frame: Record<string, unknown>,
    context: CodexParseContext
  ): CodexParse[] {
    const method = frame["method"];
    if (typeof method === "string") {
      if (frame["id"] !== undefined) {
        return this.classifyServerRequest(frame, method, context);
      }
      return this.classifyNotification(frame, method, context);
    }
    if (frame["id"] !== undefined) {
      const id = frame["id"] as RequestId;
      if (typeof id !== "number" && typeof id !== "string") {
        return [{ kind: "grammar_error", message: "a response carries a non-scalar id" }];
      }
      const error = frame["error"];
      if (isRecord(error)) {
        const message = typeof error["message"] === "string" ? error["message"] : "unknown error";
        return [{ kind: "response_error", id, message }];
      }
      // JSON-RPC 2.0 makes `error` an object and requires `result` on
      // success. Anything else is a failure, never a success with an
      // undefined result: `{"id":7,"error":"boom"}` used to report a
      // failed steer or interrupt as accepted (review live16).
      if (error !== undefined && error !== null) {
        return [{ kind: "response_error", id, message: "the app-server returned a malformed error" }];
      }
      if (frame["result"] === undefined) {
        return [{ kind: "response_error", id, message: "the response carries neither result nor error" }];
      }
      return [{ kind: "response", id, result: frame["result"] }];
    }
    // A JSON object with neither method nor id is not a JSON-RPC frame.
    return [{ kind: "unknown" }];
  }

  private classifyServerRequest(
    frame: Record<string, unknown>,
    method: string,
    context: CodexParseContext
  ): CodexParse[] {
    const id = frame["id"] as RequestId;
    if (typeof id !== "number" && typeof id !== "string") {
      return [{ kind: "grammar_error", message: `server request ${method} carries a non-scalar id` }];
    }
    const kindOfApproval = CODEX_APPROVAL_METHODS[method];
    if (kindOfApproval === undefined) {
      return [{ kind: "server_request", id, method }];
    }
    const params = frame["params"];
    if (!isRecord(params)) {
      // Permission-shaped requests never kill the session on shape alone
      // (§4.2): the driver answers the per-method decline and reports a
      // non-fatal error with the raw preserved.
      return [{ kind: "unparseable_approval", id, method }];
    }
    const thread = params["threadId"];
    const turn = params["turnId"];
    if (typeof thread !== "string" || typeof turn !== "string") {
      return [{ kind: "unparseable_approval", id, method }];
    }
    const threadError = this.checkThread(thread, context);
    if (threadError !== null) return [threadError];
    if (context.activeTurnId === null) {
      return [
        {
          kind: "grammar_error",
          message: `an approval request for turn ${turn} arrived with no open turn`,
        },
      ];
    }
    if (turn !== context.activeTurnId) {
      return [
        {
          kind: "grammar_error",
          message: `an approval request references turn ${turn} but the open turn is ${context.activeTurnId}`,
        },
      ];
    }
    if (kindOfApproval === "fileChange" && fileChangePaths(params).length === 0) {
      // The ceiling cannot judge a patch without paths; the driver
      // answers decline rather than forward an opaque action.
      return [{ kind: "unparseable_approval", id, method }];
    }
    return [
      {
        kind: "permission_request",
        // The reply must echo the id with its original type (JSON-RPC
        // correlation): numeric ids stay numeric, and the caller-facing
        // `request_id` is its string spelling (§4.2's pending set is
        // string-keyed).
        id,
        requestId: String(id),
        kindOfApproval,
        input: params,
      },
    ];
  }

  private classifyNotification(
    frame: Record<string, unknown>,
    method: string,
    context: CodexParseContext
  ): CodexParse[] {
    const params = isRecord(frame["params"]) ? (frame["params"] as Record<string, unknown>) : null;
    switch (method) {
      case "thread/started": {
        if (this.threadStartedSeen) {
          return [{ kind: "grammar_error", message: "a second thread/started in one session" }];
        }
        this.threadStartedSeen = true;
        const thread = params !== null ? params["thread"] : undefined;
        const id = isRecord(thread) ? thread["id"] : undefined;
        if (typeof id !== "string" || id.length === 0) {
          return [{ kind: "grammar_error", message: "thread/started carries no thread id" }];
        }
        // The id becomes the registry key and the `--resume` argument, so
        // it must be one `--resume` accepts (review live16).
        if (!CODEX_THREAD_ID_PATTERN.test(id)) {
          return [{ kind: "grammar_error", message: "thread/started carries an invalid thread id" }];
        }
        if (context.threadId !== null && id !== context.threadId) {
          return [
            {
              kind: "grammar_error",
              message: `thread/started announces ${id}, expected ${context.threadId}`,
            },
          ];
        }
        return [{ kind: "thread_started", threadId: id }];
      }
      case "turn/started": {
        // Turn-lifecycle notifications carry the turn as an object, not a
        // params-level turnId (the fixture's shape).
        const scoped = this.threadScopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const turn = isRecord(scoped.params?.["turn"]) ? (scoped.params["turn"] as Record<string, unknown>) : null;
        const turnId = turn !== null ? turn["id"] : undefined;
        if (context.activeTurnId === null) {
          return [
            {
              kind: "grammar_error",
              message: "turn/started arrived before the turn/start response named the turn",
            },
          ];
        }
        if (typeof turnId !== "string" || turnId !== context.activeTurnId) {
          return [
            {
              kind: "grammar_error",
              message: `turn/started names ${String(turnId)}, expected ${context.activeTurnId}`,
            },
          ];
        }
        return [{ kind: "turn_started", threadId: scoped.threadId, turnId }];
      }
      case "turn/completed": {
        const scoped = this.threadScopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const turn = isRecord(scoped.params?.["turn"]) ? (scoped.params["turn"] as Record<string, unknown>) : null;
        const turnId = turn !== null ? turn["id"] : undefined;
        if (context.activeTurnId === null) {
          return [
            {
              kind: "grammar_error",
              message: `turn/completed for ${String(turnId)} arrived with no open turn`,
            },
          ];
        }
        if (typeof turnId !== "string" || turnId !== context.activeTurnId) {
          return [
            {
              kind: "grammar_error",
              message: `turn/completed names ${String(turnId)} but the open turn is ${context.activeTurnId}`,
            },
          ];
        }
        const status = turn?.["status"];
        if (status === "completed") {
          return [{ kind: "turn_completed", threadId: scoped.threadId, turnId, finish: "end", reason: null }];
        }
        if (status === "interrupted") {
          return [{ kind: "turn_completed", threadId: scoped.threadId, turnId, finish: "interrupted", reason: null }];
        }
        if (status === "failed") {
          const error = turn?.["error"];
          const reason = isRecord(error) && typeof error["message"] === "string" ? error["message"] : "turn failed";
          return [{ kind: "turn_completed", threadId: scoped.threadId, turnId, finish: "failed", reason }];
        }
        // inProgress or an unrecognized status: a recognized method naming
        // the open turn whose outcome cannot be read. Passing it through
        // as unknown left the turn open forever — queued input never ran
        // and only a timeout or shutdown ended the session (review
        // live15) — so the turn completes failed with the unreadable
        // status named: fail-closed, and the queued input the completion
        // releases still runs.
        return [
          {
            kind: "turn_completed",
            threadId: scoped.threadId,
            turnId,
            finish: "failed",
            reason:
              typeof status === "string" && status.length > 0
                ? `the turn completed with unrecognized status ${status}`
                : "the turn completed with no status",
          },
        ];
      }
      case "item/agentMessage/delta": {
        const scoped = this.scopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const delta = scoped.params?.["delta"];
        if (typeof delta !== "string" || delta.length === 0) return [{ kind: "unknown" }];
        return [
          {
            kind: "assistant_delta",
            threadId: scoped.threadId,
            turnId: scoped.turnId as string,
            text: delta,
          },
        ];
      }
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const scoped = this.scopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const item = isRecord(scoped.params?.["item"]) ? (scoped.params["item"] as Record<string, unknown>) : null;
        if (item === null) return [{ kind: "unknown" }];
        const itemId = item["id"];
        if (typeof itemId !== "string" || itemId.length === 0) return [{ kind: "unknown" }];
        const type = item["type"];
        if (type === "agentMessage" && method === "item/completed") {
          // Commentary is mid-turn chatter, not the final answer.
          const phase = item["phase"];
          const text = item["text"];
          if (phase !== "commentary" && typeof text === "string") {
            return [
              { kind: "assistant_text", threadId: scoped.threadId, turnId: scoped.turnId as string, text },
            ];
          }
          return [{ kind: "unknown" }];
        }
        if (type === "commandExecution" && method === "item/started") {
          const command = item["command"];
          if (typeof command !== "string") return [{ kind: "unknown" }];
          const cwd = item["cwd"];
          return [
            {
              kind: "tool_call",
              threadId: scoped.threadId,
              turnId: scoped.turnId as string,
              callId: itemId,
              input:
                typeof cwd === "string" ? { command, cwd } : { command },
            },
          ];
        }
        if (type === "commandExecution" && method === "item/completed") {
          const output = item["aggregatedOutput"];
          const status = item["status"];
          return [
            {
              kind: "tool_result",
              threadId: scoped.threadId,
              turnId: scoped.turnId as string,
              callId: itemId,
              output: typeof output === "string" ? output : null,
              isError: status === "failed" || status === "declined",
            },
          ];
        }
        if (type === "fileChange" && method === "item/completed") {
          const changes = item["changes"];
          if (!Array.isArray(changes) || changes.length === 0) return [{ kind: "unknown" }];
          const parses: CodexParse[] = [];
          for (const change of changes) {
            if (!isRecord(change)) return [{ kind: "unknown" }];
            const path = change["path"];
            const kind = isRecord(change["kind"]) ? change["kind"]["type"] : undefined;
            const action =
              kind === "add" ? "add" : kind === "update" ? "edit" : kind === "delete" ? "delete" : null;
            if (typeof path !== "string" || path.length === 0 || action === null) {
              // All-or-nothing: a partially parsable change list is
              // never partially emitted.
              return [{ kind: "unknown" }];
            }
            parses.push({
              kind: "file_change",
              threadId: scoped.threadId,
              turnId: scoped.turnId as string,
              path,
              action,
            });
          }
          return parses;
        }
        // userMessage echo (codemux's user_message event is the
        // authoritative record), mcpToolCall, webSearch, reasoning, …:
        // recognized harness items with no codemux translation.
        return [{ kind: "unknown" }];
      }
      case "thread/tokenUsage/updated": {
        const scoped = this.scopedParams(params, context);
        if (scoped.error !== null) return [scoped.error];
        const tokenUsage = scoped.params?.["tokenUsage"];
        const last = isRecord(tokenUsage) ? tokenUsage["last"] : undefined;
        if (!isRecord(last)) return [{ kind: "unknown" }];
        return [
          {
            kind: "usage",
            threadId: scoped.threadId,
            turnId: scoped.turnId as string,
            usage: normalizeCodexTokenUsage(last),
          },
        ];
      }
      case "thread/status/changed": {
        // A cosmetic status flip: thread-checked when parseable, then a
        // tier-1 passthrough.
        if (params === null) return [{ kind: "unknown" }];
        const thread = params["threadId"];
        if (typeof thread !== "string") return [{ kind: "unknown" }];
        const error = this.checkThread(thread, context);
        if (error !== null) return [error];
        return [{ kind: "unknown" }];
      }
      default:
        // Ambient account/remoteControl/mcpServer traffic and anything
        // newer: valid harness events codemux does not map.
        return [{ kind: "unknown" }];
    }
  }

  /** The thread-scope check every translated notification passes: the
   * event must reference the one thread this session owns. */
  private checkThread(threadId: string, context: CodexParseContext): CodexParse | null {
    if (context.threadId !== null && threadId !== context.threadId) {
      return {
        kind: "grammar_error",
        message: `an event references thread ${threadId}, expected ${context.threadId}`,
      };
    }
    return null;
  }

  /** Validate the thread-scoped params turn-lifecycle notifications
   * carry ({threadId, turn}): the turn identity rides the object. */
  private threadScopedParams(
    params: Record<string, unknown> | null,
    context: CodexParseContext
  ): { params: Record<string, unknown> | null; threadId: string; error: CodexParse | null } {
    if (params === null) {
      return { params: null, threadId: "", error: { kind: "grammar_error", message: "a turn notification carries no params" } };
    }
    const threadId = params["threadId"];
    if (typeof threadId !== "string") {
      return { params: null, threadId: "", error: { kind: "grammar_error", message: "a turn notification carries no thread id" } };
    }
    const threadError = this.checkThread(threadId, context);
    if (threadError !== null) {
      return { params: null, threadId: "", error: threadError };
    }
    return { params, threadId, error: null };
  }

  /** Validate the {threadId, turnId} scope item and turn notifications
   * share, plus the open-turn requirement once a turn is involved. */
  private scopedParams(
    params: Record<string, unknown> | null,
    context: CodexParseContext
  ): { params: Record<string, unknown> | null; threadId: string; turnId: string | null; error: CodexParse | null } {
    if (params === null) {
      return { params: null, threadId: "", turnId: null, error: { kind: "grammar_error", message: "a scoped notification carries no params" } };
    }
    const threadId = params["threadId"];
    if (typeof threadId !== "string") {
      return { params: null, threadId: "", turnId: null, error: { kind: "grammar_error", message: "a scoped notification carries no thread id" } };
    }
    const threadError = this.checkThread(threadId, context);
    if (threadError !== null) {
      return { params: null, threadId: "", turnId: null, error: threadError };
    }
    const turnId = params["turnId"];
    const straggler =
      typeof turnId === "string" && context.closedTurnIds?.has(turnId) === true;
    if (context.activeTurnId !== null && turnId !== context.activeTurnId && !straggler) {
      return {
        params: null,
        threadId: "",
        turnId: null,
        error: {
          kind: "grammar_error",
          message: `an event references turn ${String(turnId)} but the open turn is ${context.activeTurnId}`,
        },
      };
    }
    return { params, threadId, turnId: typeof turnId === "string" ? turnId : null, error: null };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bufferable parse failures (openclaw's exact rule): an object or
 * array opener whose parse died mid-string. */
function bufferable(value: string, error: unknown): boolean {
  if (!value.startsWith("{") && !value.startsWith("[")) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unterminated string") ||
    message.includes("Unexpected end of JSON input")
  );
}

