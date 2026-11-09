/** Qwen 0.24.0, read 2026-11-09 from @qwen-code/qwen-code:
 * chunks/chunk-HWKWZSZY.js:48574 keeps topTierMcpServers in safe mode;
 * chunk-BSIOCNDK.js:181 accepts --mcp-config files. Settings mcpServers
 * are discarded in safe mode, so the private file must be explicit.
 * chunk-SNPYTKXI.js:128512,128752 uses timeout (milliseconds), httpUrl,
 * and headers; trust approves only the configured experiment server.
 * --openai-logging-dir captures provider requests before native display
 * truncation. qwen-experiment-content.ts verifies those requests.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { capturePrefix } from "./experiment-capture.js";
import { readFileBytesBounded, readUtf8FileBounded } from "./file-io.js";
import { prepareRunDirParent } from "./hermetic-home.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { assertQwenExperimentResult, qwenExperimentCalls, qwenExperimentToolName, verifyQwenExperimentEvidence } from "./qwen-experiment-content.js";
import type { JsonObject } from "./experiment-server.js";
import type { RunRequest, RunResult } from "./types.js";
import { parseQwenResultEnvelope, qwenResult } from "./result-envelope/qwen.js";
import { assertCleanInstructionFiles, cleanCwdHost } from "./clean-cwd.js";
import { qwenLoginPath, writeQwenAccessOnlyLogin } from "./qwen-access-login.js";

export type QwenExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" |
  "calls" | "toolDefinitions" | "record" | "failureError" | "resolveCallId" | "validateResult" |
  "onFailure" | "start" | "finish" | "fail" | "terminateProtocol" | "close" | "closeSync">;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_LOG_FILES = 1024;
const IDENTITY_WINDOW_MS = 10_000;
const IDENTITY_POLL_MS = 25;

/** Qwen 0.24.0, read 2026-11-09. Workspace settings come from the cwd
 * alone: loadSettings(workspaceDir = process.cwd()) reads
 * `new Storage(workspaceDir).getWorkspaceSettingsPath()`, which is
 * `<cwd>/.qwen/settings.json` (chunk-VPFKSRAB.js:1733,1754-1756;
 * chunk-ZYDMQCQP.js:825-827), even in safe mode (:1878-1884). Its home
 * exemption never applies here, because the child's HOME is private.
 * chunk-UVMU7DDP.js:184-251 walks .env and .qwen/.env to the filesystem
 * root, without a repository boundary. Refuse exactly those inputs: an
 * ancestor `.qwen/settings.json` (the operator's own ~/.qwen) is not read. */
export function assertQwenExperimentCwd(cwd: string): void {
  const start = realpathSync(cwd);
  const flag = "--experiment-mcp";
  // A walk that treats every directory as a boundary checks the cwd only.
  assertCleanInstructionFiles("qwen", start, [".qwen/settings.json"], { ...cleanCwdHost, existsSync: () => true }, flag);
  assertCleanInstructionFiles("qwen", start, [".qwen/.env", ".env"], { ...cleanCwdHost, existsSync: () => false }, flag);
}

export class QwenExperimentRun implements StdoutSink {
  readonly relay: QwenExperimentRelay;
  readonly home: string;
  readonly configPath: string;
  readonly logs: string;
  readonly envAssignments: string[];
  readonly authType: "openai" | "qwen-oauth";
  private readonly finalizeHome: () => void;
  private capture = "";
  private bytes = 0;
  private finished = false;
  private interrupted = false;
  private preparing?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private evidenceCopied = false;
  private evidence?: JsonObject[];
  private removeFailureListener?: () => void;
  private readonly claimed = new Set<string>();

