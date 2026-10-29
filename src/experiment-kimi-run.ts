import { statSync } from "node:fs";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentKimiEvidence } from "./experiment-kimi.js";
import { discoverKimiWireLog } from "./experiment-kimi-wire.js";
import { copyExperimentHarnessLog } from "./experiment-harness-log.js";
import { writeKimiExperimentConfig } from "./experiment-kimi-config.js";
import { assertKimiResult } from "./experiment-kimi-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { kimiWireUsage } from "./kimi-wire-log.js";
import { MAX_CAPTURE_BYTES, PIPE_GIVE_UP_MS, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import type { ResultUsageBlock } from "./types.js";

const WIRE_FLUSH_POLL_MS = 25;
const WIRE_FLUSH_QUIET_MS = 100;
const isNativeTimeout = (error?: ExperimentFailure): error is ExperimentFailure =>
  error?.code === Code.ServerError && /^kimi tool call timed out after \d+ ms$/.test(error.message);
const isServerExit = (error: ExperimentFailure): boolean => error.code === Code.ServerError &&
  /^experiment MCP (?:stdout closed before run completion|server exited before termination|server exited unexpectedly \(-?\d+\))$/.test(error.message);

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
  private timedOut = false;
  private abort?: () => void;
  private harnessActive = false;
  private harnessExitedAt = 0;
  private pendingServerFailure?: ExperimentFailure;
  private reconciliation?: Promise<void>;
  private serverFailureFinalized = false;

  constructor(spec: ExperimentSpec, cwd: string, private kimiHome: string,
    private agentFile: string, environment: NodeJS.ProcessEnv) {
    this.relay = new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.validateResult = assertKimiResult;
    this.evidence = new ExperimentKimiEvidence(this.relay, { kimiHome,
      onFailure: (error) => this.relay.fail(error) });
    this.relay.mapFailure = (error) => {
      if (!isServerExit(error)) return error;
      this.evidence.refresh(false);
      const native = this.evidence.failureError;
      return isNativeTimeout(native) ? native : error;
    };
    this.relay.deferFailure = (error) => {
      if (this.serverFailureFinalized) return false;
      if (this.pendingServerFailure) return true;
      if (isServerExit(error)) {
        this.pendingServerFailure = error;
        this.abort?.();
        return true;
      }
      return false;
    };
    this.relay.resolveCallId = (call) => this.evidence.resolveCallId(call);
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get hasOutput(): boolean { return this.capturedBytes > 0; }
  get capturedOutput(): string { return this.capture; }

  start(_write: (text: string) => void, end: () => void, abort: () => void): void {
    this.harnessActive = true;
    this.abort = abort;
    this.removeFailureListener = this.relay.onFailure(() => abort());
    end();
    if (this.pendingServerFailure) abort();
  }

  closeProtocol(): Promise<void> {
    if (this.harnessActive) this.harnessExitedAt = Date.now();
    this.harnessActive = false;
    this.abort = undefined;
    this.removeFailureListener?.();
    this.removeFailureListener = undefined;
    return this.reconcileServerFailure();
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
    this.timedOut ||= options?.timedOut === true;
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

  terminateProtocol(options?: { timedOut: boolean }): void {
    this.timedOut ||= options?.timedOut === true;
    this.evidence.refresh(false);
    const native = this.evidence.failureError;
    if (isNativeTimeout(native)) this.relay.fail(native);
    if (!this.timedOut && !this.pendingServerFailure) {
      const message = this.hasOutput ? "interrupted before verification" : "interrupted before harness evidence";
      this.relay.fail(new ExperimentFailure(Code.Protocol, message));
      this.evidence.stop(message);
    }
    this.relay.terminateProtocol();
  }

  /** Verify after the harness has flushed its wire log and before its home is removed. */
  complete(options?: { timedOut?: boolean }): Promise<void> {
    this.timedOut ||= options?.timedOut === true;
    return this.completePromise ??= this.verify();
  }

  private async verify(): Promise<void> {
    try {
      await this.reconcileServerFailure();
      this.finish();
      this.evidence.refresh();
      this.relay.finish();
      this.evidence.finish(undefined, { timedOut: this.timedOut });
    } catch (error) { this.relay.fail(error); }
    this.foldedUsage();
    this.preserveHarnessLog();
    if (this.relay.failureError) throw this.relay.failureError;
  }

  private reconcileServerFailure(): Promise<void> {
    if (!this.pendingServerFailure) return Promise.resolve();
    return this.reconciliation ??= (async () => {
      const deadline = Date.now() + PIPE_GIVE_UP_MS;
      let previousSize: number | undefined, quietSince = Date.now();
      while (true) {
        this.evidence.refresh(false);
        const path = this.evidence.wireLogPath;
        let size: number | undefined;
        try { size = path ? statSync(path).size : undefined; } catch { /* Evidence reports invalid logs. */ }
        const now = Date.now();
        if (this.harnessActive || size !== previousSize) { previousSize = size; quietSince = now; }
        quietSince = Math.max(quietSince, this.harnessExitedAt);
        if ((!this.harnessActive && now - quietSince >= WIRE_FLUSH_QUIET_MS) || now >= deadline) break;
        await Bun.sleep(WIRE_FLUSH_POLL_MS);
      }
      this.finalizeServerFailure();
    })();
  }

  private finalizeServerFailure(): void {
    if (!this.pendingServerFailure) return;
    this.evidence.refresh(false);
    const native = this.evidence.failureError, original = this.pendingServerFailure;
    this.pendingServerFailure = undefined;
    this.serverFailureFinalized = true;
    this.relay.fail(isNativeTimeout(native) ? native : original);
  }

  preserveHarnessLog(): void {
    if (this.logCopied) return;
    this.logCopied = true;
    copyExperimentHarnessLog("kimi", this.recordingPath, this.relay.runId,
      () => this.evidence.wireLogPath ?? discoverKimiWireLog(this.kimiHome, false), this.relay.record);
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      await this.closeProtocol();
      this.evidence.stop(); this.preserveHarnessLog();
      await this.relay.close();
    })();
  }
  closeSync(): void {
    this.harnessActive = false; this.abort = undefined;
    this.removeFailureListener?.(); this.removeFailureListener = undefined;
    this.finalizeServerFailure();
    this.evidence.stop(); this.preserveHarnessLog(); this.relay.closeSync();
  }
}
