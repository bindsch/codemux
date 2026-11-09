import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import { readUtf8FileBounded } from "./file-io.js";
import { installPiMcpExtension } from "./pi-mcp-extension.js";
import { createPiMcpHttpTransport } from "./pi-mcp-http.js";
import { assertPiExperimentResult, piObject } from "./pi-experiment-content.js";
import { verifyPiExperimentEvidence } from "./pi-experiment-evidence.js";

export const PI_EXPERIMENT_TOKEN_ENV = "CODEMUX_PI_EXPERIMENT_TOKEN";
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
export type PiExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" | "calls" | "toolDefinitions" |
  "record" | "failureError" | "resolveCallId" | "validateResult" | "onFailure" | "start" | "finish" | "fail" | "terminateProtocol" | "close" | "closeSync">;

/** Authentication stays in the child environment, outside argv and files.
 * The only installed extension records final payloads synchronously before
 * Pi dispatches them. The host retains those records before home cleanup. */
export function piExperimentExtensionSource(url: string, name: string, evidencePath: string,
  toolTimeoutMs = experimentToolTimeoutSeconds({}) * 1000): string {
  return `import { appendFileSync } from "node:fs";\n` +
    `const createTransport = ${createPiMcpHttpTransport.toString()};\n` +
    `const install = ${installPiMcpExtension.toString()};\n` +
    `export default async function(pi) {\n` +
    ` const transport = createTransport(${JSON.stringify(url)}, process.env.${PI_EXPERIMENT_TOKEN_ENV});\n` +
    ` let bytes = 0;\n` +
    ` await install(pi, transport, {name:${JSON.stringify(name)}, exclusive:true, toolTimeoutMs:${toolTimeoutMs}, record(kind,fields) {\n` +
    `  const line = JSON.stringify({kind,fields,t:Date.now()/1000}) + "\\n";\n` +
    `  bytes += Buffer.byteLength(line); if(bytes > ${MAX_EVIDENCE_BYTES}) throw new Error("Pi evidence exceeds 32 MiB");\n` +
    `  appendFileSync(${JSON.stringify(evidencePath)},line,{mode:0o600});\n` +
    ` }});\n}\n`;
}

/** Owns only this launch's relay and evidence. The shared launcher must
 * await prepare before spawning, complete after capture, and close before
 * the adapter removes the private agent directory. */
export class PiExperimentRun implements StdoutSink {
  readonly relay: PiExperimentRelay;
  readonly extensionPath: string;
  readonly evidencePath: string;
  private capture = "";
  private bytes = 0;
  private preparing?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private finished = false;
  private interrupted = false;
  private evidenceCopied = false;
  private removeFailureListener?: () => void;

  constructor(spec: ExperimentSpec, cwd: string, privateHome: string, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, relay?: PiExperimentRelay) {
    this.extensionPath = join(privateHome, "experiment.mjs");
    this.evidencePath = join(privateHome, "experiment-evidence.jsonl");
    this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.validateResult = assertPiExperimentResult;
    this.relay.resolveCallId = async (_call, request) => {
      const id = request.params?._meta?.["codemux/callId"];
      if (typeof id !== "string" || !id.trim()) throw new ExperimentFailure(Code.CallIdUnresolved, "Pi request lacks native toolCallId");
      return id;
    };
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }
  get hasOutput(): boolean { return this.bytes > 0; }

  prepare(): Promise<void> {
    return this.preparing ??= (async () => {
      try {
        await this.relay.start();
        writeFileSync(this.evidencePath, "", { mode: 0o600, flag: "wx" });
        writeFileSync(this.extensionPath, piExperimentExtensionSource(this.relay.url, this.relay.spec.name, this.evidencePath,
          experimentToolTimeoutSeconds(this.relay.spec) * 1000), { mode: 0o600, flag: "wx" });
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

  complete(options?: { timedOut: boolean }): Promise<void> {
    this.interrupted ||= options?.timedOut === true;
    return this.completing ??= (async () => {
      try {
        const evidence = readUtf8FileBounded(this.evidencePath, { maxBytes: MAX_EVIDENCE_BYTES, label: "Pi experiment evidence", noFollow: true });
        this.preserveEvidence(evidence);
        if (this.interrupted || this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Pi experiment capture was interrupted or exceeded its bound");
        if (evidence && !evidence.endsWith("\n")) throw new ExperimentFailure(Code.HarnessLogMissing, "Pi experiment evidence is truncated");
        const records = evidence.split("\n").filter(Boolean).map((line) => piObject(JSON.parse(line)));
        verifyPiExperimentEvidence(this.relay, records, this.capture);
        this.relay.finish();
      } catch (error) { this.relay.fail(error); }
      if (this.relay.failureError) throw this.relay.failureError;
    })();
  }

  close(): Promise<void> {
    this.closeProtocol();
    this.preserveEvidence();
    return this.closing ??= this.relay.close();
  }
  closeSync(): void { this.closeProtocol(); this.preserveEvidence(); this.relay.closeSync(); }

  /** Capture failures can skip complete(); cleanup must still retain the
   * bounded native bytes before deleting the private agent directory. */
  private preserveEvidence(known?: string): void {
    if (this.evidenceCopied || !this.preparing) return;
    this.evidenceCopied = true;
    try {
      const evidence = known ?? readUtf8FileBounded(this.evidencePath, { maxBytes: MAX_EVIDENCE_BYTES, label: "Pi experiment evidence", noFollow: true });
      this.relay.record("pi_evidence_copy", { bytes_base64: Buffer.from(evidence).toString("base64") });
      this.relay.record("harness_stdout", { bytes_base64: Buffer.from(this.capture).toString("base64") });
    } catch (error) { this.relay.fail(error); }
  }
}
