import type { RunContext } from "./adapters/base.js";
import { CodexPlainFold } from "./plain-unwrap.js";
import { compareVersions, parseVersionParts } from "./harness-compatibility.js";
import type { ExecutableCheck } from "./executable-security.js";
import type { RunRequest, RunResult } from "./types.js";
import { spawnSessionChild, type SessionSpawnOptions } from "./session/spawn.js";
import type { SessionProcess } from "./session/process.js";
import { codexSessionConfigArgs } from "./session/codex-config.js";
import { sandboxRestrictsNetwork } from "./sandbox.js";
import { boundResultEnvelope } from "./result-envelope/common.js";
import { beginCapturedCommand, endCapturedCommand, noteSignaledRun } from "./process-runner-signals.js";
import { exitSignaledRun, SIGNALED_PEER_WAIT_MS } from "./process-runner-exit.js";

// Native evidence read 2026-11-09, Codex rust-v0.166.0:
// https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs#L1349
// defines account/usage/read; app-server/src/request_processors/account_processor.rs:1239-1243
// maps backend native_usage_usd_micros into the camelCase threadUsage response.
const MAX_THREAD_HEADER = 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const COST_READ_TIMEOUT_MS = 3000;
const COST_STOP_GRACE_MS = 100;
const USD_MICROS = 1_000_000;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CostContext = RunContext & { codexNativeCostUsd?: number };
export type CodexCostBinding = {
  command: string[];
  checks: readonly ExecutableCheck[];
  env: Record<string, string>;
  options: SessionSpawnOptions;
  onSignaled?: () => void | Promise<void>;
};
type CostChild = Pick<SessionProcess, "writeLine" | "requestStop" | "settled">;
type CostSpawn = (command: string[], env: Record<string, string>, options: SessionSpawnOptions,
  hooks: Parameters<typeof spawnSessionChild>[3]) => Promise<CostChild>;

/** Only the first exec event is authoritative. A quoted later event must
 * never select another thread's account record. */
export function codexCostThreadId(header: string): string | null {
  if (Buffer.byteLength(header) > MAX_THREAD_HEADER) return null;
  try {
    const value = JSON.parse(header) as Record<string, unknown>;
    return value?.type === "thread.started" && typeof value.thread_id === "string" && THREAD_ID.test(value.thread_id)
      ? value.thread_id : null;
  } catch { return null; }
}

/** Keeps one small first-line record beside the existing streaming fold. */
export class CodexCostFold extends CodexPlainFold {
  private header = "";
  private decided = false;
  threadId: string | null = null;
  override push(chunk: string): void {
    super.push(chunk);
    if (this.decided) return;
    const newline = chunk.indexOf("\n");
    this.header += chunk.slice(0, newline < 0 ? MAX_THREAD_HEADER + 1 : Math.min(newline, MAX_THREAD_HEADER + 1));
    if (Buffer.byteLength(this.header) > MAX_THREAD_HEADER || newline >= 0) {
      this.threadId = codexCostThreadId(this.header);
      this.header = "";
      this.decided = true;
    }
  }
}

/** The backend exposes native dollar usage separately from estimates.
 * Validate identity and integer micros; missing native data remains null. */
export function codexNativeCostUsd(result: unknown, threadId: string): number | null {
  if (result === null || typeof result !== "object") return null;
  const usage = (result as Record<string, unknown>).threadUsage;
  if (usage === null || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  return record.threadId === threadId && typeof record.nativeUsageUsdMicros === "number" &&
    Number.isSafeInteger(record.nativeUsageUsdMicros) && record.nativeUsageUsdMicros >= 0
    ? record.nativeUsageUsdMicros / USD_MICROS : null;
}

/** Reuse the exact exec binary and HOME prefix. Suppression overrides
 * disable startup extensions without changing its credential store. */
export function codexCostCommand(command: readonly string[]): string[] {
  let binary = 0;
  if (command[0]?.endsWith("/env") || command[0] === "env") {
    binary = 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[binary] ?? "")) binary++;
  }
  if (!command[binary] || !command.includes("exec", binary + 1)) throw new Error("Codex cost read requires its resolved exec command");
  const flags = codexSessionConfigArgs({ hermetic: true, tools: "none" });
  const suppression: string[] = [];
  for (let i = 0; i < flags.length; i += 2) {
    if (!flags[i + 1]!.startsWith("cli_auth_credentials_store=")) suppression.push(flags[i]!, flags[i + 1]!);
  }
  return [...command.slice(0, binary + 1), "app-server", ...suppression, "-c", "mcp_servers={}"];
}

/** Exactly initialize + one account metadata read. No thread or model
 * operation is sent. Timeout, unsupported auth, missing data, and malformed
 * replies leave cost unknown. A termination signal still stops the launch. */
