/** Loopback completion broker. Caps drain responses; signals abort them. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { badRequest, CompleteError, errorBody } from "./errors.js";
import { forwardCompletion, type Exchange, type ResponseSink } from "./forward.js";
import { clearProxyEnvironment } from "./provider.js";
import { CompleteTransport } from "./transport.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export type ServerStop = "signal" | "cap";

export interface ServerOptions extends Omit<Exchange, "shutdown"> {
  port: number;
}

export interface ServerSummary {
  reason: ServerStop;
  requests: number;
  spentUsd: number;
  capReason: string | null;
}

export class CompleteServer {
  readonly token = randomBytes(32).toString("base64url");
  private readonly shutdown = new AbortController();
  private readonly transport = new CompleteTransport();
  private http: ReturnType<typeof Bun.serve> | null = null;
  private inFlight = 0;
  private stopping: ServerStop | null = null;
  private transportClosing = false;
  private transportClosed = false;
  private resolveDone!: (summary: ServerSummary) => void;
  readonly done: Promise<ServerSummary> = new Promise((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(private readonly options: ServerOptions) {}

  async start(): Promise<string> {
    clearProxyEnvironment();
    this.http = Bun.serve({
      hostname: LOOPBACK_HOST,
      port: 0,
      // Uploads have their own deadline and byte limit, with ledger rows.
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      // A slow reader must not lose a paid answer to the idle timeout.
      idleTimeout: 0,
      fetch: (request) => this.handle(request),
    });
    try {
      const port = await this.transport.start(this.options.port, this.http.port!);
      return `http://${LOOPBACK_HOST}:${port}`;
    } catch (error) {
      await this.http.stop(true);
      throw error;
    }
  }

  /** Refuse new admissions at a cap, then drain native response writes.
   * A signal outranks a cap and aborts both upstreams and client sockets. */
  stop(reason: ServerStop): void {
    if (this.stopping === null || reason === "signal") this.stopping = reason;
    if (reason === "signal") {
      this.shutdown.abort();
      void this.http?.stop(true);
      void this.transport.stop(true);
    }
    this.finishIfIdle();
  }

  private finishIfIdle(): void {
    if (this.stopping === null || this.inFlight > 0) return;
    if (this.stopping === "cap" && this.http !== null && !this.transportClosed) {
      if (!this.transportClosing) {
        this.transportClosing = true;
        // HTTP completion can precede TCP drainage on pinned Bun. Wait for
        // both the HTTP handlers and the relay's client sockets to close.
        void this.transport.stop(false).then(() => this.http!.stop(false)).then(() => {
          this.transportClosed = true;
          this.finishIfIdle();
        });
      }
      return;
    }
    const { governor } = this.options;
    this.resolveDone({
      reason: this.stopping,
      requests: governor.requests,
      spentUsd: governor.spentUsd,
      capReason: governor.capReached(),
    });
  }

  private authorized(request: Request): boolean {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private handle(request: Request): Response | Promise<Response> {
    if (!this.authorized(request)) return failure(401, "unauthorized", "missing or wrong bearer token");
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return failure(404, "not_found", "only POST /v1/chat/completions is served");
    }
    if (request.method !== "POST") return failure(405, "method_not_allowed", "only POST /v1/chat/completions is served");
    if (this.stopping === "signal") {
      const error = new CompleteError(503, "shutting_down", "the server is stopping");
      this.options.governor.refuse(null, Date.now(), error);
      return failure(error.status, error.code, error.message);
    }
    this.inFlight++;
    return new Promise<Response>((resolve) => {
      const finished = new AbortController();
      const sink = sinkFor(resolve, AbortSignal.any([request.signal, finished.signal]));
      void this.forward(request, sink).finally(() => {
        // Release any upstream connection left open after a terminal event
        // or translation error, even if reader.cancel() only releases its reader.
        finished.abort();
        this.inFlight--;
        if (this.options.governor.exhausted) this.stop("cap");
        this.finishIfIdle();
      });
    });
  }

  private async forward(request: Request, sink: ResponseSink): Promise<void> {
    try {
      let parsed: unknown;
      try {
        parsed = await readJson(request, this.options.timeoutMs, this.shutdown.signal);
      } catch (error) {
        if (this.shutdown.signal.aborted && !(error instanceof CompleteError && error.code === "payload_too_large")) {
          this.options.governor.interrupted(Date.now());
          throw new CompleteError(503, "shutting_down", "the server is stopping");
        }
        const refusal = error instanceof CompleteError ? error : badRequest("the request body could not be read");
        this.options.governor.refuse(null, Date.now(), refusal);
        throw refusal;
      }
      await forwardCompletion(parsed, { ...this.options, shutdown: this.shutdown.signal }, sink);
    } catch (error) {
      const refusal = error instanceof CompleteError ? error : new CompleteError(502, "upstream_malformed", String(error));
      sink.send(refusal.status, "application/json", errorBody(refusal.code, refusal.message));
    }
  }
}

function failure(status: number, code: Parameters<typeof errorBody>[0], message: string): Response {
  return new Response(errorBody(code, message), { status, headers: { "content-type": "application/json", connection: "close" } });
}

async function readJson(request: Request, timeoutMs: number, shutdown: AbortSignal): Promise<unknown> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const signal = AbortSignal.any([shutdown, request.signal]);
  let timer: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(badRequest("the connection closed before the request body ended"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(badRequest("the request body timed out")), timeoutMs);
    if (signal.aborted) abort();
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) chunks.length = 0;
      else chunks.push(value);
    }
    if (size > MAX_REQUEST_BYTES) {
      throw new CompleteError(413, "payload_too_large", `the request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abort);
    // Do not await cancellation of a client that stopped uploading.
    void reader.cancel().catch(() => {});
  }
}

function sinkFor(resolve: (response: Response) => void, closed: AbortSignal): ResponseSink {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let begun = false;
  let ended = false;
  const encoder = new TextEncoder();
  return {
    closed,
    send(status, contentType, body) {
      if (begun) return;
      begun = true;
      resolve(new Response(body, { status, headers: { "content-type": contentType, connection: "close" } }));
    },
    begin(status) {
      begun = true;
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        cancel() { ended = true; },
      });
      resolve(new Response(stream, { status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" } }));
    },
    write(text) { if (!ended) controller?.enqueue(encoder.encode(text)); },
    end() {
      if (!ended) controller?.close();
      ended = true;
    },
  };
}
