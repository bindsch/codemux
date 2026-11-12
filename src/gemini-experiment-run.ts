import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExperimentHttpRelay, type ExperimentRelayCall } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import { readUtf8FileBounded } from "./file-io.js";
import { writeOwnedSync } from "./fs-durable.js";
import type { RunContext } from "./run-context.js";
import type { JsonObject } from "./experiment-server.js";
import { GEMINI_POLICY_FILENAME } from "./gemini-policy.js";
import { assertGeminiExperimentResult, GEMINI_EXPERIMENT_PREFIX, GEMINI_EXPERIMENT_SCHEMA, geminiExperimentArguments, geminiExperimentObject, geminiExperimentToolName, parseGeminiExperimentTelemetry } from "./gemini-experiment-content.js";
import { verifyGeminiExperimentEvidence } from "./gemini-experiment-evidence.js";
import { geminiTelemetryEnvironment, GEMINI_MAX_TELEMETRY_BYTES } from "./gemini-telemetry.js";

export const GEMINI_EXPERIMENT_TOKEN_ENV = "CODEMUX_GEMINI_EXPERIMENT_TOKEN";
const GEMINI_MAX_NATIVE_CALLS = 10000;
const GEMINI_MAX_PENDING_IDENTITIES = 64;
export type GeminiExperimentContext = RunContext & { experimentGemini?: GeminiExperimentRun; geminiTelemetryPath?: string };
export type GeminiExperimentSpec = ExperimentSpec & { accept_harness_schema?: string[] };
export type GeminiExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" | "calls" | "toolDefinitions" |
  "record" | "failureError" | "resolveCallId" | "validateResult" | "onFailure" | "start" | "finish" | "fail" | "terminateProtocol" | "close" | "closeSync">;

/** The relay is authenticated loopback. Telemetry is local-only, and its
 * raw bytes are retained before the private home is removed. Native MCP
 * requests have no call ID, so stdout must identify exactly one pending
 * call with identical tool name and arguments before server dispatch.
 * Installed Gemini 0.60.0, read 2026-11-09: gemini-LUNNHKPJ.js:11890
 * emits tool_use with tool_id/name/parameters before scheduling;
 * chunk-M6NSK26M.js:369260 callTool adds only a random progressToken.
 * :285134 resolveTelemetrySettings reads these environment overrides;
 * :288195 telemetryOutfile selects local file exporters. */
export class GeminiExperimentRun implements StdoutSink {
  readonly relay: GeminiExperimentRelay;
  readonly evidencePath: string;
  private capture = "";
  private pendingLine = "";
  private bytes = 0;
  private preparing?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private finished = false;
  private interrupted = false;
  private copied = false;
  private nativeCalls = new Map<string, JsonObject>();
  private claimed = new Set<string>();
  private waiters = new Set<() => void>();
  private removeFailureListener?: () => void;

  constructor(spec: GeminiExperimentSpec, cwd: string, private readonly home: string, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, relay?: GeminiExperimentRelay) {
    if (!spec.accept_harness_prefix?.includes(GEMINI_EXPERIMENT_PREFIX)) throw new ExperimentFailure(Code.UnsupportedResult, "Gemini requires explicit gemini-untrusted-context acceptance");
    if (!spec.accept_harness_schema?.includes(GEMINI_EXPERIMENT_SCHEMA)) throw new ExperimentFailure(Code.InventoryMismatch, "Gemini requires explicit gemini-wait-for-previous schema acceptance");
    this.evidencePath = join(home, "experiment-telemetry.json");
    this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.validateResult = assertGeminiExperimentResult;
    this.relay.resolveCallId = (call) => this.resolveNativeCall(call);
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }
  get hasOutput(): boolean { return this.bytes > 0; }
  get environment(): Record<string, string> {
    return { [GEMINI_EXPERIMENT_TOKEN_ENV]: this.relay.token, ...geminiTelemetryEnvironment(this.evidencePath) };
  }

