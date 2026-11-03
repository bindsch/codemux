import { chmodSync, closeSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { codemuxStateDir } from "./call-log.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import type { JsonObject } from "./experiment-server.js";

const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
type RecordingWriter = (fd: number, bytes: Buffer, offset: number, length: number, position: number) => number;

export enum ExperimentFailureCode {
  CallIdUnresolved = "call_id_unresolved",
  ResultChanged = "result_changed",
  UnknownTool = "unknown_tool",
  CodeMode = "code_mode",
  ModelRequired = "model_required",
  ModelUnavailable = "model_unavailable",
  InventoryMismatch = "inventory_mismatch",
  HarnessLogMissing = "harness_log_missing",
  MessageIdMissing = "message_id_missing",
  ServerError = "server_error",
  UnsupportedResult = "unsupported_result",
  Protocol = "protocol",
}

export class ExperimentFailure extends Error {
  constructor(readonly code: ExperimentFailureCode, message: string) {
    super(message);
    this.name = "ExperimentFailure";
  }
}

export function experimentFailure(error: unknown): ExperimentFailure {
  return error instanceof ExperimentFailure ? error : new ExperimentFailure(
    ExperimentFailureCode.Protocol, error instanceof Error ? error.message : String(error));
}

export type ExperimentUsage = { input: number; output: number; cache_read: number; cache_write: number };
export interface ExperimentRecordFields {
  [kind: string]: JsonObject;
  failure: { code: ExperimentFailureCode; message: string };
  run_end: JsonObject & { code: ExperimentFailureCode | null; error: string | null };
  turn: { message_id: string; t: number; usage: ExperimentUsage | null; tool_calls: { call_id: string; name: string }[] };
  turn_usage: { message_id: string; usage: ExperimentUsage; t: number };
  turn_call: { message_id: string; call_id: string; name: string; t: number };
  harness_log_copy: { harness: "codex" | "kimi"; path: string; bytes: number } |
    { harness: "codex" | "kimi"; path: string; error: string };
  harness_stdout_partial: { bytes_base64: string };
  tool_result_delivered: { call_id: string; t: number };
  call_ledger: { relay_request_seq: number | string; native_call_id: string | null; dispatched_t: number;
    delivered_t: number; correlation: "exact" | "fifo" | "request_meta" | "retry" | "retry_cached";
    rpc_id: string | number; result_sha256: string };
  http_request: { method: string; path: string; token_matched: boolean; bytes_base64: string; body_complete: boolean } |
    { method: string; path: "/catalog"; client_version: string | null; authorization_present: boolean; bytes_base64: string; body_complete: boolean };
  http_response: { status: number; bytes_base64: string };
  relay_ping: { rpc_id: string | number };
  relay_reinitialize: { rpc_id: string | number };
  relay_resources: { method: string; rpc_id: string | number | null };
  harness_top_level_tools: { tools: JsonObject; t: number };
  harness_builtin_call: { call_id: string; name: string; input: unknown; harness_output: unknown };
  relay_sse: { rpc_id: string | number; keepalives: number };
  relay_delivery_failed: { rpc_id: string | number; relay_request_seq?: number; message: string };
}
export type ExperimentRecord = <K extends keyof ExperimentRecordFields & string>(kind: K, fields: ExperimentRecordFields[K]) => void;
export function turnRecord(message_id: string, t: number, usage: ExperimentUsage | null,
  tool_calls: ExperimentRecordFields["turn"]["tool_calls"]): ExperimentRecordFields["turn"] {
  return { message_id, t, usage, tool_calls };
}
export function turnUsageRecord(message_id: string, usage: ExperimentUsage, t: number): ExperimentRecordFields["turn_usage"] {
  return { message_id, usage, t };
}
export function turnCallRecord(message_id: string, call_id: string, name: string, t: number): ExperimentRecordFields["turn_call"] {
  return { message_id, call_id, name, t };
}
export function toolResultDeliveredRecord(call_id: string, t: number): ExperimentRecordFields["tool_result_delivered"] {
  return { call_id, t };
}

/** Hash JSON content with sorted object keys and unchanged array order. */
export function resultContentSha256(content: unknown): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const object = value as JsonObject;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("experiment result content must be JSON");
    return json;
  };
  return createHash("sha256").update(canonical(content)).digest("hex");
}

