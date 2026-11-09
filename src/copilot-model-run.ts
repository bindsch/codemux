import { randomUUID } from "node:crypto";
import { CopilotModelEvidence } from "./copilot-model-evidence.js";
import { CopilotExperimentHttp } from "./copilot-experiment-http.js";
import { CopilotRpcControl, type CopilotRpcSessionConfig } from "./session/copilot-rpc-control.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import type { AutonomyLevel, ResultUsageBlock } from "./types.js";
import type { JsonObject } from "./experiment-server.js";

/** Ordinary runs preserve native tools and customization. Shared launch
 * activation installs this sink before buildRunCommand, then completes
 * it before result processing. Model identity comes from response bytes,
 * not the requested model or assistant-message metadata. */
export class CopilotModelRun implements StdoutSink {
  readonly sessionId = randomUUID();
  readonly evidence = new CopilotModelEvidence();
  usage?: ResultUsageBlock;
  private rpc?: CopilotRpcControl;
  private transport?: CopilotExperimentHttp;
  private output = "";
  private bytes = 0;
  private failure?: Error;
  private ending?: Promise<void>;
  private ended = false;
  private idle = false;

  constructor(private readonly prompt: string, private readonly config: CopilotRpcSessionConfig,
    private readonly autonomy: AutonomyLevel, private readonly fetchRequest?: (request: Request) => Promise<Response>) {}

  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    if (this.rpc) throw new Error("Copilot model run cannot start twice");
    const fail = (error: Error): void => { this.failure ??= error; abort(); };
    const rpc = this.rpc = new CopilotRpcControl({ sessionId: this.sessionId, denyPermissions: false,
      write: (bytes) => write(Buffer.from(bytes).toString("utf8")), onFailure: fail,
      onEvent: (event) => this.event(event, end, fail), clientMethods: {
        "llmInference.httpRequestStart": (params) => this.transport!.start(params),
        "llmInference.httpRequestChunk": (params) => this.transport!.chunk(params),
      } });
    this.transport = new CopilotExperimentHttp({ sessionId: this.sessionId, evidence: this.evidence,
      allowSubagents: true, request: (method, params) => rpc.request(method, params), fail, fetch: this.fetchRequest });
    void (async () => {
      await rpc.open(false, this.config);
      await rpc.configureAutonomy(this.autonomy);
      const registered = await rpc.request("llmInference.setProvider", {}) as JsonObject;
      if (registered?.success !== true) throw new Error("Copilot runtime did not enable response observation");
      await rpc.send(this.prompt);
    })().catch(fail);
  }

  private event(event: JsonObject, end: () => void, fail: (error: Error) => void): void {
    const line = JSON.stringify(event) + "\n"; this.bytes += Buffer.byteLength(line);
    if (this.bytes > MAX_CAPTURE_BYTES) throw new Error("Copilot model run exceeded its capture limit");
    this.output += line;
    if (event.agentId !== undefined) return;
    if (event.type === "session.error" || event.type === "abort" || (event.type === "session.idle" && event.data?.aborted)) throw new Error("Copilot model run failed or was aborted");
    if (event.type !== "session.idle") return;
    if (this.idle) throw new Error("Copilot model run repeated its terminal event");
    this.idle = true;
    this.ending = (async () => {
      await this.transport!.complete();
      this.usage = await this.rpc!.usage();
      await this.rpc!.detach();
      this.output += JSON.stringify({ type: "result", sessionId: this.sessionId, exitCode: 0 }) + "\n";
      this.ended = true; end();
    })().catch(fail);
  }

  push(chunk: string): void { this.rpc?.receive(Buffer.from(chunk)); }
  keptBytes(): number { return this.bytes; }
  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    if (options?.timedOut || options?.aborted) this.failure ??= new Error("Copilot model run was interrupted");
    this.rpc?.end(); return this.output;
  }
  terminateProtocol(): void { this.failure ??= new Error("Copilot model run was interrupted"); this.closeProtocol(); }
  closeProtocol(): void { this.rpc?.close(); this.transport?.close(); }
  async complete(): Promise<void> {
    await this.ending;
    if (this.failure) throw this.failure;
    if (!this.ended) throw new Error("Copilot model run has no native terminal turn");
    if (this.evidence.servedModel === null) throw new Error("Copilot provider response has no verified main-agent model identity");
  }
}
