import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { ExperimentInventory } from "./experiment-inventory.js";
import { CatalogDelivery } from "./experiment-relay-catalog.js";
import { ExperimentFailure, ExperimentFailureCode, experimentFailure, ExperimentRecording, resultContentSha256, type ExperimentRecord } from "./experiment-records.js";
import { ExperimentServer, MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "./experiment-server.js";
import { PIPE_GIVE_UP_MS } from "./process-runner.js";
import { ExperimentRelayResponse, RELAY_SSE_KEEPALIVE_MS, RELAY_SSE_SWITCH_MS } from "./experiment-relay-response.js";
import { MAX_NATIVE_CALL_ID_CHARS, nativeCallIdBytes,
  parseRelayMessage,
  readRelayBody,
  rejectRelayOversized,
  relayDeclaresBody,
  RelayRequestOversized,
  respondRelay,
} from "./experiment-relay-respond.js";

const REQUEST_BODY_TIMEOUT_MS = 30_000;
const HTTP_HEADERS_TIMEOUT_MS = 120_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 86_400_000;

export type ExperimentRelayCall = { relay_index: number; call_id?: string; native_call_id_source?: "request_meta";
  correlation?: "exact" | "fifo"; name: string; input: unknown; result?: JsonObject; rpc_ids?: (string | number)[] };
export type ExperimentRelayOptions = { catalog?: { body: string }; startFields?: JsonObject;
  sseSwitchMs?: number; sseKeepaliveMs?: number };
type ForwardedResponse = { reply?: JsonObject; call?: ExperimentRelayCall; dispatched_t: number;
  correlation?: "retry" | "retry_cached"; expected_error?: boolean };

/** The experiment server stays outside the harness sandbox. Only this
 * authenticated loopback endpoint is passed to the harness's MCP client. */
export class ExperimentHttpRelay {
  readonly token = randomBytes(32).toString("hex");
  readonly calls: ExperimentRelayCall[] = [];
  resolveCallId?: (call: ExperimentRelayCall, request: JsonObject) => Promise<string>;
  validateResult?: (result: JsonObject) => void;
  mapFailure?: (error: ExperimentFailure) => ExperimentFailure;
  /** Return true while the owner reconciles a failure before retaining it. */
  deferFailure?: (error: ExperimentFailure) => boolean;
  private recording: ExperimentRecording;
  private server: ExperimentServer;
  private inventory: ExperimentInventory;
  private http?: Server;
  private endpoint?: string;
  private catalog?: { nonce: string; body: Buffer };
  private catalogDelivery = new CatalogDelivery((kind, fields) => this.record(kind, fields),
    (error) => this.fail(asError(error)), () => !this.closed && !this.failure);
  private modelToolErrors = 0;
  private callsDelivered = 0;
  private initializeReply?: JsonObject;
  private failure?: ExperimentFailure;
  private mappingFailure = false;
  private closed = false;
  private started = false;
  private closing?: Promise<void>;
  private requests = new Set<Promise<void>>();
  private resolving = new Set<(error: ExperimentFailure) => void>();
  private failureListeners = new Set<(error: Error) => void>();
  private dispatches = new Map<ExperimentRelayCall, { response: Promise<ForwardedResponse>; completed: boolean;
    delivery: ExperimentRelayResponse; nativeId?: string }>();

  constructor(readonly spec: ExperimentSpec, cwd: string, environment: NodeJS.ProcessEnv = process.env,
    private options: ExperimentRelayOptions = {}) {
    if (options.catalog) this.catalog = { nonce: randomBytes(32).toString("hex"), body: Buffer.from(options.catalog.body) };
    this.recording = new ExperimentRecording(spec, cwd, environment,
      { ...options.startFields, catalog_override: options.catalog !== undefined,
        tool_timeout_seconds: experimentToolTimeoutSeconds(spec) });
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
  /** A verified run the launcher still fails (an empty answer): run_end
   * carries it without turning it into a relay failure. */
  private outcome?: ExperimentFailure;
  noteRunOutcome(error: ExperimentFailure): void { if (!this.closed) this.outcome ??= error; }
  get recordingPath(): string { return this.recording.recordingPath; }
  get catalogUrl(): string | undefined {
    return this.catalog && this.endpoint ? new URL(`/catalog/${this.catalog.nonce}`, this.endpoint).href : undefined;
  }
  get catalogServed(): boolean { return this.catalogDelivery.served; }
  get url(): string {
    if (!this.endpoint) throw new Error("experiment HTTP relay has not started");
    return this.endpoint;
  }
  get toolDefinitions(): readonly JsonObject[] | undefined { return this.inventory.definitions; }
  get toolNames(): ReadonlySet<string> { return new Set(this.inventory.definitions?.map((tool) => tool.name) ?? []); }
  readonly record: ExperimentRecord = (kind, fields) => {
    this.recording.record(kind, fields);
    if (kind === "model_tool_error") this.modelToolErrors++;
  };

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("experiment HTTP relay cannot start twice or after closing");
    this.started = true;
    try {
      this.server.start();
      const http = this.http = createServer((request, response) => {
        this.catalogDelivery.requestArrived(request.socket);
        const operation = this.handle(request, response);
        this.requests.add(operation);
        // `finally` here would derive a new promise that rejects whenever
        // `handle` rejects, with no handler of its own: a managed relay
        // failure turned into an unhandled rejection (review round 100).
        // Both settle paths remove the tracked operation; the rejection
        // itself is already handled inside `handle`.
        const done = () => this.requests.delete(operation);
        void operation.then(done, done);
      });
      // Tool replies have no HTTP deadline; request bodies remain bounded.
      http.requestTimeout = 0;
      http.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
      http.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
      http.timeout = 0;
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deadline = Date.now() + REQUEST_BODY_TIMEOUT_MS;
    let delivery: ExperimentRelayResponse | undefined;
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
        // Rejected clients contribute only the request record. An
        // unread declared body closes the connection (declaresBody).
        const unauthorizedClose = relayDeclaresBody(request);
        if (unauthorizedClose) response.shouldKeepAlive = false;
        response.writeHead(401, { "Content-Length": 0, ...(unauthorizedClose ? { Connection: "close" } : {}) });
        response.end();
        return;
      }
      // The route matches the path alone, the catalog route's rule (a
      // query string — an MCP client's `?session_id=…` — is client
      // metadata, not a different route); the full URL, query included,
      // is what the http_request record keeps (round 361, item 5).
      const earlyStatus = request.method !== "POST" ? 405 : path !== "/mcp" ? 404
        : Number(request.headers["content-length"]) > MAX_EXPERIMENT_MESSAGE_BYTES ? 413 : undefined;
      if (earlyStatus !== undefined) {
        this.record("http_request", { method: request.method ?? "", path: request.url ?? "",
          token_matched: true, bytes_base64: "", body_complete: false });
        request.on("error", () => { /* Rejected client disconnects do not fail the experiment. */ });
        if (earlyStatus === 413) { rejectRelayOversized(this.record, request, response, deadline); return; }
        request.resume();
        respondRelay(this.record, response, earlyStatus, Buffer.alloc(0), "POST", true);
        return;
      }
      const body = await readRelayBody(request, deadline);
      this.record("http_request", { method: request.method ?? "", path: request.url ?? "",
        token_matched: true, bytes_base64: body.bytes.toString("base64"), body_complete: body.rejectedStatus === undefined });
      if (body.rejectedStatus !== undefined) {
        if (body.rejectedStatus === 413) { rejectRelayOversized(this.record, request, response, deadline); return; }
        request.resume();
        respondRelay(this.record, response, body.rejectedStatus);
        return;
      }
      const message = parseRelayMessage(body.bytes);
      if (message.method === "tools/call" && message.id !== undefined) delivery = new ExperimentRelayResponse(
        response, message.id, this.record, this.options.sseSwitchMs ?? RELAY_SSE_SWITCH_MS,
        this.options.sseKeepaliveMs ?? RELAY_SSE_KEEPALIVE_MS);
      const { reply, call, dispatched_t, correlation, expected_error } = await this.forward(message, delivery);
      const bytes = reply === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reply));
      if (bytes.length > MAX_EXPERIMENT_MESSAGE_BYTES) {
        throw new ExperimentFailure(ExperimentFailureCode.Protocol, "experiment MCP HTTP response exceeds 1 MiB");
      }
      let delivered_t: number | undefined;
      if (delivery) delivered_t = await delivery.send(bytes, call?.relay_index);
      else {
        const written = finished(response, { readable: false, cleanup: true });
        respondRelay(this.record, response, reply === undefined ? 202 : 200, bytes);
        await written;
        delivered_t = Date.now() / 1000;
      }
      if (call?.result && delivered_t !== undefined) {
        this.dispatches.delete(call);
        this.record("call_ledger", { relay_request_seq: call.relay_index, native_call_id: call.call_id ?? null,
          dispatched_t, delivered_t,
          correlation: correlation ?? call.native_call_id_source ?? call.correlation ?? "exact", rpc_id: message.id,
          result_sha256: resultContentSha256(call.result.content) });
        this.callsDelivered++;
      }
      if (reply?.error !== undefined && !expected_error) {
        const detail = typeof reply.error?.message === "string" ? `: ${reply.error.message}` : "";
        this.fail(new ExperimentFailure(ExperimentFailureCode.ServerError, `experiment MCP ${message.method} returned a JSON-RPC error${detail}`));
      }
    } catch (error) {
      if (error instanceof RelayRequestOversized) {
        // The client's upload fit the bound; the relay's own framing did
        // not. Answer exactly like the body reader's refusal — 413, the
        // connection closed, nothing forwarded — and keep the run alive.
        rejectRelayOversized(this.record, request, response, deadline);
      } else {
        this.fail(asError(error));
        // The request's state is unknown after a throw: always close (a
        // reused socket could carry whatever the handler stopped reading).
        try { if (!response.headersSent) respondRelay(this.record, response, 400, Buffer.alloc(0), "POST", true); else response.destroy(); }
        catch { response.destroy(); }
      }
    } finally {
      // A delivery close that throws (a recording failure on the SSE
      // close record) is a relay failure like any other: it reaches
      // this.fail instead of escaping `handle`, where it would surface
      // as an unhandled rejection on the request's promise (review
      // round 100).
      try { delivery?.close(); }
      catch (error) { this.fail(asError(error)); }
    }
  }

  private serveCatalog(request: IncomingMessage, response: ServerResponse, path: string, query: URLSearchParams): void {
    request.resume();
    const clientVersion = query.get("client_version");
    this.record("http_request", { method: request.method ?? "", path: "/catalog", client_version: clientVersion,
      authorization_present: request.headers.authorization !== undefined, bytes_base64: "", body_complete: true });
    const expected = Buffer.from(this.catalog ? `/catalog/${this.catalog.nonce}` : "");
    const actual = Buffer.from(path);
    // None of the catalog answers read the request body; one that was
    // declared closes the connection instead of leaving its bytes for
    // the next request on the socket (declaresBody, lane C30, item 6).
    const unreadBody = relayDeclaresBody(request);
    if (!this.catalog || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      respondRelay(this.record, response, 404, Buffer.alloc(0), "POST", unreadBody);
      return;
    }
    if (request.method !== "GET") { respondRelay(this.record, response, 405, Buffer.alloc(0), "GET", unreadBody); return; }
    const body = this.catalog.body;
    // Registered before `respondRelay` ends the response: a small body
    // can finish inside `end` (experiment-relay-catalog.ts has the rule).
    this.catalogDelivery.track(response, clientVersion, body.length);
    respondRelay(this.record, response, 200, body, "POST", unreadBody);
  }

  private async forward(message: JsonObject, delivery?: ExperimentRelayResponse): Promise<ForwardedResponse> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("experiment HTTP relay is closed");
    if (["resources/list", "resources/templates/list", "resources/read"].includes(message.method)) {
      this.record("relay_resources", { method: message.method, rpc_id: message.id ?? null });
      const dispatched_t = Date.now() / 1000;
      if (message.id === undefined) return { dispatched_t };
      const read = message.method === "resources/read";
      return { dispatched_t, expected_error: read, reply: { jsonrpc: "2.0", id: message.id,
        ...(read ? { error: { code: -32002, message: "no resources" } } : {
          result: message.method === "resources/list" ? { resources: [] } : { resourceTemplates: [] },
        }) } };
    }
    if (message.id !== undefined && (message.method === "ping" ||
        (message.method === "initialize" && this.initializeReply))) {
      const ping = message.method === "ping";
      // Liveness must not wait for the server's stdin loop. A reconnect
      // reuses the established session and leaves outstanding calls intact.
      this.record(ping ? "relay_ping" : "relay_reinitialize", { rpc_id: message.id });
      return { reply: { jsonrpc: "2.0", id: message.id, result: ping ? {} : this.initializeReply!.result },
        dispatched_t: Date.now() / 1000 };
    }
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
      const meta = message.params._meta;
      if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta))) throw new Error("experiment MCP request metadata must be an object");
      if (!delivery) throw new Error("experiment MCP tools/call lacks an HTTP response");
      const nativeId = typeof meta?.callId === "string" && meta.callId.trim() ? meta.callId : undefined;
      const retry = [...this.dispatches].find(([candidate, dispatch]) =>
        candidate.name === name && isDeepStrictEqual(candidate.input, input) &&
        (nativeId === undefined || nativeId === (dispatch.nativeId ?? candidate.call_id)) &&
        dispatch.delivery.abandoned && (!dispatch.completed || dispatch.delivery.failed));
      if (retry) {
        const [previous, dispatch] = retry;
        const correlation = dispatch.completed ? "retry_cached" : "retry";
        // A replacement with an open connection cannot absorb another identical call.
        dispatch.delivery = delivery;
        previous.rpc_ids!.push(message.id);
        this.record("tool_call", { ...previous, relay_request_seq: previous.relay_index, correlation });
        const forwarded = await dispatch.response;
        return { ...forwarded, reply: forwarded.reply && { ...forwarded.reply, id: message.id }, correlation };
      }
      // The final wire body, not the uploaded one, must fit the bound: the
      // dispatch injects a call id the client never sent, and
      // re-serialization can outgrow the raw body. Measured here with the
      // longest id the resolver may answer, BEFORE the call is registered,
      // resolved, or recorded, so a refusal consumes no relay index and
      // leaves no correlation state (review rounds 73 and 74); the
      // refusal itself is evidence. A retry of an earlier dispatch is never
      // forwarded, so it is matched first and never measured (round 76).
      const probe = { ...message, params: { ...message.params, _meta: { ...meta, "codemux/callId": "x".repeat(MAX_NATIVE_CALL_ID_CHARS) } } };
      if (Buffer.byteLength(JSON.stringify(probe)) > MAX_EXPERIMENT_MESSAGE_BYTES) {
        this.record("request_refused", { rpc_id: message.id, method: message.method, reason: "oversized" });
        throw new RelayRequestOversized("experiment MCP forwarded request exceeds 1 MiB");
      }
      call = { relay_index: this.calls.length, name, input, rpc_ids: [message.id] };
      this.calls.push(call);
      const dispatch = { response: this.dispatch(message, call), completed: false, delivery, nativeId };
      dispatch.response = dispatch.response.then((forwarded) => { dispatch.completed = true; return forwarded; });
      this.dispatches.set(call, dispatch);
      return dispatch.response;
    }
    return this.dispatch(message);
  }

  private async dispatch(message: JsonObject, call?: ExperimentRelayCall): Promise<ForwardedResponse> {
    if (call) {
      try {
        if (!this.resolveCallId) throw new Error("experiment MCP call has no native call ID resolver");
        const callId = await this.nativeCallId(call, message);
        if (typeof callId !== "string" || !callId.trim()) throw new Error("experiment MCP native call ID must be nonempty");
        if (nativeCallIdBytes(callId) > MAX_NATIVE_CALL_ID_CHARS) throw new Error(`experiment MCP native call ID exceeds ${MAX_NATIVE_CALL_ID_CHARS} bytes in its JSON spelling`);
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
      this.record("tool_call", { ...call, relay_request_seq: call.relay_index });
    }
    // The forwarder's own rule, the serialized body alone. The acceptance
    // probe above measured the worst case for a tools/call and the HTTP
    // reader bounds every other body, so this cannot trigger; it stays as
    // the invariant that nothing over the bound reaches the server.
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_EXPERIMENT_MESSAGE_BYTES) {
      throw new ExperimentFailure(ExperimentFailureCode.Protocol, "experiment MCP forwarded request exceeds 1 MiB");
    }
    this.record("mcp_request", { rpc_id: message.id ?? null,
      ...(call ? { relay_index: call.relay_index, relay_request_seq: call.relay_index } : {}), message });
    const dispatched_t = Date.now() / 1000;
    const reply = await this.server.request(message);
    if (this.failure) throw this.failure;
    if (reply === undefined) return { dispatched_t };
    if (reply.id !== message.id) throw new Error("experiment MCP response id mismatch");
    if (reply.error !== undefined) return { reply, dispatched_t };
    if (message.method === "initialize") this.initializeReply = reply;
    if (message.method === "tools/list") {
      if (message.params?.cursor !== undefined) throw new Error("experiment tools/list must start at the first page");
      await this.inventory.accept(reply, null);
    }
    if (call) {
      const result = reply.result;
      if (!Array.isArray(result?.content)) throw new Error("experiment tools/call must return an MCP content result");
      this.record("server_tool_result", { relay_index: call.relay_index, relay_request_seq: call.relay_index,
        rpc_id: message.id, result, result_sha256: resultContentSha256(result.content) });
      if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("MCP tools/call isError must be a boolean");
      for (const field of ["structuredContent", "_meta"]) {
        if (Object.hasOwn(result, field)) throw new ExperimentFailure(ExperimentFailureCode.UnsupportedResult, `experiment HTTP tools/call results cannot include ${field}`);
      }
      this.validateResult?.(result);
      call.result = result;
    }
    return { reply, call, dispatched_t };
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
    let error = experimentFailure(cause);
    if (this.mapFailure && !this.mappingFailure) {
      this.mappingFailure = true;
      try { error = this.mapFailure(error); }
      finally { this.mappingFailure = false; }
    }
    if (this.deferFailure?.(error)) return;
    if (this.failure || this.closed) return;
    this.failure = error;
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
    const outcome = error === null ? this.outcome : undefined;
    try { this.recording.close({ tool_calls: this.calls.length, model_tool_errors: this.modelToolErrors, calls_delivered: this.callsDelivered,
      error: error ?? outcome?.message ?? null, code: error ? this.failureCode ?? ExperimentFailureCode.Protocol : outcome?.code ?? null }); }
    finally { this.closed = true; this.dispatches.clear(); }
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
