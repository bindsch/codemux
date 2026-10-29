import type { ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { ExperimentRecord } from "./experiment-records.js";

const SSE_KEEPALIVE = ": keepalive\n\n";
export const RELAY_SSE_SWITCH_MS = 2000;
export const RELAY_SSE_KEEPALIVE_MS = 15_000;

/** Start the POST response before a client's response-start deadline expires. */
export class ExperimentRelayResponse {
  private switchTimer: ReturnType<typeof setTimeout>;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private streaming = false;
  private keepalives = 0;
  private deliveryError?: Error;
  private clientClosed = false;
  private closingLocally = false;
  private deliveryFailed = false;
  private written: Promise<void>;

  get abandoned(): boolean { return this.clientClosed; }
  get failed(): boolean { return this.deliveryFailed; }

  constructor(private response: ServerResponse, private rpcId: string | number,
    private record: ExperimentRecord, switchMs: number, keepaliveMs: number) {
    this.written = finished(response, { readable: false, cleanup: true }).catch((error) => {
      this.deliveryError = error;
    });
    const socket = response.socket;
    this.clientClosed = response.destroyed || socket?.destroyed === true;
    const closed = () => {
      if (!response.writableFinished && !this.closingLocally) this.clientClosed = true;
      this.stopTimers();
      socket?.off("close", closed);
    };
    response.once("close", closed);
    socket?.once("close", closed);
    this.switchTimer = setTimeout(() => {
      if (response.destroyed) return;
      try {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          Connection: "keep-alive" });
        response.flushHeaders();
        this.streaming = true;
        this.keepalive();
        this.keepaliveTimer = setInterval(() => this.keepalive(), keepaliveMs);
      } catch (error) { this.disconnect(error); }
    }, switchMs);
  }

  private disconnect(error: unknown): void {
    this.deliveryError = error instanceof Error ? error : new Error(String(error));
    this.stopTimers();
    this.closingLocally = true;
    this.response.destroy();
  }

  private keepalive(): void {
    if (this.response.destroyed) { this.stopTimers(); return; }
    try { this.response.write(SSE_KEEPALIVE); this.keepalives++; }
    catch (error) { this.disconnect(error); }
  }

  private stopTimers(): void {
    clearTimeout(this.switchTimer);
    clearInterval(this.keepaliveTimer);
  }

  async send(bytes: Buffer, relayRequestSeq?: number): Promise<number | undefined> {
    this.stopTimers();
    const data = this.streaming ? Buffer.from(`event: message\ndata: ${bytes.toString()}\n\n`) : bytes;
    if (!this.deliveryError && !this.response.destroyed) {
      const recorded = this.streaming ? Buffer.concat([Buffer.from(SSE_KEEPALIVE.repeat(this.keepalives)), data]) : data;
      this.record("http_response", { status: 200, bytes_base64: recorded.toString("base64") });
    }
    try {
      if (this.deliveryError || this.response.destroyed) throw this.deliveryError ?? new Error("HTTP response connection closed");
      if (!this.streaming) this.response.writeHead(200, { "Content-Type": "application/json", "Content-Length": bytes.length });
      if (this.streaming) this.response.write(data);
      const delivered = Date.now() / 1000;
      this.response.end(this.streaming ? undefined : data);
      await this.written;
      if (this.deliveryError) throw this.deliveryError;
      return this.streaming ? delivered : Date.now() / 1000;
    } catch (error) {
      this.record("relay_delivery_failed", { rpc_id: this.rpcId, relay_request_seq: relayRequestSeq,
        message: error instanceof Error ? error.message : String(error) });
      this.deliveryFailed = true;
      this.closingLocally = true;
      this.response.destroy();
      return undefined;
    } finally { this.close(); }
  }

  close(): void {
    this.stopTimers();
    if (!this.streaming) return;
    this.streaming = false;
    this.record("relay_sse", { rpc_id: this.rpcId, keepalives: this.keepalives });
  }
}