  prepare(version?: string | null): Promise<void> {
    return this.preparing ??= (async () => {
      try {
        if (version !== "0.60.0") throw new ExperimentFailure(Code.Protocol, "Gemini experiment serialization is pinned to installed version 0.60.0");
        await this.relay.start();
        writeFileSync(this.evidencePath, "", { mode: 0o600, flag: "wx" });
        const path = join(this.home, ".gemini", "settings.json");
        const settings = geminiExperimentObject(JSON.parse(readUtf8FileBounded(path, { maxBytes: 1024 * 1024, label: "Gemini private settings", noFollow: true })));
        settings.tools = { core: [] };
        settings.mcpServers = { [this.relay.spec.name]: { httpUrl: this.relay.url,
          headers: { Authorization: `Bearer \${${GEMINI_EXPERIMENT_TOKEN_ENV}}` },
          timeout: experimentToolTimeoutSeconds(this.relay.spec) * 1000 } };
        writeOwnedSync(path, JSON.stringify(settings), 0o600);
        writeOwnedSync(join(this.home, GEMINI_POLICY_FILENAME),
          `[[rule]]\ntoolName = "*"\nmcpName = ${JSON.stringify(this.relay.spec.name)}\ndecision = "allow"\npriority = 999\n\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n`, 0o600);
      } catch (error) { this.relay.fail(error); throw error; }
    })();
  }

  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    this.removeFailureListener = this.relay.onFailure(() => { this.wake(); abort(); });
    if (this.relay.failureError) { abort(); return; }
    write(this.prompt); end();
  }

  push(chunk: string): void {
    if (this.finished) return;
    this.capture += capturePrefix(chunk, Math.max(0, MAX_CAPTURE_BYTES - this.bytes));
    this.bytes += Buffer.byteLength(chunk);
    try {
      if (this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini stdout exceeds capture bound");
      this.pendingLine += chunk;
      let newline: number;
      while ((newline = this.pendingLine.indexOf("\n")) >= 0) {
        const line = this.pendingLine.slice(0, newline); this.pendingLine = this.pendingLine.slice(newline + 1);
        if (!line.trim()) continue;
        const event = geminiExperimentObject(JSON.parse(line));
        if (event.type !== "tool_use") continue;
        if (typeof event.tool_id !== "string" || !event.tool_id || this.nativeCalls.has(event.tool_id) || this.nativeCalls.size >= GEMINI_MAX_NATIVE_CALLS) {
          throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini native call identity is missing, repeated or exceeds its bound");
        }
        this.nativeCalls.set(event.tool_id, event);
      }
      this.wake();
    } catch (error) { this.relay.fail(error); this.wake(); }
  }

  private async resolveNativeCall(call: ExperimentRelayCall): Promise<string> {
    for (;;) {
      if (this.relay.failureError) throw this.relay.failureError;
      const matches = [...this.nativeCalls].filter(([, event]) => event.tool_name === geminiExperimentToolName(this.relay.spec.name, call.name) && geminiExperimentArguments(event.parameters, call.input));
      // Two identical native calls are ambiguous even if one was claimed:
      // a duplicate HTTP request cannot borrow the second call's identity.
      if (matches.length > 1) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini parallel calls with identical arguments are ambiguous");
      const id = matches[0]?.[0];
      if (id) {
        if (this.claimed.has(id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini native call was already claimed");
        this.claimed.add(id); return id;
      }
      if (this.finished || this.interrupted) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini MCP request lacks a native stdout identity");
      if (this.waiters.size >= GEMINI_MAX_PENDING_IDENTITIES) throw new ExperimentFailure(Code.CallIdUnresolved, "Gemini pending native identities exceed 64");
      await new Promise<void>((resolve) => { this.waiters.add(resolve); });
    }
  }

  private wake(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.interrupted ||= options?.timedOut === true || options?.aborted === true;
    this.finished = true; this.wake(); return this.capture;
  }
  keptBytes(): number { return this.bytes; }
  closeProtocol(): void { this.removeFailureListener?.(); this.removeFailureListener = undefined; this.finished = true; this.wake(); }
  terminateProtocol(): void { this.interrupted = true; this.wake(); this.relay.terminateProtocol(); }

  complete(options?: { timedOut: boolean }): Promise<void> {
    this.interrupted ||= options?.timedOut === true;
    return this.completing ??= (async () => {
      try {
        const evidence = readUtf8FileBounded(this.evidencePath, { maxBytes: GEMINI_MAX_TELEMETRY_BYTES, label: "Gemini experiment telemetry", noFollow: true });
        this.preserve(evidence);
        if (this.interrupted || this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Gemini experiment capture was interrupted or oversized");
        this.relay.finish();
        verifyGeminiExperimentEvidence(this.relay, parseGeminiExperimentTelemetry(evidence), this.capture);
      } catch (error) { this.relay.fail(error); }
      if (this.relay.failureError) throw this.relay.failureError;
    })();
  }

  close(): Promise<void> { this.closeProtocol(); this.preserve(); return this.closing ??= this.relay.close(); }
  closeSync(): void { this.closeProtocol(); this.preserve(); this.relay.closeSync(); }
  private preserve(known?: string): void {
    if (this.copied || !this.preparing) return;
    this.copied = true;
    try {
      const evidence = known ?? readUtf8FileBounded(this.evidencePath, { maxBytes: GEMINI_MAX_TELEMETRY_BYTES, label: "Gemini experiment telemetry", noFollow: true });
      this.relay.record("gemini_evidence_copy", { bytes_base64: Buffer.from(evidence).toString("base64") });
      this.relay.record("harness_stdout", { bytes_base64: Buffer.from(this.capture).toString("base64") });
    } catch (error) { this.relay.fail(error); }
  }
}
