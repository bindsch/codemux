import { closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
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
    delivered_t: number; correlation: "exact" | "fifo" | "request_meta"; rpc_id: string | number; result_sha256: string };
  http_request: { method: string; path: string; token_matched: boolean; bytes_base64: string; body_complete: boolean } |
    { method: string; path: "/catalog"; client_version: string | null; authorization_present: boolean; bytes_base64: string; body_complete: boolean };
  http_response: { status: number; bytes_base64: string };
  relay_ping: { rpc_id: string | number };
  relay_reinitialize: { rpc_id: string | number };
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.recordingPath = join(directory, `${this.runId}${spec.control ? ".control" : ""}.jsonl`);
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
