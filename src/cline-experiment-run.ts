import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import { readUtf8FileBounded } from "./file-io.js";
import { assertTrustedDirectory } from "./hermetic-home.js";
import { UsageRefusalError } from "./validation.js";
import { CLINE_EXPERIMENT_CAPTURE_BYTES, CLINE_EXPERIMENT_TOKEN_ENV, clineExperimentCaptureEnv, clineExperimentPluginSource } from "./cline-experiment-plugin.js";
import { assertClineExperimentResult, clineExperimentToolName, clineObject, verifyClineExperimentEvidence, verifyClineToolsNoneCaptures } from "./cline-experiment-content.js";
import type { JsonObject } from "./experiment-server.js";

// Cline cli-v3.0.74, inspected 2026-11-09: native plugin discovery and final capture.
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L618-L644
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/llms/src/providers/provider-request-capture.ts#L302-L406
export type ClineExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" | "calls" | "toolDefinitions" |
  "record" | "failureError" | "resolveCallId" | "validateResult" | "onFailure" | "start" | "finish" | "fail" | "noteRunOutcome" | "terminateProtocol" | "close" | "closeSync">;

export function readClineCaptures(directory: string): JsonObject[] {
  assertTrustedDirectory(directory);
  let bytes = 0;
  const files = readdirSync(directory).filter((name) => name.endsWith(".provider-request.json"));
  if (files.length > 10_000) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline native capture exceeds 10000 files");
  return files.sort().map((name) => {
    const text = readUtf8FileBounded(join(directory, name), { maxBytes: CLINE_EXPERIMENT_CAPTURE_BYTES, label: "Cline native wire capture", noFollow: true });
    bytes += Buffer.byteLength(text);
    if (bytes > CLINE_EXPERIMENT_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline native captures exceed 32 MiB");
    const capture = clineObject(JSON.parse(text));
    // Cline omits headers, but a custom endpoint URL can itself contain
    // credentials. Retain only the request body and native correlation.
    return { captureStage: capture.captureStage, mode: capture.mode, timestamp: capture.timestamp, attempt: capture.attempt,
      correlation: { runId: capture.correlation?.runId, iteration: capture.correlation?.iteration },
      payload: { method: capture.payload?.method, body: capture.payload?.body, truncated: capture.payload?.truncated } };
  }).filter((capture) => capture.captureStage === "wire_request");
}

function install(configDir: string, timeoutMs: number, endpoint?: { url: string; name: string }) {
  assertTrustedDirectory(configDir);
  const plugins = join(configDir, "plugins"), captureDir = join(configDir, "experiment-captures");
  for (const path of [plugins, captureDir]) { mkdirSync(path, { recursive: true, mode: 0o700 }); assertTrustedDirectory(path); }
  const evidencePath = join(configDir, "experiment-evidence.jsonl"), pluginPath = join(plugins, "codemux-experiment.js");
  writeFileSync(evidencePath, "", { mode: 0o600, flag: "wx" });
  writeFileSync(pluginPath, clineExperimentPluginSource(evidencePath, timeoutMs, endpoint), { mode: 0o600, flag: "wx" });
  return { evidencePath, pluginPath, captureDir, env: clineExperimentCaptureEnv(captureDir) };
}

/** The caller must independently disable native builtins and isolate every
 * other plugin/MCP/configured-agent channel. Cline ignores failed plugin hooks. */
export function installClineToolsNone(configDir: string, providerId: string) {
  if (providerId !== "codemux-override") throw new UsageRefusalError("cline --tools none requires an explicit custom provider override");
  const installed = install(configDir, experimentToolTimeoutSeconds({}) * 1000);
  return { ...installed, verify: () => verifyClineToolsNoneCaptures(readClineCaptures(installed.captureDir)) };
}

/** Preparation is awaited before spawn; evidence is retained and verified
 * before the adapter removes the private configuration. The server remains
 * outside scode; only the authenticated loopback relay enters the plugin. */
export class ClineExperimentRun implements StdoutSink {
  readonly relay: ClineExperimentRelay;
  readonly evidencePath: string;
  readonly pluginPath: string;
  readonly captureDir: string;
  private capture = "";
  private evidenceCapture = "";
  private bytes = 0;
  private preparing?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private interrupted = false;
  private finished = false;
  private copied = false;
  private prepared = false;
  private removeFailureListener?: () => void;

  constructor(spec: ExperimentSpec, cwd: string, private readonly configDir: string, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, relay?: ClineExperimentRelay) {
    this.evidencePath = join(configDir, "experiment-evidence.jsonl");
    this.pluginPath = join(configDir, "plugins", "codemux-experiment.js");
    this.captureDir = join(configDir, "experiment-captures");
    this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.validateResult = assertClineExperimentResult;
    this.relay.resolveCallId = async (call, request) => {
      const id = request.params?._meta?.["codemux/callId"];
      const matches = this.readEvidence().filter((event) => event.kind === "dispatch" && event.fields.call_id === id &&
        event.fields.name === clineExperimentToolName(spec.name, call.name) && isDeepStrictEqual(event.fields.input, call.input));
      if (typeof id !== "string" || !id || matches.length !== 1) throw new ExperimentFailure(Code.CallIdUnresolved, "Cline relay request lacks matching native call evidence");
      return id;
    };
  }
  get env(): Record<string, string> { return { ...clineExperimentCaptureEnv(this.captureDir), [CLINE_EXPERIMENT_TOKEN_ENV]: this.relay.token }; }
  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }
  get hasOutput(): boolean { return this.bytes > 0; }
  get isPrepared(): boolean { return this.prepared; }
  scanSurface(): string { return `${this.capture}\n${this.evidenceCapture}`; }
  prepare(): Promise<void> {
    return this.preparing ??= (async () => {
      try {
        await this.relay.start();
        install(this.configDir, experimentToolTimeoutSeconds(this.relay.spec) * 1000, { url: this.relay.url, name: this.relay.spec.name });
        this.prepared = true;
      } catch (error) { this.relay.fail(error); throw error; }
    })();
  }
  private readEvidence(): JsonObject[] {
    const text = readUtf8FileBounded(this.evidencePath, { maxBytes: CLINE_EXPERIMENT_CAPTURE_BYTES, label: "Cline plugin evidence", noFollow: true });
    if (text && !text.endsWith("\n")) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline plugin evidence is truncated");
    return text.split("\n").filter(Boolean).map((line) => clineObject(JSON.parse(line)));
  }
  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    this.closeProtocol(); this.removeFailureListener = this.relay.onFailure(abort);
    if (this.relay.failureError) { abort(); return; }
    write(this.prompt); end();
  }
  push(chunk: string): void {
    if (this.finished) return;
    this.capture += capturePrefix(chunk, Math.max(0, MAX_CAPTURE_BYTES - this.bytes)); this.bytes += Buffer.byteLength(chunk);
  }
  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.interrupted ||= options?.timedOut === true || options?.aborted === true;
    this.finished = true; return this.capture;
  }
  keptBytes(): number { return this.bytes; }
  closeProtocol(): void { this.removeFailureListener?.(); this.removeFailureListener = undefined; }
  terminateProtocol(): void { this.interrupted = true; this.relay.terminateProtocol(); }
  interruptBeforeEvidence(): void { this.terminateProtocol(); this.relay.fail(new Error("interrupted before Cline experiment verification")); }
  complete(options?: { timedOut: boolean }): Promise<void> {
    this.interrupted ||= options?.timedOut === true;
    return this.completing ??= (async () => {
      try {
        this.preserveEvidence();
        if (this.interrupted || this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Cline experiment capture was interrupted or exceeded its bound");
        verifyClineExperimentEvidence(this.relay, this.readEvidence(), readClineCaptures(this.captureDir), this.capture);
        this.relay.finish();
      } catch (error) { this.relay.fail(error); }
      if (this.relay.failureError) throw this.relay.failureError;
    })();
  }
  private preserveEvidence(): void {
    if (this.copied || !this.preparing) return;
    this.copied = true;
    try {
      const evidence = readUtf8FileBounded(this.evidencePath, { maxBytes: CLINE_EXPERIMENT_CAPTURE_BYTES, label: "Cline plugin evidence", noFollow: true });
      const captures = readClineCaptures(this.captureDir);
      this.evidenceCapture = `${evidence}\n${JSON.stringify(captures)}`;
      this.relay.record("cline_evidence_copy", { bytes_base64: Buffer.from(this.evidenceCapture).toString("base64") });
      this.relay.record("harness_stdout", { bytes_base64: Buffer.from(this.capture).toString("base64") });
    } catch (error) { this.relay.fail(error); }
  }
  close(): Promise<void> { this.closeProtocol(); this.preserveEvidence(); return this.closing ??= this.relay.close(); }
  closeSync(): void { this.closeProtocol(); this.preserveEvidence(); this.relay.closeSync(); }
}
