import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentKimiEvidence } from "./experiment-kimi.js";
import { discoverKimiWireLog } from "./experiment-kimi-wire.js";
import { copyExperimentHarnessLog } from "./experiment-harness-log.js";
import { writeKimiExperimentConfig } from "./experiment-kimi-config.js";
import { assertKimiResult } from "./experiment-kimi-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { kimiWireUsage } from "./kimi-wire-log.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import type { ResultUsageBlock } from "./types.js";

/** One run's relay, raw headless stream, and private model-context evidence. */
export class ExperimentKimiRun implements StdoutSink {
  readonly relay: ExperimentHttpRelay;
  readonly evidence: ExperimentKimiEvidence;
  private buffer = "";
  private capture = "";
  private capturedBytes = 0;
  private closed = false;
  private started = false;
  private completePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private removeFailureListener?: () => void;
  private usage?: ResultUsageBlock;
  private logCopied = false;

  constructor(spec: ExperimentSpec, cwd: string, private kimiHome: string,
    private agentFile: string, environment: NodeJS.ProcessEnv) {
    this.relay = new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.validateResult = assertKimiResult;
    this.evidence = new ExperimentKimiEvidence(this.relay, { kimiHome,
      onFailure: (error) => this.relay.fail(error) });
    this.relay.resolveCallId = (call) => this.evidence.resolveCallId(call);
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get hasOutput(): boolean { return this.capturedBytes > 0; }
  get capturedOutput(): string { return this.capture; }

  start(_write: (text: string) => void, end: () => void, abort: () => void): void {
    this.removeFailureListener = this.relay.onFailure(() => abort());
    end();
  }

  closeProtocol(): void {
    this.removeFailureListener?.();
    this.removeFailureListener = undefined;
  }

  async prepare(): Promise<void> {
    if (this.started) return;
    await this.relay.start();
    this.started = true;
    writeKimiExperimentConfig(this.relay, this.kimiHome, this.agentFile);
  }

  push(chunk: string): void {
    if (this.closed || this.capturedBytes > MAX_CAPTURE_BYTES) return;
    this.capture += capturePrefix(chunk, MAX_CAPTURE_BYTES - this.capturedBytes);
    this.capturedBytes += Buffer.byteLength(chunk);
    if (this.capturedBytes > MAX_CAPTURE_BYTES) { this.buffer = ""; return; }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      this.takeLine(line);
    }
  }

  private takeLine(line: string): void {
    this.relay.record("harness_stdout", { bytes_base64: Buffer.from(line).toString("base64") });
    if (!line.trim()) return;
    this.evidence.accept(JSON.parse(line));
  }

  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    if (!this.closed) {
      this.closed = true;
      if (this.buffer !== "" && this.capturedBytes <= MAX_CAPTURE_BYTES) {
        if (options?.timedOut || options?.aborted) {
          this.relay.record("harness_stdout_partial", { bytes_base64: Buffer.from(this.buffer).toString("base64") });
        } else this.takeLine(this.buffer);
      }
      this.buffer = "";
    }
    return this.capture;
  }

  keptBytes(): number { return this.capturedBytes; }
  foldedUsage() {
    if (this.usage) return this.usage;
    try {
      const usage = this.evidence.wireLogPath ? kimiWireUsage(this.evidence.wireLogPath) : null;
      if (usage && this.closed) this.usage = usage;
      return usage;
    }
    catch { return null; }
  }

  terminateProtocol(): void {
    const message = this.hasOutput ? "interrupted before verification" : "interrupted before harness evidence";
    this.relay.fail(new ExperimentFailure(Code.Protocol, message));
    this.evidence.stop(message); this.relay.terminateProtocol();
  }

  /** Verify after the harness has flushed its wire log and before its home is removed. */
  complete(): Promise<void> { return this.completePromise ??= this.verify(); }

  private async verify(): Promise<void> {
    try {
      this.finish();
      this.relay.finish();
      this.evidence.finish();
    } catch (error) { this.relay.fail(error); }
    this.foldedUsage();
    this.preserveHarnessLog();
    if (this.relay.failureError) throw this.relay.failureError;
  }

  preserveHarnessLog(): void {
    if (this.logCopied) return;
    this.logCopied = true;
    copyExperimentHarnessLog("kimi", this.recordingPath, this.relay.runId,
      () => this.evidence.wireLogPath ?? discoverKimiWireLog(this.kimiHome, false), this.relay.record);
  }

  close(): Promise<void> {
    this.closeProtocol(); this.evidence.stop(); this.preserveHarnessLog();
    return this.closePromise ??= this.relay.close();
  }
  closeSync(): void { this.closeProtocol(); this.evidence.stop(); this.preserveHarnessLog(); this.relay.closeSync(); }
}