export async function readCodexNativeCost(
  binding: CodexCostBinding, threadId: string, spawn: CostSpawn = spawnSessionChild,
  timeoutMs = COST_READ_TIMEOUT_MS
): Promise<number | null> {
  if (!THREAD_ID.test(threadId)) return null;
  let child: CostChild | undefined;
  let finished = false;
  let bytes = 0;
  let phase = 0;
  let finish!: (value: number | null) => void;
  const answer = new Promise<number | null>((resolve) => {
    finish = (value) => { if (!finished) { finished = true; resolve(value); } };
  });
  const timer = setTimeout(() => finish(null), timeoutMs);
  let signaled = false;
  const interrupted = () => {
    if (signaled) return;
    signaled = true;
    noteSignaledRun();
    finish(null);
  };
  beginCapturedCommand(interrupted);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  process.on("SIGHUP", interrupted);
  const write = (value: unknown): void => {
    if (!child?.writeLine(JSON.stringify(value)).ok) finish(null);
  };
  try {
    const pending = spawn(codexCostCommand(binding.command), binding.env, {
      ...binding.options, graceMs: COST_STOP_GRACE_MS,
      extraExecutableChecks: [...(binding.options.extraExecutableChecks ?? []), ...binding.checks],
      abandoned: () => finished || binding.options.abandoned?.() === true,
    }, {
      onFatal: () => finish(null),
      onLine(line) {
        if (finished) return;
        bytes += Buffer.byteLength(line);
        if (bytes > MAX_METADATA_BYTES) { finish(null); return; }
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { finish(null); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { finish(null); return; }
        if (message.id === 1 && phase === 0) {
          if (message.error || !message.result || typeof message.result !== "object") { finish(null); return; }
          phase = 1;
          write({ method: "initialized" });
          write({ id: 2, method: "account/usage/read", params: { threadId } });
        } else if (message.id === 2 && phase === 1) {
          finish(message.error ? null : codexNativeCostUsd(message.result, threadId));
        } else if (message.method && message.id !== undefined) {
          // Never service server tool/approval/auth requests in a metadata read.
          finish(null);
        }
      },
    }).then(async (created) => {
      child = created;
      if (finished) { child.requestStop(); await child.settled; return; }
      void child.settled.then(() => finish(null));
      write({ id: 1, method: "initialize", params: { clientInfo: { name: "codemux", version: "1" }, capabilities: {} } });
    }).catch(() => finish(null));
    const value = await answer;
    if (child) { child.requestStop(); await child.settled; }
    // A late async preflight sees abandoned=true before spawning.
    void pending;
    return value;
  } catch { return null; }
  finally {
    clearTimeout(timer);
    if (signaled) {
      // Keep signal ownership through cleanup and the interruption receipt.
      try { await binding.onSignaled?.(); }
      finally {
        process.removeListener("SIGINT", interrupted);
        process.removeListener("SIGTERM", interrupted);
        process.removeListener("SIGHUP", interrupted);
        endCapturedCommand(interrupted);
        await exitSignaledRun({ peerWaitMs: SIGNALED_PEER_WAIT_MS });
      }
    }
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGHUP", interrupted);
    endCapturedCommand(interrupted);
  }
}

export async function collectCodexNativeCost(
  raw: RunResult, request: RunRequest, context: RunContext, binding: CodexCostBinding,
  providerOverride: boolean, spawn?: CostSpawn
): Promise<void> {
  const version = context.harnessVersion;
  if (request.agent !== "codex" || providerOverride || request.experimentMcp || !raw.success || raw.exitCode !== 0 ||
      sandboxRestrictsNetwork(binding.options.sandboxOptions) || !version || !parseVersionParts(version) || compareVersions(version, "0.166.0") < 0) return;
  const threadId = context.stdoutSink instanceof CodexCostFold ? context.stdoutSink.threadId
    : codexCostThreadId(raw.stdout.slice(0, raw.stdout.indexOf("\n") < 0 ? MAX_THREAD_HEADER + 1 : raw.stdout.indexOf("\n")));
  if (threadId === null) return;
  const cost = await readCodexNativeCost(binding, threadId, spawn);
  if (cost !== null) (context as CostContext).codexNativeCostUsd = cost;
}

export function withCodexNativeCost(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
  const cost = (context as CostContext | undefined)?.codexNativeCostUsd;
  if (cost === undefined || !result.success || result.exitCode !== 0) return result;
  const usage = { input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, ...result.usage, cost_usd: cost };
  if (!request.resultJson) return { ...result, usage };
  try {
    const envelope = JSON.parse(result.stdout);
    if (!envelope?.codemux || typeof envelope.codemux !== "object") return result;
    envelope.codemux.usage = usage;
    return boundResultEnvelope(request.agent,
      { ...result, usage, stdout: `${JSON.stringify(envelope)}\n` }, usage, result.servedModel ?? null);
  } catch { return result; }
}