  constructor(spec: ExperimentSpec, cwd: string, brandHome: string, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, model: JsonObject = {}, relay?: QwenExperimentRelay,
    authEnvironment: NodeJS.ProcessEnv = environment) {
    assertQwenExperimentCwd(cwd);
    const parent = prepareRunDirParent(brandHome, ".codemux-experiment");
    const trusted = recordTrustedParent(parent);
    this.home = mkdtempSync(join(parent, `run-${process.pid}-`));
    let finalized = false;
    this.finalizeHome = () => {
      if (finalized) return;
      removeUnderTrustedParentOrThrow(this.home, trusted, "the private Qwen experiment home");
      finalized = true;
      process.off("exit", hook);
      untrackPrivateDir(hook);
    };
    const hook = reportingHook(() => this.closeSync());
    this.configPath = join(this.home, "mcp.json");
    this.logs = join(this.home, "provider-logs");
    const settings = join(this.home, "settings.json");
    const defaults = join(this.home, "defaults.json");
    // chunk-WX4W3FCV.js:122 selects OpenAI from this complete trio.
    this.authType = authEnvironment.OPENAI_API_KEY && authEnvironment.OPENAI_BASE_URL && authEnvironment.OPENAI_MODEL
      ? "openai" : "qwen-oauth";
    try {
      chmodSync(this.home, 0o700);
      mkdirSync(this.logs, { mode: 0o700 });
      writeFileSync(settings, JSON.stringify({ model, tools: { toolSearch: { enabled: false } } }), { mode: 0o600, flag: "wx" });
      writeFileSync(defaults, "{}", { mode: 0o600, flag: "wx" });
      if (this.authType === "qwen-oauth") {
        // chunk-6DB6UHY3.js:155 names oauth_creds.json. Only its access
        // fields ride in (qwen-access-login.ts): Qwen renames that file on
        // refresh, so a rotated refresh token would strand in this home.
        writeQwenAccessOnlyLogin(qwenLoginPath(brandHome), this.home);
      }
      this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
      this.relay.resolveCallId = (call) => this.resolveNativeCall(call);
      this.relay.validateResult = assertQwenExperimentResult;
    } catch (error) { this.finalizeHome(); throw error; }
    // chunk-IDS7MSUP.js:42-54 honors both system-layer overrides;
    // chunk-SNPYTKXI.js:54304 resolves QWEN_HOME. HOME redirects other
    // native state. The prefix is inside scode, leaving its HOME intact.
    this.envAssignments = ["-u", "QWEN_SYSTEM_MD", "-u", "QWEN_SYSTEM_IDENTITY_MD", "-u", "QWEN_WRITE_SYSTEM_MD",
      `HOME=${this.home}`, `QWEN_HOME=${this.home}`, `QWEN_RUNTIME_DIR=${this.home}`,
      // Native 0.24.0 chunk-5XK2YELE.js:1855 and chunk-DTSG4EHA.js:436
      // let these paths override QWEN_HOME (read 2026-11-09).
      `QWEN_CODE_TRUSTED_FOLDERS_PATH=${join(this.home, "trusted-folders.json")}`,
      `QWEN_CODE_MCP_APPROVALS_PATH=${join(this.home, "mcp-approvals.json")}`,
      `QWEN_CODE_SYSTEM_SETTINGS_PATH=${settings}`, `QWEN_CODE_SYSTEM_DEFAULTS_PATH=${defaults}`];
    process.once("exit", hook);
    trackPrivateDir(hook);
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }
  get hasOutput(): boolean { return this.bytes > 0; }
  get scanSurface(): string { return this.capture + "\n" + JSON.stringify(this.evidence ?? []); }

