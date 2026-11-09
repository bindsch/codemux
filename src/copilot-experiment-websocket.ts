import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { copilotExperimentObject, type CopilotDeliveryObserver, type CopilotExperimentDelivery } from "./copilot-experiment-evidence.js";
import type { JsonObject } from "./experiment-server.js";

const copilotWsByteLimit = 16 * 1024 * 1024;
const copilotWsMessageLimit = 64;
const copilotWsOpenTimeout = 30_000;
const copilotWsCloseTimeout = 1_000;

/** Installed 1.0.85 copilot-sdk/index.js decodeFrame and
 * CopilotWebSocketResponseBridge, read 2026-11-09: each request chunk is
 * one UTF-8 message. Responses begin with status 101, then serialize
 * message chunks and one terminal chunk. Queues have byte/message bounds. */
export class CopilotExperimentWebSocket {
  private readonly socket: Bun.WebSocket;
  private readonly opened: Promise<void>;
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private serial = Promise.resolve();
  private queuedBytes = 0;
  private queuedMessages = 0;
  private sentBytes = 0;
  private sentMessages = 0;
  private ended = false;
  private disposed = false;
  private failure?: Error;
  private delivery?: CopilotExperimentDelivery;
  private responseId?: string;

  constructor(private readonly head: JsonObject, private readonly options: {
    evidence: CopilotDeliveryObserver;
    request(method: string, params: JsonObject): Promise<unknown>;
    fail(error: Error): void;
    onClosed?(): void;
  }) {
    const url = new URL(head.url);
    if (!["ws:", "wss:"].includes(url.protocol)) throw new ExperimentFailure(Code.Protocol, "Copilot WebSocket URL is invalid");
    const headers = new Headers();
    for (const [name, values] of Object.entries(copilotExperimentObject(head.headers))) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new ExperimentFailure(Code.Protocol, "Copilot WebSocket headers require string arrays");
      for (const value of values) headers.append(name, value);
    }
    this.socket = new WebSocket(url.href, { headers: Object.fromEntries(headers.entries()) }) as Bun.WebSocket;
    this.socket.binaryType = "arraybuffer";
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Copilot WebSocket connection timed out")), copilotWsOpenTimeout);
      timer.unref?.();
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Copilot WebSocket connection failed")); }, { once: true });
      this.socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Copilot WebSocket closed before opening")); }, { once: true });
    });
    this.enqueue(0, async () => { await this.opened; await this.respond("llmInference.httpResponseStart", { status: 101, headers: {} }); });
    this.socket.addEventListener("message", (event) => {
      const bytes = typeof event.data === "string" ? Buffer.from(event.data) : event.data instanceof ArrayBuffer ? Buffer.from(event.data) : null;
      if (bytes === null) { this.fail(new Error("Copilot WebSocket returned unsupported message data")); return; }
      this.enqueue(bytes.length, async () => {
        await this.respond("llmInference.httpResponseChunk", { data: bytes.toString("base64"), binary: true, end: false });
        const event = copilotExperimentObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (event.type === "response.created") {
          if (typeof event.response?.id !== "string" || this.responseId !== undefined) throw new Error("Copilot WebSocket response identity is invalid");
          this.responseId = event.response.id;
        }
        if (event.type === "response.completed") {
          if (!this.delivery || typeof event.response?.id !== "string" || event.response.id !== this.responseId || event.response.status !== "completed" || event.response.error) throw new Error("Copilot WebSocket completion has no matching successful response");
          this.options.evidence.commit(this.delivery, Buffer.from(JSON.stringify(event.response))); this.delivery = undefined; this.responseId = undefined;
        }
        if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
          if (this.delivery) this.options.evidence.discard(this.delivery);
          this.delivery = undefined; this.responseId = undefined;
        }
      });
    });
    this.socket.addEventListener("error", () => this.fail(new Error("Copilot WebSocket transport failed")));
    this.socket.addEventListener("close", (event) => {
      if (!this.disposed && event.code !== 1000 && event.code !== 1005) this.fail(new Error(`Copilot WebSocket closed with code ${event.code}`));
      if (!this.disposed) this.enqueue(0, async () => {
        if (this.delivery) throw new Error("Copilot WebSocket closed before model completion");
        await this.respond("llmInference.httpResponseChunk", { data: "", end: true });
      });
      this.resolveClosed();
      this.options.onClosed?.();
    });
  }

  private async respond(method: string, fields: JsonObject): Promise<void> {
    if (this.disposed) return;
    const result = copilotExperimentObject(await this.options.request(method, { requestId: this.head.requestId, ...fields }));
    if (result.accepted !== true) throw new ExperimentFailure(Code.Protocol, "Copilot runtime rejected a WebSocket response frame");
  }

  private enqueue(bytes: number, operation: () => Promise<void>): void {
    if (this.disposed) return;
    this.queuedBytes += bytes; this.queuedMessages++;
    if (this.queuedBytes > copilotWsByteLimit || this.queuedMessages > copilotWsMessageLimit) {
      this.fail(new Error("Copilot WebSocket response backpressure limit exceeded")); return;
    }
    this.serial = this.serial.then(operation).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { this.queuedBytes -= bytes; this.queuedMessages--; });
  }

  async chunk(params: JsonObject): Promise<JsonObject> {
    if (this.failure) throw this.failure;
    if (params.cancel === true) { this.dispose(); return {}; }
    if (this.ended || this.disposed || typeof params.data !== "string") throw new ExperimentFailure(Code.Protocol, "Copilot WebSocket chunk arrived after its end or has no data");
    const bytes = params.binary === true ? Buffer.from(params.data, "base64") : Buffer.from(params.data);
    if (params.binary === true && bytes.toString("base64") !== params.data) throw new ExperimentFailure(Code.Protocol, "Copilot WebSocket chunk has invalid base64");
    this.sentBytes += bytes.length; this.sentMessages++;
    if (this.sentBytes > copilotWsByteLimit || this.sentMessages > copilotWsMessageLimit || this.socket.bufferedAmount + bytes.length > copilotWsByteLimit) {
      this.fail(new Error("Copilot WebSocket request backpressure limit exceeded")); throw this.failure;
    }
    try {
      await this.opened;
      await this.serial;
      if (this.failure || this.disposed) throw this.failure ?? new Error("Copilot WebSocket was disposed");
      if (bytes.length) {
        if (this.delivery) throw new Error("Copilot WebSocket has overlapping model requests");
        this.delivery = this.options.evidence.request(bytes, this.head);
        this.socket.send(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
      if (params.end === true) { this.ended = true; this.socket.close(1000); }
      return {};
    } finally { this.sentBytes -= bytes.length; this.sentMessages--; }
  }

  private fail(error: Error): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    this.options.fail(error);
    this.dispose();
  }

  async complete(): Promise<void> {
    if (!this.disposed && this.socket.readyState !== WebSocket.CLOSED) { this.ended = true; this.socket.close(1000); }
    const timer = setTimeout(() => this.fail(new Error("Copilot WebSocket close timed out")), copilotWsCloseTimeout);
    timer.unref?.();
    try { await this.closed; } finally { clearTimeout(timer); }
    await this.serial;
    if (this.failure) throw this.failure;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.delivery) this.options.evidence.discard(this.delivery);
    this.delivery = undefined;
    this.socket.terminate();
    this.resolveClosed();
    this.options.onClosed?.();
  }
}
