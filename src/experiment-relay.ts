import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { ExperimentInventory } from "./experiment-inventory.js";
import { ExperimentFailure, ExperimentFailureCode, experimentFailure, ExperimentRecording, type ExperimentRecord } from "./experiment-records.js";
import { ExperimentServer, MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "./experiment-server.js";
import { PIPE_GIVE_UP_MS } from "./process-runner.js";

const REQUEST_BODY_TIMEOUT_MS = 30_000;

export type ExperimentRelayCall = { relay_index: number; call_id?: string; native_call_id_source?: "request_meta";
  name: string; input: unknown; result?: JsonObject };
export type ExperimentRelayOptions = { catalog?: { body: string }; startFields?: JsonObject };

/** The experiment server stays outside the harness sandbox. Only this
 * authenticated loopback endpoint is passed to the harness's MCP client. */
export class ExperimentHttpRelay {
  readonly token = randomBytes(32).toString("hex");
  readonly calls: ExperimentRelayCall[] = [];
  resolveCallId?: (call: ExperimentRelayCall, request: JsonObject) => Promise<string>;
  validateResult?: (result: JsonObject) => void;
  private recording: ExperimentRecording;
  private server: ExperimentServer;
  private inventory: ExperimentInventory;
  private http?: Server;
  private endpoint?: string;
  private catalog?: { nonce: string; body: Buffer };
  private catalogDelivered = false;
  private failure?: ExperimentFailure;
  private closed = false;
  private started = false;
  private closing?: Promise<void>;
  private requests = new Set<Promise<void>>();
  private resolving = new Set<(error: ExperimentFailure) => void>();
  private failureListeners = new Set<(error: Error) => void>();

  constructor(readonly spec: ExperimentSpec, cwd: string, environment: NodeJS.ProcessEnv = process.env,
    options: ExperimentRelayOptions = {}) {
    if (options.catalog) this.catalog = { nonce: randomBytes(32).toString("hex"), body: Buffer.from(options.catalog.body) };
    this.recording = new ExperimentRecording(spec, cwd, environment,
      { ...options.startFields, catalog_override: options.catalog !== undefined });
    try {
      this.server = new ExperimentServer(spec, cwd, environment, this.record,
        (error) => this.fail(error), () => this.inventory.changed());
      this.inventory = new ExperimentInventory(spec.name, (message) => this.server.request(message),
        this.record, (error) => this.fail(error), () => !this.closed && !this.failure);
    } catch (error) { this.recording.discard(); throw error; }
  }

  get runId(): string { return this.recording.runId; }
  get failureError(): ExperimentFailure | null { return this.failure ?? null; }
  get failureCode(): ExperimentFailureCode | null { return this.failure?.code ?? null; }
  get recordingPath(): string { return this.recording.recordingPath; }
  get catalogUrl(): string | undefined {
    return this.catalog && this.endpoint ? new URL(`/catalog/${this.catalog.nonce}`, this.endpoint).href : undefined;
  }
  get catalogServed(): boolean { return this.catalogDelivered; }
  get url(): string {
    if (!this.endpoint) throw new Error("experiment HTTP relay has not started");
    return this.endpoint;
  }
  get toolDefinitions(): readonly JsonObject[] | undefined { return this.inventory.definitions; }
  get toolNames(): ReadonlySet<string> { return new Set(this.inventory.definitions?.map((tool) => tool.name) ?? []); }
  readonly record: ExperimentRecord = (kind, fields) => this.recording.record(kind, fields);

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("experiment HTTP relay cannot start twice or after closing");
    this.started = true;
    try {
      this.server.start();
      const http = this.http = createServer((request, response) => {
        const operation = this.handle(request, response);
        this.requests.add(operation);
        void operation.finally(() => this.requests.delete(operation));
      });
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
      });
      http.on("error", (error) => this.fail(error));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("experiment HTTP relay lacks a loopback address");
      this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
    } catch (error) { this.fail(asError(error)); throw error; }
  }

  private tokenMatches(value: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(value ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private body(request: IncomingMessage, deadline: number): Promise<{ bytes: Buffer; rejectedStatus?: 408 | 413 }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      let settled = false;
      const complete = (rejectedStatus?: 408 | 413) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rejectedStatus) request.pause();
        resolve({ bytes: Buffer.concat(chunks), rejectedStatus });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => complete(408), Math.max(0, deadline - Date.now()));
      request.on("data", (chunk: Buffer) => {
        if (settled) return;
        const bytes = Buffer.from(chunk);
        chunks.push(bytes);
        length += bytes.length;
        if (length > MAX_EXPERIMENT_MESSAGE_BYTES) complete(413);
      });
      request.once("end", () => complete());
      request.once("error", fail);
      request.once("aborted", () => fail(new Error("experiment HTTP request aborted")));
    });
  }

  private respond(response: ServerResponse, status: number, bytes: Buffer = Buffer.alloc(0), allowedMethod = "POST"): void {
    this.record("http_response", { status, bytes_base64: bytes.toString("base64") });
    response.writeHead(status, { ...(status === 200 ? { "Content-Type": "application/json" } : {}),
      ...(status === 405 ? { Allow: allowedMethod } : {}), ...(status === 413 || status === 408 ? { Connection: "close" } : {}), "Content-Length": bytes.length });
    response.end(bytes);
  }

  private rejectOversized(request: IncomingMessage, response: ServerResponse, deadline: number): void {
    this.record("http_response", { status: 413, bytes_base64: "" });
    response.shouldKeepAlive = false;
    response.writeHead(413, { Connection: "close", "Content-Length": 0 });
    response.flushHeaders();
    if (request.readableEnded || request.destroyed) { response.end(); return; }
    // Flush the complete empty reply before closing an upload with pending writes.
    // Draining shares the original body deadline, including time already spent reading.
    const complete = () => {
      clearTimeout(timer);
      request.off("end", complete);
      request.off("close", complete);
      response.end();
    };
    const timer = setTimeout(complete, Math.max(0, deadline - Date.now()));
    request.once("end", complete);
    request.once("close", complete);
    request.resume();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deadline = Date.now() + REQUEST_BODY_TIMEOUT_MS;
    try {
      const target = request.url ?? "";
      const path = target.split("?", 1)[0] ?? "";
      if (path === "/catalog" || path.startsWith("/catalog/")) {
        this.serveCatalog(request, response, path, new URLSearchParams(target.slice(path.length + 1)));
        return;
      }
      const tokenMatched = this.tokenMatches(request.headers.authorization);
      if (!tokenMatched) {
        this.record("http_request", { method: request.method ?? "", path: request.url ?? "",
          token_matched: false, bytes_base64: "", body_complete: false });
        request.on("error", () => { /* Unauthenticated client disconnects do not fail the experiment. */ });
        request.resume();
        // Rejected clients contribute only the request record.
        response.writeHead(401, { "Content-Length": 0 });
        response.end();
        return;
      }
      const earlyStatus = request.method !== "POST" ? 405 : request.url !== "/mcp" ? 404
        : Number(request.headers["content-length"]) > MAX_EXPERIMENT_MESSAGE_BYTES ? 413 : undefined;
      if (earlyStatus !== undefined) {
        this.record("http_request", { method: request.method ?? "", path: request.url ?? "",
          token_matched: true, bytes_base64: "", body_complete: false });
        request.on("error", () => { /* Rejected client disconnects do not fail the experiment. */ });
        if (earlyStatus === 413) { this.rejectOversized(request, response, deadline); return; }
        request.resume();
        response.shouldKeepAlive = false;
        this.respond(response, earlyStatus);
        return;
      }
      const body = await this.body(request, deadline);
      this.record("http_request", { method: request.method ?? "", path: request.url ?? "",
        token_matched: true, bytes_base64: body.bytes.toString("base64"), body_complete: body.rejectedStatus === undefined });
      if (body.rejectedStatus !== undefined) {
        if (body.rejectedStatus === 413) { this.rejectOversized(request, response, deadline); return; }
        request.resume();
        this.respond(response, body.rejectedStatus);
        return;
      }
      const message = parseMessage(body.bytes);
      const reply = await this.forward(message);
      const bytes = reply === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reply));
      if (bytes.length > MAX_EXPERIMENT_MESSAGE_BYTES) {
        throw new ExperimentFailure(ExperimentFailureCode.Protocol, "experiment MCP HTTP response exceeds 1 MiB");
      }
      this.respond(response, reply === undefined ? 202 : 200, bytes);
      if (reply?.error !== undefined) {
        const detail = typeof reply.error?.message === "string" ? `: ${reply.error.message}` : "";
        this.fail(new ExperimentFailure(ExperimentFailureCode.ServerError, `experiment MCP ${message.method} returned a JSON-RPC error${detail}`));
      }
    } catch (error) {
      this.fail(asError(error));
      try { if (!response.headersSent) this.respond(response, 400); else response.destroy(); }
      catch { response.destroy(); }
    }
  }

  private serveCatalog(request: IncomingMessage, response: ServerResponse, path: string, query: URLSearchParams): void {
    request.resume();
    const clientVersion = query.get("client_version");
    this.record("http_request", { method: request.method ?? "", path: "/catalog", client_version: clientVersion,
      authorization_present: request.headers.authorization !== undefined, bytes_base64: "", body_complete: true });
    const expected = Buffer.from(this.catalog ? `/catalog/${this.catalog.nonce}` : "");
    const actual = Buffer.from(path);
    if (!this.catalog || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      this.respond(response, 404);
      return;
    }
    if (request.method !== "GET") { this.respond(response, 405, Buffer.alloc(0), "GET"); return; }
    this.respond(response, 200, this.catalog.body);
    this.catalogDelivered = true;
    this.record("catalog_served", { client_version: clientVersion, bytes: this.catalog.body.length });
  }

  private async forward(message: JsonObject): Promise<JsonObject | undefined> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("experiment HTTP relay is closed");
    let call: ExperimentRelayCall | undefined;
    if (message.method === "tools/call") {
      if (message.id === undefined) throw new ExperimentFailure(ExperimentFailureCode.Protocol, "experiment MCP tools/call requires a request id");
      if (!this.inventory.definitions) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "MCP tools/call before validated experiment inventory");
      const name = message.params?.name;
      if (typeof name !== "string" || !this.inventory.names.has(this.inventory.namespaced(name))) {
        throw new ExperimentFailure(ExperimentFailureCode.UnknownTool, "experiment MCP called an unknown tool");
      }
      const input = Object.hasOwn(message.params, "arguments") ? message.params.arguments : {};
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new ExperimentFailure(ExperimentFailureCode.Protocol, "experiment MCP tool arguments must be an object");
      }
      message.params.arguments = input;
      call = { relay_index: this.calls.length, name, input };
      this.calls.push(call);
      try {
        if (!this.resolveCallId) throw new Error("experiment MCP call has no native call ID resolver");
        const callId = await this.nativeCallId(call, message);
        if (typeof callId !== "string" || !callId.trim()) throw new Error("experiment MCP native call ID must be nonempty");
        if (this.calls.some((other) => other !== call && other.call_id === callId)) throw new Error("experiment MCP native call ID is duplicated");
        call.call_id = callId;
      } catch (error) {
        throw error instanceof ExperimentFailure ? error : new ExperimentFailure(ExperimentFailureCode.CallIdUnresolved,
          error instanceof Error ? error.message : String(error));
      }
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error("experiment HTTP relay is closed");
      const meta = message.params._meta;
      if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta))) throw new Error("experiment MCP request metadata must be an object");
      message.params._meta = { ...meta, "codemux/callId": call.call_id };
      this.record("tool_call", { ...call });
    }
    this.record("mcp_request", { rpc_id: message.id ?? null, ...(call ? { relay_index: call.relay_index } : {}), message });
    const reply = await this.server.request(message);
    if (this.failure) throw this.failure;
    if (reply === undefined) return undefined;
    if (reply.id !== message.id) throw new Error("experiment MCP response id mismatch");
    if (reply.error !== undefined) return reply;
    if (message.method === "tools/list") {
      if (message.params?.cursor !== undefined) throw new Error("experiment tools/list must start at the first page");
      await this.inventory.accept(reply, null);
    }
    if (call) {
      const result = reply.result;
      this.record("server_tool_result", { relay_index: call.relay_index, rpc_id: message.id, result });
      if (!Array.isArray(result?.content)) throw new Error("experiment tools/call must return an MCP content result");
      if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("MCP tools/call isError must be a boolean");
      for (const field of ["structuredContent", "_meta"]) {
        if (Object.hasOwn(result, field)) throw new ExperimentFailure(ExperimentFailureCode.UnsupportedResult, `experiment HTTP tools/call results cannot include ${field}`);
      }
      this.validateResult?.(result);
      call.result = result;
    }
    return reply;
  }

  private async nativeCallId(call: ExperimentRelayCall, request: JsonObject): Promise<string> {
    let cancel!: (error: ExperimentFailure) => void;
    const canceled = new Promise<never>((_resolve, reject) => { cancel = reject; });
    this.resolving.add(cancel);
    try { return await Promise.race([this.resolveCallId!(call, request), canceled]); }
    finally { this.resolving.delete(cancel); }
  }

  fail(cause: unknown): void {
    if (this.failure || this.closed) return;
    const error = this.failure = experimentFailure(cause);
    try { this.record("failure", { code: error.code, message: error.message }); }
    catch { console.error(`codemux: experiment recording failed: ${error.message}`); }
    for (const listener of this.failureListeners) {
      try { listener(error); } catch { /* A callback cannot replace the recorded failure. */ }
    }
  }

  onFailure(callback: (error: Error) => void): () => void {
    this.failureListeners.add(callback);
    if (this.failure) callback(this.failure);
    return () => { this.failureListeners.delete(callback); };
  }

  finish(): void {
    if (this.failure) throw this.failure;
    let error: Error | undefined;
    if (!this.inventory.definitions) error = new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment ended without a validated tool inventory");
    else if (this.calls.some((call) => !call.result)) error = new Error("experiment ended without every server tool result");
    if (error) { this.fail(error); throw error; }
  }

  terminateProtocol(): void {
    for (const cancel of this.resolving) cancel(new ExperimentFailure(ExperimentFailureCode.CallIdUnresolved,
      "experiment relay stopped before native call ID resolution"));
    this.server.terminate();
    this.http?.close();
    this.http?.closeAllConnections();
  }

  closeSync(): void {
    if (this.closed) return;
    this.fail(new ExperimentFailure(ExperimentFailureCode.Protocol, "process exited before asynchronous experiment cleanup completed"));
    try { this.terminateProtocol(); }
    finally { this.closeRecording(this.failure!.message); }
  }

  close(): Promise<void> { return this.closing ??= this.finalize(); }

  private async finalize(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.inventory.rechecking && !this.failure) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([(async () => { while (this.inventory.rechecking) await this.inventory.rechecking; })(),
            new Promise<void>((resolve) => { timer = setTimeout(() => {
              this.fail(new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment tool inventory recheck did not complete before shutdown")); resolve();
            }, PIPE_GIVE_UP_MS); })]);
        } finally { if (timer) clearTimeout(timer); }
      }
      this.terminateProtocol();
      await this.server.close();
      await Promise.allSettled(this.requests);
      await this.inventory.rechecking;
    } catch (error) { this.fail(asError(error)); }
    finally { this.closeRecording(this.failure?.message ?? null); }
    if (this.failure) throw this.failure;
  }

  private closeRecording(error: string | null): void {
    if (this.closed) return;
    try { this.recording.close({ tool_calls: this.calls.length, error, code: error ? this.failureCode ?? ExperimentFailureCode.Protocol : null }); }
    finally { this.closed = true; }
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function parseMessage(bytes: Buffer): JsonObject {
  const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" || !message.method ||
      (Object.hasOwn(message, "id") && typeof message.id !== "string" &&
        !(typeof message.id === "number" && Number.isSafeInteger(message.id))) ||
      (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params)))) {
    throw new Error("experiment HTTP body must be one JSON-RPC request or notification object");
  }
  return message;
}
