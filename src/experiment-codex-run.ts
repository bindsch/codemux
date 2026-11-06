import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readUtf8FileBounded, statEntryPresent } from "./file-io.js";
import { assertTrustedDirectory } from "./hermetic-home.js";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentCodexEvidence } from "./experiment-codex.js";
import { copyExperimentHarnessLog } from "./experiment-harness-log.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import type { CodexExperimentModel } from "./experiment-codex-model.js";
import { CODEX_EXPERIMENT_PROVIDER_ID, CODEX_EXPERIMENT_OMITTED_SURFACES,
  codexCatalogProviderTable } from "./experiment-codex-config.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { CodexPlainFold } from "./plain-unwrap.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_SECONDS = 120;

/** One run's relay, exec events, and private rollout evidence. */
export class ExperimentCodexRun implements StdoutSink {
  private state?: { relay: ExperimentHttpRelay; evidence: ExperimentCodexEvidence };
  readonly fold = new CodexPlainFold();
  private buffer = "";
  // The first nonempty stdout line selects the plain stream regime.
  private wireStarted?: boolean;
  private capture = "";
  private capturedBytes = 0;
  private overflowed = false;
  private closed = false;
  private started = false;
  private completePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private removeFailureListener?: () => void;
  private logCopied = false;
  private timedOut = false;

  constructor(private spec: ExperimentSpec, private cwd: string, private codexHome: string,
    private resultJson: boolean, private environment: NodeJS.ProcessEnv, private prompt = "", private selection?: CodexExperimentModel,
    private onRecording?: (path: string) => void) {}

  get relay(): ExperimentHttpRelay {
    if (!this.state) throw new Error("Codex experiment relay has not started");
    return this.state.relay;
  }
  get evidence(): ExperimentCodexEvidence {
    if (!this.state) throw new Error("Codex experiment evidence has not started");
    return this.state.evidence;
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get startedRecordingPath(): string | undefined { return this.state?.relay.recordingPath; }
  get hasEvidence(): boolean { return this.state?.evidence.hasThread ?? false; }
  get failureError(): ExperimentFailure | null { return this.state?.relay.failureError ?? null; }
  get model(): string | undefined { return this.selection?.model; }
  get capturedOutput(): string { return this.resultJson ? this.capture : this.wireStarted ? this.fold.finish() : ""; }

  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    let failed = false;
    this.removeFailureListener = this.relay.onFailure(() => { failed = true; abort(); });
    if (!failed) { write(this.prompt); end(); }
  }

  closeProtocol(): void {
    this.removeFailureListener?.();
    this.removeFailureListener = undefined;
  }

