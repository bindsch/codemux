import { randomUUID } from "node:crypto";
import { ExperimentHttpRelay } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code, experimentFailure } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import type { JsonObject } from "./experiment-server.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import type { ResultUsageBlock } from "./types.js";
import { CopilotRpcControl, type CopilotRpcSessionConfig } from "./session/copilot-rpc-control.js";
import { CopilotExperimentEvidence, assertCopilotExperimentResult, copilotExperimentObject } from "./copilot-experiment-evidence.js";
import { CopilotExperimentHttp } from "./copilot-experiment-http.js";

export type CopilotExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" | "calls" | "toolDefinitions" |
  "record" | "failureError" | "resolveCallId" | "validateResult" | "onFailure" | "start" | "finish" | "fail" | "terminateProtocol" | "close" | "closeSync">;

/** Owns a native headless RPC run and the shared MCP relay. The launcher
 * must prepare before spawn, complete after capture, and close before
 * removing the private home. Installed 1.0.85 SDK createSession hooks:true,
 * session.tools.initializeAndValidate/getCurrentMetadata and
 * llmInference.setProvider define these calls (read 2026-11-09). */
export class CopilotExperimentRun implements StdoutSink {
  readonly sessionId = randomUUID();
  readonly relay: CopilotExperimentRelay;
  readonly evidence: CopilotExperimentEvidence;
  usage?: ResultUsageBlock;
  private rpc?: CopilotRpcControl;
  private http?: CopilotExperimentHttp;
  private capture = "";
  private bytes = 0;
  private idle = false;
  private interrupted = false;
  private prepared = false;
  private ended = false;
  private ending?: Promise<void>;
  private removeFailure?: () => void;

  constructor(spec: ExperimentSpec, cwd: string, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, private readonly config: CopilotRpcSessionConfig,
    relay?: CopilotExperimentRelay, private readonly fetchRequest?: (request: Request) => Promise<Response>) {
    this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
    this.evidence = new CopilotExperimentEvidence(this.relay, this.sessionId);
    this.relay.validateResult = assertCopilotExperimentResult;
    this.relay.resolveCallId = async (_call, request) => {
      const id = request.params?._meta?.["codemux/callId"];
      if (typeof id !== "string" || !id.trim()) throw new ExperimentFailure(Code.CallIdUnresolved, "Copilot MCP request lacks a native hook call ID");
      return id;
    };
  }

  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }

  async prepare(): Promise<void> {
    if (this.prepared) throw new Error("Copilot experiment was already prepared");
    await this.relay.start();
    this.prepared = true;
  }

  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    if (!this.prepared || this.rpc) throw new Error("Copilot experiment requires one prepared start");
    const fail = (error: Error): void => { this.relay.fail(experimentFailure(error)); abort(); };
    this.removeFailure = this.relay.onFailure(abort);
    if (this.relay.failureError) { abort(); return; }
    const rpc = this.rpc = new CopilotRpcControl({ sessionId: this.sessionId, denyPermissions: false,
      write: (bytes) => write(Buffer.from(bytes).toString("utf8")), onFailure: fail,
      onEvent: (event) => this.event(event, end, fail), clientMethods: {
        "hooks.invoke": (params) => this.evidence.hook(params),
        "llmInference.httpRequestStart": (params) => this.http!.start(params),
        "llmInference.httpRequestChunk": (params) => this.http!.chunk(params),
      } });
    this.http = new CopilotExperimentHttp({ sessionId: this.sessionId, evidence: this.evidence,
      request: (method, params) => rpc.request(method, params), fail, fetch: this.fetchRequest });
    void this.begin(rpc).catch(fail);
  }

  private async begin(rpc: CopilotRpcControl): Promise<void> {
    const control = this.relay.spec.control === true;
    await rpc.open(false, { ...this.config, hooks: true, availableTools: ["mcp:*"], excludedTools: [],
      toolFilterPrecedence: "available", enableConfigDiscovery: control, enableFileHooks: false, enableSkills: false,
      enableOnDemandInstructionDiscovery: control, pluginDirectories: [], skillDirectories: [], instructionDirectories: control ? [this.config.configDir] : [],
      mcpServers: { [this.relay.spec.name]: { type: "http", url: this.relay.url, tools: ["*"],
        timeout: experimentToolTimeoutSeconds(this.relay.spec) * 1000,
        headers: { Authorization: `Bearer ${this.relay.token}` } } } });
    await rpc.configureAutonomy("high");
    await rpc.request("session.tools.initializeAndValidate", { sessionId: this.sessionId });
    const metadata = copilotExperimentObject(await rpc.request("session.tools.getCurrentMetadata", { sessionId: this.sessionId }));
    this.evidence.catalog(metadata.tools);
    const registered = copilotExperimentObject(await rpc.request("llmInference.setProvider", {}));
    if (registered.success !== true) throw new ExperimentFailure(Code.Protocol, "Copilot runtime did not register inference interception");
    await rpc.send(this.prompt);
  }

  private event(event: JsonObject, end: () => void, fail: (error: Error) => void): void {
    this.relay.record("copilot_native_event", { event });
    if (event.agentId !== undefined) throw new ExperimentFailure(Code.UnknownTool, "Copilot experiment produced a subagent event");
    const line = JSON.stringify(event) + "\n";
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "Copilot experiment event capture exceeded its bound");
    this.capture += line;
    if (event.type === "session.error") throw new ExperimentFailure(Code.Protocol, "Copilot experiment reported a session error");
    if (event.type === "abort" || (event.type === "session.idle" && event.data?.aborted === true)) {
      this.interrupted = true;
      throw new ExperimentFailure(Code.HarnessLogMissing, "Copilot experiment native turn was aborted");
    }
    if (event.type === "session.idle") {
      if (this.idle) throw new ExperimentFailure(Code.Protocol, "Copilot experiment repeated its terminal event");
      this.idle = true;
      this.ending = (async () => {
        await this.http!.complete();
        this.usage = await this.rpc!.usage();
        await this.rpc!.detach();
        this.capture += JSON.stringify({ type: "result", exitCode: 0, sessionId: this.sessionId }) + "\n";
        this.ended = true;
        end();
      })().catch(fail);
    }
  }

  push(chunk: string): void { this.rpc?.receive(Buffer.from(chunk)); }
  keptBytes(): number { return this.bytes; }
  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.interrupted ||= options?.timedOut === true || options?.aborted === true;
    this.rpc?.end();
    return this.capture;
  }
  terminateProtocol(): void { this.interrupted = true; this.http?.close(); this.relay.terminateProtocol(); }
  closeProtocol(): void { this.removeFailure?.(); this.removeFailure = undefined; this.rpc?.close(); this.http?.close(); }

  async complete(options?: { timedOut: boolean }): Promise<void> {
    await this.ending;
    try {
      if (this.interrupted || options?.timedOut || !this.ended) throw new ExperimentFailure(Code.HarnessLogMissing, "Copilot experiment has no complete native terminal turn");
      this.relay.finish();
      this.evidence.complete();
    } catch (error) { this.relay.fail(experimentFailure(error)); }
    if (this.relay.failureError) throw this.relay.failureError;
  }

  async close(): Promise<void> { this.closeProtocol(); await this.relay.close(); }
  closeSync(): void { this.closeProtocol(); this.relay.closeSync(); }
}