  prepare(): Promise<void> {
    return this.preparing ??= (async () => {
      try {
        await this.relay.start();
        writeFileSync(this.configPath, JSON.stringify({ mcpServers: { [this.relay.spec.name]: {
          httpUrl: this.relay.url, headers: { Authorization: `Bearer ${this.relay.token}` },
          timeout: experimentToolTimeoutSeconds(this.relay.spec) * 1000, trust: true, alwaysLoadTools: true,
        } } }), { mode: 0o600, flag: "wx" });
      } catch (error) { this.relay.fail(error); throw error; }
    })();
  }

  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    this.removeFailureListener = this.relay.onFailure(abort);
    if (this.relay.failureError) { abort(); return; }
    write(this.prompt);
    end();
  }
  push(chunk: string): void {
    if (this.finished) return;
    this.capture += capturePrefix(chunk, Math.max(0, MAX_CAPTURE_BYTES - this.bytes));
    this.bytes += Buffer.byteLength(chunk);
  }
  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.interrupted ||= options?.timedOut === true || options?.aborted === true;
    this.finished = true;
    return this.capture;
  }
  keptBytes(): number { return this.bytes; }
  closeProtocol(): void { this.removeFailureListener?.(); this.removeFailureListener = undefined; }
  terminateProtocol(): void { this.interrupted = true; this.relay.terminateProtocol(); }

  private async resolveNativeCall(call: { name: string; input: unknown }): Promise<string> {
    const deadline = Date.now() + IDENTITY_WINDOW_MS;
    for (;;) {
      if (this.relay.failureError) throw this.relay.failureError;
      const matches = qwenExperimentCalls(this.capture).filter((entry) =>
        entry.name === qwenExperimentToolName(this.relay.spec.name, call.name) && isDeepStrictEqual(entry.input, call.input));
      const available = matches.filter((entry) => !this.claimed.has(entry.id));
      if (available.length > 1) throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen parallel calls with identical arguments are ambiguous");
      const id = available[0]?.id;
      if (id) { this.claimed.add(id); return id; }
      // A later identical call can reach HTTP before its stdout frame.
      // Historical matches cannot establish this new request's identity.
      if (this.finished || this.interrupted || Date.now() >= deadline) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Qwen MCP request lacks a native call identity");
      }
      await new Promise((resolve) => setTimeout(resolve, IDENTITY_POLL_MS));
    }
  }

  private readLogs(): JsonObject[] {
    const names = readdirSync(this.logs).sort();
    if (names.length > MAX_LOG_FILES) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen provider log count exceeds its bound");
    let remaining = MAX_EVIDENCE_BYTES;
    return names.map((name) => {
      if (!/^openai-[\w.-]+\.json$/.test(name)) throw new ExperimentFailure(Code.HarnessLogMissing, "Unexpected Qwen provider log file");
      const bytes = readUtf8FileBounded(join(this.logs, name), { maxBytes: remaining, label: "Qwen provider log", noFollow: true });
      remaining -= Buffer.byteLength(bytes);
      const value: unknown = JSON.parse(bytes);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperimentFailure(Code.HarnessLogMissing, "Invalid Qwen provider log");
      const { request, response, error, context, timestamp } = value as JsonObject;
      // Native system metadata includes host identity; it is not evidence.
      return { request, response, error, context, timestamp };
    });
  }

  complete(options?: { timedOut: boolean }): Promise<void> {
    this.interrupted ||= options?.timedOut === true;
    return this.completing ??= (async () => {
      try {
        if (this.interrupted || this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Qwen experiment capture was interrupted or exceeded its bound");
        this.evidence = this.readLogs();
        verifyQwenExperimentEvidence(this.relay, this.evidence, this.capture);
        this.relay.finish();
      } catch (error) { this.relay.fail(error); }
      if (this.relay.failureError) throw this.relay.failureError;
    })();
  }

  private preserveEvidence(): void {
    if (this.evidenceCopied) return;
    this.evidenceCopied = true;
    try {
      this.relay.record("harness_stdout", { bytes_base64: Buffer.from(this.capture).toString("base64") });
      if (this.evidence) {
        for (const log of this.evidence) this.relay.record("qwen_provider_log", log);
      } else {
        // A malformed log must not erase the other files. Preserve bounded
        // raw bytes independently, including the file that failed parsing.
        let remaining = MAX_EVIDENCE_BYTES;
        for (const name of readdirSync(this.logs).sort().slice(0, MAX_LOG_FILES)) {
          if (!/^openai-[\w.-]+\.json$/.test(name)) continue;
          try {
            const bytes = readFileBytesBounded(join(this.logs, name), { maxBytes: remaining, label: "Qwen provider log", noFollow: true });
            remaining -= bytes.length;
            this.relay.record("qwen_provider_log_raw", { file: name, bytes_base64: bytes.toString("base64") });
          } catch (error) { this.relay.fail(error); }
        }
      }
    } catch (error) { this.relay.fail(error); }
  }
  close(): Promise<void> {
    this.closeProtocol();
    this.preserveEvidence();
    return this.closing ??= (async () => {
      // Cleanup failures belong in run_end before the relay closes it.
      try { this.finalizeHome(); } catch (error) { this.relay.fail(error); }
      await this.relay.close();
    })();
  }
  closeSync(): void {
    this.closeProtocol();
    this.preserveEvidence();
    try { this.relay.closeSync(); } finally { this.finalizeHome(); }
  }
}

/** The native stream has the same messages as Qwen's batch JSON output. */
export function qwenExperimentResult(result: RunResult, request: RunRequest, recording: string): RunResult {
  const events: unknown[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* Partial failure capture. */ }
  }
  const batch = { ...result, stdout: JSON.stringify(events) };
  const folded = qwenResult(batch, { ...request, resultJson: true });
  if (request.resultJson) {
    try {
      const envelope = JSON.parse(folded.stdout);
      envelope.codemux.recording = recording;
      return { ...folded, stdout: JSON.stringify(envelope) + "\n" };
    } catch { return folded; }
  }
  return { ...folded, stdout: parseQwenResultEnvelope(batch.stdout)?.answer ?? "" };
}