  async prepare(version?: string | null): Promise<void> {
    if (this.started) return;
    if (this.selection && !version) {
      throw new ExperimentFailure(Code.CodeMode,
        `Codex model cache ${this.selection.sourcePath} cannot be served: the Codex version was not detected`);
    }
    // The cache is shared by every Codex client on the machine (the ChatGPT
    // desktop app's app-server daemon rewrites it about hourly with its own
    // client_version), so a version other than the CLI's is a fact to record
    // and warn about, not a refusal: the served catalog body is recorded
    // either way (live gate, 2026-11-02).
    const cacheVersionMismatch = this.selection && version !== this.selection.clientVersion
      ? { cache_client_version: this.selection.clientVersion, codex_version: version!, source_path: this.selection.sourcePath }
      : null;
    if (cacheVersionMismatch) {
      console.error(`Warning: codex model cache ${this.selection!.sourcePath} was written by Codex client ${this.selection!.clientVersion}; ` +
        `the experiment runs codex ${version} and serves that cache's catalog`);
    }
    assertTrustedDirectory(this.codexHome);
    const path = join(this.codexHome, "config.toml");
    // An uninspectable path refuses rather than reading as empty: a stat
    // error folded into "absent" would silently drop the existing config
    // this write merges into (review round 169).
    const previous = statEntryPresent(path, (code) => {
      throw new Error(`${path} could not be inspected (${code})`);
    })
      ? readUtf8FileBounded(path, { maxBytes: MAX_CONFIG_BYTES, label: "private Codex config" }) : "";
    const relay = new ExperimentHttpRelay(this.spec, this.cwd, this.environment, { catalog: this.selection?.catalog,
      startFields: { omit_tools_from: CODEX_EXPERIMENT_OMITTED_SURFACES } });
    const evidence = new ExperimentCodexEvidence(relay, { codexHome: this.codexHome,
      catalogRequired: this.selection?.catalog !== undefined, onFailure: (error) => relay.fail(error) });
    this.state = { relay, evidence };
    this.onRecording?.(relay.recordingPath);
    relay.resolveCallId = (call, request) => evidence.resolveCallId(call, request);
    if (this.selection?.catalog) relay.record("catalog_override", this.selection.catalog.override);
    if (cacheVersionMismatch) relay.record("catalog_client_version_mismatch", cacheVersionMismatch);
    await relay.start();
    this.started = true;
    const table = [
      `[mcp_servers.${this.relay.spec.name}]`,
      `url = ${JSON.stringify(this.relay.url)}`,
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${this.relay.token}`)} }`,
      "required = true",
      `startup_timeout_sec = ${STARTUP_TIMEOUT_SECONDS}`,
      `tool_timeout_sec = ${experimentToolTimeoutSeconds(this.spec)}`,
      `omit_tools_from = [${CODEX_EXPERIMENT_OMITTED_SURFACES.map((surface) => JSON.stringify(surface)).join(", ")}]`,
    ].join("\n");
    const temporary = join(this.codexHome, `config.${randomBytes(8).toString("hex")}.toml`);
    const provider = this.relay.catalogUrl ? codexCatalogProviderTable(version!, this.relay.catalogUrl) : "";
    // A root key must precede any tables already in the private config.
    const selection = provider ? `model_provider = ${JSON.stringify(CODEX_EXPERIMENT_PROVIDER_ID)}\n` : "";
    writeFileSync(temporary, `${selection}${previous}\n${provider}\n${table}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  }

  push(chunk: string): void {
    if (this.closed || this.overflowed) return;
    this.fold.push(chunk);
    if (this.resultJson) {
      this.capture += capturePrefix(chunk, MAX_CAPTURE_BYTES - this.capturedBytes);
      this.capturedBytes += Buffer.byteLength(chunk);
    }
    if (this.capturedBytes > MAX_CAPTURE_BYTES || this.fold.keptBytes() > MAX_CAPTURE_BYTES) {
      this.overflowed = true; this.buffer = ""; return;
    }
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.takeLine(line);
      if (this.overflowed) { this.buffer = ""; return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_CAPTURE_BYTES) { this.overflowed = true; this.buffer = ""; }
  }

  private takeLine(line: string): void {
    if (line.trim() === "") return;
    if (Buffer.byteLength(line) > MAX_CAPTURE_BYTES) { this.overflowed = true; return; }
    const frame = JSON.parse(line);
    this.wireStarted ??= frame?.type === "thread.started";
    this.evidence.accept(frame);
  }

  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.timedOut ||= options?.timedOut === true;
    if (!this.closed) {
      this.closed = true;
      if (this.buffer !== "" && !this.overflowed) {
        if (options?.timedOut || options?.aborted) {
          this.relay.record("harness_stdout_partial", { bytes_base64: Buffer.from(this.buffer).toString("base64") });
        } else this.takeLine(this.buffer);
      }
      this.buffer = "";
    }
    const reply = this.fold.finish();
    return this.resultJson ? this.capture : reply;
  }

  keptBytes(): number { return this.overflowed ? MAX_CAPTURE_BYTES + 1 : this.resultJson ? this.capturedBytes : this.fold.keptBytes(); }
  foldedUsage() { return this.fold.foldedUsage(); }

  terminateProtocol(): void { this.state?.relay.terminateProtocol(); }

  /** Verify only after the harness has exited and flushed its rollout. */
  complete(): Promise<void> { return this.verify(); }

  verify(options?: { timedOut: boolean }): Promise<void> {
    this.timedOut ||= options?.timedOut === true;
    return this.completePromise ??= this.verifyEvidence();
  }

  private async verifyEvidence(): Promise<void> {
    try {
      this.finish();
      this.evidence.finish(this.codexHome, { timedOut: this.timedOut });
      this.relay.finish();
    } catch (error) {
      this.relay.fail(error instanceof Error ? error : new Error(String(error)));
    }
    this.preserveHarnessLog();
    if (this.relay.failureError) throw this.relay.failureError;
  }

  preserveHarnessLog(): void {
    if (!this.state || this.logCopied) return;
    this.logCopied = true;
    copyExperimentHarnessLog("codex", this.recordingPath, this.relay.runId, () => this.evidence.rolloutPath, this.relay.record);
  }

  interruptBeforeEvidence(): void {
    if (this.state && !this.hasEvidence) this.relay.fail(new ExperimentFailure(Code.Protocol,
      "interrupted before harness evidence"));
  }

  close(): Promise<void> {
    if (!this.state) return Promise.resolve();
    this.closeProtocol(); this.evidence.stop(); this.preserveHarnessLog();
    return this.closePromise ??= this.relay.close();
  }
  closeSync(): void {
    if (!this.state) return;
    this.closeProtocol(); this.evidence.stop(); this.preserveHarnessLog(); this.relay.closeSync();
  }
}
