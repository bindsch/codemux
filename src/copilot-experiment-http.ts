import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { copilotExperimentObject, type CopilotDeliveryObserver } from "./copilot-experiment-evidence.js";
import type { JsonObject } from "./experiment-server.js";
import { CopilotExperimentWebSocket } from "./copilot-experiment-websocket.js";
import { copilotModelResponseSucceeded } from "./copilot-experiment-response.js";

const copilotRequestLimit = 16 * 1024 * 1024;
const copilotRequestCountLimit = 16;
const copilotHopHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "te", "trailer"]);
type CopilotExchange = { head: JsonObject; parts: Uint8Array[]; bytes: number; controller: AbortController; running: boolean };

/** Installed 1.0.85 copilot-sdk/index.js createCopilotRequestAdapter,
 * buildFetchRequest and streamResponse, read 2026-11-09: request chunks
 * carry UTF-8 or base64 bytes; response chunks use the same representation.
 * This host transport observes the complete body before forwarding it.
 * It never writes request headers or authentication to the recording. */
export class CopilotExperimentHttp {
  private readonly exchanges = new Map<string, CopilotExchange>();
  private readonly running = new Set<Promise<void>>();
  private readonly sockets = new Map<string, CopilotExperimentWebSocket>();
  private failure?: Error;

  constructor(private readonly options: {
    sessionId: string;
    evidence: CopilotDeliveryObserver;
    allowSubagents?: boolean;
    request(method: string, params: JsonObject): Promise<unknown>;
    fail(error: Error): void;
    fetch?: (request: Request) => Promise<Response>;
  }) {}

  start(head: JsonObject): JsonObject {
    if (this.failure) throw this.failure;
    if (typeof head.requestId !== "string" || !head.requestId || this.exchanges.has(head.requestId) || this.sockets.has(head.requestId) ||
        this.exchanges.size + this.sockets.size >= copilotRequestCountLimit || head.sessionId !== this.options.sessionId || (!this.options.allowSubagents && head.parentAgentId !== undefined)) {
      throw new ExperimentFailure(Code.Protocol, "Copilot inference request has invalid identity or concurrency");
    }
    if (head.transport === "websocket") {
      const socket = new CopilotExperimentWebSocket(head, { ...this.options, onClosed: () => {
        if (this.sockets.get(head.requestId) !== socket) return;
        this.sockets.delete(head.requestId);
        const operation = socket.complete().catch((error: unknown) => {
          this.failure = error instanceof Error ? error : new Error(String(error)); this.options.fail(this.failure);
        }).finally(() => { this.running.delete(operation); });
        this.running.add(operation);
      } });
      this.sockets.set(head.requestId, socket); return {};
    }
    if (head.transport !== undefined && head.transport !== "http") throw new ExperimentFailure(Code.ModelUnavailable, "Copilot experiment transport is unknown");
    if (head.method !== "POST" || typeof head.url !== "string" || !["http:", "https:"].includes(new URL(head.url).protocol)) {
      throw new ExperimentFailure(Code.Protocol, "Copilot experiment requires an HTTP POST model request");
    }
    copilotExperimentObject(head.headers);
    this.exchanges.set(head.requestId, { head, parts: [], bytes: 0, controller: new AbortController(), running: false });
    return {};
  }

  chunk(params: JsonObject): JsonObject | Promise<JsonObject> {
    const socket = this.sockets.get(params.requestId);
    if (socket) return socket.chunk(params);
    const exchange = this.exchanges.get(params.requestId);
    if (!exchange) throw new ExperimentFailure(Code.Protocol, "Copilot inference chunk has no request");
    if (params.cancel === true) {
      exchange.controller.abort();
      this.exchanges.delete(params.requestId);
      return {};
    }
    if (exchange.running || typeof params.data !== "string") throw new ExperimentFailure(Code.Protocol, "Copilot inference chunk arrived after its end or has no data");
    const bytes = params.binary === true ? Buffer.from(params.data, "base64") : Buffer.from(params.data);
    if (params.binary === true && bytes.toString("base64") !== params.data) throw new ExperimentFailure(Code.Protocol, "Copilot inference chunk has invalid base64");
    exchange.bytes += bytes.length;
    if (exchange.bytes > copilotRequestLimit) throw new ExperimentFailure(Code.Protocol, "Copilot inference body exceeds 16 MiB");
    exchange.parts.push(bytes);
    if (params.end === true) {
      exchange.running = true;
      const operation = this.forward(exchange).catch((error: unknown) => {
        if (exchange.controller.signal.aborted) return;
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.options.fail(this.failure);
      }).finally(() => {
        if (this.exchanges.get(params.requestId) === exchange) this.exchanges.delete(params.requestId);
        this.running.delete(operation);
      });
      this.running.add(operation);
    }
    return {};
  }

  private async forward(exchange: CopilotExchange): Promise<void> {
    const bytes = Buffer.concat(exchange.parts), headers = new Headers();
    const delivery = this.options.evidence.request(bytes, exchange.head);
    try {
    for (const [name, values] of Object.entries(exchange.head.headers)) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new ExperimentFailure(Code.Protocol, "Copilot inference headers require string arrays");
      if (!copilotHopHeaders.has(name.toLowerCase())) for (const value of values) headers.append(name, value);
    }
    const request = new Request(exchange.head.url, { method: "POST", headers, body: bytes, signal: exchange.controller.signal, redirect: "error" });
    const response = await (this.options.fetch ?? fetch)(request);
    const responseHeaders: Record<string, string[]> = {};
    response.headers.forEach((value, name) => { responseHeaders[name] = [value]; });
    const send = async (method: string, fields: JsonObject): Promise<void> => {
      const current = () => !exchange.controller.signal.aborted && this.exchanges.get(exchange.head.requestId) === exchange;
      if (!current()) throw new DOMException("Copilot inference exchange was canceled", "AbortError");
      const result = copilotExperimentObject(await this.options.request(method, { requestId: exchange.head.requestId, ...fields }));
      if (!current()) throw new DOMException("Copilot inference exchange was canceled", "AbortError");
      if (result.accepted !== true) throw new ExperimentFailure(Code.Protocol, "Copilot runtime rejected an inference response frame");
    };
    await send("llmInference.httpResponseStart", { status: response.status, statusText: response.statusText, headers: responseHeaders });
    const responseParts: Uint8Array[] = []; let responseBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          responseBytes += next.value.length;
          if (responseBytes > copilotRequestLimit) throw new ExperimentFailure(Code.Protocol, "Copilot inference response exceeds 16 MiB");
          responseParts.push(next.value);
          await send("llmInference.httpResponseChunk", { data: Buffer.from(next.value).toString("base64"), binary: true, end: false });
        }
      } finally { reader.releaseLock(); }
    }
    await send("llmInference.httpResponseChunk", { data: "", end: true });
    if (response.ok && !exchange.controller.signal.aborted && copilotModelResponseSucceeded(delivery, Buffer.concat(responseParts))) this.options.evidence.commit(delivery, Buffer.concat(responseParts));
    } finally { this.options.evidence.discard(delivery); }
  }

  async complete(): Promise<void> {
    await Promise.all([...this.sockets.values()].map((socket) => socket.complete()));
    await Promise.all(this.running);
    if (this.failure) throw this.failure;
    if (this.exchanges.size) throw new ExperimentFailure(Code.HarnessLogMissing, "Copilot inference request is incomplete");
  }

  close(): void {
    for (const socket of this.sockets.values()) socket.dispose();
    this.sockets.clear();
    for (const exchange of this.exchanges.values()) exchange.controller.abort();
    this.exchanges.clear();
  }
}
