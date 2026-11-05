/**
 * The codex app-server protocol builders: the sandbox/approval policy
 * pair, the method allowlist, the JSON-RPC request builders, and the
 * token-usage normalization. src/session/codex-session.ts owns the
 * lifecycle and re-exports these.
 */

import { readFileSync } from "node:fs";
import { markOverflowed } from "./usage.js";
import type { AutonomyLevel, ReasoningEffort, ResultUsageBlock } from "../types.js";
import { reportedTokenCount, safeTokenSum } from "../result-envelope/common.js";
import { isRecord } from "./codex-parse-facts.js";

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
 * recorded in docs/harnesses.md; the pinned test asserts
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
 * never guessed; cost is null because the app-server carries none. Counts
 * and sums follow the envelope's rule exactly (reportedTokenCount and
 * safeTokenSum, src/result-envelope/common.ts): a count is a whole
 * non-negative safe integer, and a sum that would leave the safe range —
 * input at the ceiling plus two output tokens — is null, never the
 * rounded number the float addition produces (review round 80), so
 * session accounting cannot disagree with an equivalent non-session run.
 */
export function normalizeCodexTokenUsage(raw: unknown): ResultUsageBlock {
  const record = isRecord(raw) ? raw : {};
  const input = reportedTokenCount(record["inputTokens"]);
  const cached = reportedTokenCount(record["cachedInputTokens"]);
  const cacheWrite = reportedTokenCount(record["cacheWriteInputTokens"]);
  const output = reportedTokenCount(record["outputTokens"]);
  // Cached counts above the input count are an inconsistent snapshot (each
  // is a breakdown of that input): clamping the difference to zero used to
  // publish an uncached input the harness never reported and a total above
  // its own input-plus-output. The uncached input is unknown instead —
  // null — and with it the total; the cached and output counts stay as
  // reported (review round 104). The comparison runs on BigInt, like the
  // reducer's: a float sum of two safe integers can round across the input
  // it overshoots at the top of the safe range.
  const inconsistent =
    input !== null &&
    cached !== null &&
    cacheWrite !== null &&
    BigInt(input) < BigInt(cached) + BigInt(cacheWrite);
  const uncachedInput =
    input !== null && cached !== null && cacheWrite !== null && !inconsistent
      ? input - cached - cacheWrite
      : null;
  const cachedSum = cached !== null && cacheWrite !== null ? safeTokenSum(cached, cacheWrite) : null;
  // A cache pair whose sum left the safe range is an overflow, not an
  // unreported field: marked, so no later fold revives it (round 84).
  return markOverflowed({
    input_tokens: uncachedInput,
    output_tokens: output,
    cached_input_tokens: cachedSum,
    total_tokens:
      uncachedInput !== null && cached !== null && cacheWrite !== null && output !== null
        ? safeTokenSum(uncachedInput, cached, cacheWrite, output)
        : null,
    cost_usd: null,
  }, cached !== null && cacheWrite !== null && cachedSum === null ? ["cached_input_tokens"] : []);
}