/** Whether the path exists and is a symbolic link (never follows it). */
function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolve a configured recording directory to the real path it denotes:
 * the longest existing ancestor is realpath'ed, the missing tail stays
 * literal so the caller's chosen name is kept. An ancestor that exists
 * but cannot be resolved (permissions, a symlink loop) throws, naming
 * the configured path. */
function resolveRecordingDirectory(directory: string): string {
  const tail: string[] = [];
  let current = directory;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `experiment MCP recording directory cannot be resolved: ${directory} (` +
            `${(error as NodeJS.ErrnoException).code ?? "realpath failed"})`
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`experiment MCP recording directory cannot be resolved: ${directory}`);
    }
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The recording directory is a placement guarantee, not a preference: a
 * persistent recording (prompts, tool results, server stderr) must land
 * where the run put it and stay readable by this user alone. `mkdirSync`
 * alone does neither — it succeeds through a symlinked directory and never
 * tightens a directory that already exists — so after creating it the path
 * is lstat'ed: a symlink or a directory another user owns is refused, and
 * the mode is set to 0700 (the call ledger's rule, src/call-log.ts).
 */
export function assertPrivateRecordingDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`experiment MCP recording directory must be a real directory, not a link: ${directory}`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`experiment MCP recording directory must be owned by the current user: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

/** The shared private, bounded JSONL recording for one experiment run. */
export class ExperimentRecording {
  readonly runId = randomUUID();
  readonly recordingPath: string;
  private fd: number;
  private sequence = 0;
  private bytes = 0;
  private closed = false;

  constructor(spec: ExperimentSpec, cwd: string, environment: NodeJS.ProcessEnv, startFields: JsonObject = {},
    private readonly write: RecordingWriter = writeSync) {
    const directory = spec.recording ?? join(codemuxStateDir(environment), "experiments");
    // The directory is resolved before it is created (review round 8,
    // edges): a recursive mkdir follows a symlinked ancestor, so the
    // recording and the 0700 chmod could land wherever that link points.
    // A symlink at the configured leaf is still refused outright; an
    // existing ancestor is resolved, so the recording, its mode, and
    // `recordingPath` all name the real directory the configured
    // spelling denotes, never a link along the way. An ancestor that
    // exists but cannot be resolved refuses, naming the configured path.
    if (isSymbolicLink(directory)) {
      throw new Error(`experiment MCP recording directory must be a real directory, not a link: ${directory}`);
    }
    const resolved = resolveRecordingDirectory(directory);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    assertPrivateRecordingDirectory(resolved);
    this.recordingPath = join(resolved, `${this.runId}${spec.control ? ".control" : ""}.jsonl`);
    this.fd = openSync(this.recordingPath, "wx", 0o600);
    try {
      this.record("run_start", { server: spec.name, cwd, env_names: spec.env,
        server_sandbox: "outside scode; experiment-owned", harness_sandbox: "scode read-only", ...startFields });
      console.error(`codemux: experiment MCP recording: ${this.recordingPath}`);
    } catch (error) { this.discard(); throw error; }
  }

  readonly record: ExperimentRecord = (kind, fields) => {
    if (this.closed) return;
    for (const key of ["run_id", "seq", "kind"]) {
      if (Object.hasOwn(fields, key)) throw new ExperimentFailure(ExperimentFailureCode.Protocol,
        `experiment record fields contain reserved field ${key}`);
    }
    const { t, ...payload } = fields;
    const line = JSON.stringify({ run_id: this.runId, seq: this.sequence,
      t: t ?? Date.now() / 1000, kind, ...payload }) + "\n";
    const bytes = Buffer.from(line);
    if (this.bytes + bytes.length > MAX_RECORDING_BYTES && kind !== "failure" && kind !== "run_end") {
      throw new Error("experiment MCP recording exceeds 256 MiB");
    }
    let offset = 0;
    try {
      // Positional writes also keep the next record at the rollback boundary.
      while (offset < bytes.length) offset += this.write(this.fd, bytes, offset, bytes.length - offset, this.bytes + offset);
    } catch (error) {
      ftruncateSync(this.fd, this.bytes);
      throw error;
    }
    this.bytes += bytes.length;
    this.sequence++;
  };

  close(fields: ExperimentRecordFields["run_end"]): void {
    if (this.closed) return;
    try { this.record("run_end", fields); fsyncSync(this.fd); }
    finally { this.closed = true; closeSync(this.fd); }
  }

  discard(): void {
    if (this.closed) return;
    this.closed = true;
    try { closeSync(this.fd); }
    finally { unlinkSync(this.recordingPath); }
  }
}
