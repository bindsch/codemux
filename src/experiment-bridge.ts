import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { codemuxStateDir } from "./call-log.js";
import { PIPE_GIVE_UP_MS, type StdoutSink } from "./process-runner.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { ExperimentServer, MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "./experiment-server.js";

// An experiment server names its own tools. Claude Code 2.1.300's SDK bridge
// rejects an injected tools[] entry whose `name` fails /^[a-zA-Z0-9_-]{1,64}$/
// (its "[bridge:meta-mcp] injected tools[] entry is malformed" check, read
// from the binary); whether that entry carries the raw or the namespaced
// name is not visible there, so the namespaced form mcp__<server>__<tool> is
// held to 64 characters, which satisfies both readings (the MCP name parser
// allows 128). The inventory checks below keep the exposed set equal to the
// advertised one, so a name cannot reach a built-in tool. Tool definitions,
// inputSchema included, pass through unchanged; a large inventory is bounded
// only by the control frame limit (MAX_EXPERIMENT_MESSAGE_BYTES).
const EXPERIMENT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAMESPACED_TOOL_NAME = 64;
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
// SDKMessage discriminants and the SDK control transport envelopes.
// https://code.claude.com/docs/en/agent-sdk/typescript#sdkmessage
const CLAUDE_FRAME_TYPES = new Set([
  "assistant", "user", "result", "system", "stream_event", "tool_progress",
  "auth_status", "tool_use_summary", "rate_limit_event", "prompt_suggestion",
  "conversation_reset", "control_request", "control_response", "control_cancel_request", "keep_alive",
]);

/** One bound governs every experiment control frame; the prompt preflight in
 * experiment-mcp.ts and this bridge's send path measure against the same
 * constant. Re-exported so the preflight needs no second copy. */
export { MAX_EXPERIMENT_MESSAGE_BYTES };

/** The exact user frame the bridge serializes for a prompt. The preflight
 * must measure the bytes send() would actually write, not the prompt alone. */
export function experimentUserFrameBytes(prompt: string): number {
  return Buffer.byteLength(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
}

/** Claude's SDK control transport. Raw stdio and the harness's emitted
 * model-bound tool_result blocks are different evidence and remain separate.
 */
// Claude Code 2.1.300 delivers a server result whose content is one text
// block as that block's text, a plain string, with trailing whitespace removed
// (seen on an `isError` Playwright result: "...\n" arrived without the newline).
// That canonical form is accepted in either error state; any other difference
// (another block type, more than one block, a changed character, leading
// whitespace) still fails the run.
export function modelResultMatches(expected: unknown, actual: unknown): boolean {
  if (isDeepStrictEqual(expected, actual)) return true;
  if (!Array.isArray(expected) || expected.length !== 1) return false;
  const block = expected[0];
  if (!block || typeof block !== "object" || (block as JsonObject).type !== "text") return false;
  const text = (block as JsonObject).text;
  // Claude removes trailing whitespace; it never adds any, so only the
  // removed form is accepted, never an actual with whitespace the server did not send.
  return typeof text === "string" && typeof actual === "string" && (actual === text || actual === text.trimEnd());
}

export class ExperimentBridge implements StdoutSink {
  readonly runId = randomUUID();
  readonly recordingPath: string;
  private fd: number;
  private sequence = 0;
  private recordedBytes = 0;
  private buffer = "";
  private result = "";
  private trace = "";
  private server: ExperimentServer;
  private write?: (line: string) => void;
  private end?: () => void;
  private abort?: () => void;
  private failure?: Error;
  private closed = false;
  private closing?: Promise<void>;
  private closeFailure?: Error;
  private closeFailureReported = false;
  private initialized = false;
  private inventoryValidated = false;
  private initRequest = randomUUID();
  private calls = new Map<string, { name: string; input: unknown; claimed: boolean; result?: JsonObject; received: boolean }>();
  private activeControls = new Set<string>();
  private toolNames = new Set<string>();
  private toolDefinitions?: unknown[];
  private inventoryChanges = 0;
  private inventoryRecheck?: Promise<void>;

  constructor(readonly spec: ExperimentSpec, cwd: string, private prompt: string,
    environment: NodeJS.ProcessEnv = process.env) {
    // Recordings are codemux state, not run-directory output: the run
    // directory belongs to the experiment, and a recording landing there is
    // visible to the harness's own tools. A spec may relocate the directory.
    const directory = spec.recording ?? join(codemuxStateDir(environment), "experiments");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.recordingPath = join(directory, `${this.runId}${spec.control ? ".control" : ""}.jsonl`);
    this.fd = openSync(this.recordingPath, "wx", 0o600);
    try {
      this.server = new ExperimentServer(spec, cwd, environment,
        (kind, fields) => this.record(kind, fields), (error) => this.fail(error), () => {
          this.inventoryChanges++;
          this.recheckInventory();
        });
      this.record("run_start", { server: spec.name, cwd, env_names: spec.env,
        server_sandbox: "outside scode; experiment-owned", harness_sandbox: "scode read-only" });
      console.error(`codemux: experiment MCP recording: ${this.recordingPath}`);
    } catch (error) {
      try { closeSync(this.fd); }
      finally { unlinkSync(this.recordingPath); }
      throw error;
    }
  }

  private record(kind: string, fields: JsonObject): void {
    if (this.closed) return;
    const line = JSON.stringify({ run_id: this.runId, seq: this.sequence++, kind, ...fields }) + "\n";
    this.recordedBytes += Buffer.byteLength(line);
    if (this.recordedBytes > MAX_RECORDING_BYTES && kind !== "failure" && kind !== "run_end") throw new Error("experiment MCP recording exceeds 256 MiB");
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
  }

  start(write: (line: string) => void, end: () => void, abort: () => void): void {
    this.write = write;
    this.end = () => { this.end = undefined; end(); };
    this.abort = abort;
    try {
      this.server.start();
      this.send({ type: "control_request", request_id: this.initRequest,
        request: { subtype: "initialize", sdkMcpServers: [this.spec.name] } });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private send(message: JsonObject): void {
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_EXPERIMENT_MESSAGE_BYTES) throw new Error("experiment control frame exceeds 1 MiB");
    this.record("control_stdin", { bytes_base64: Buffer.from(line).toString("base64") });
    this.write!(line);
  }

  push(chunk: string): void {
    try { this.consume(chunk); }
    catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private consume(chunk: string): void {
    if (this.failure) throw this.failure;
    this.trace += chunk;
    this.record("control_stdout", { bytes_base64: Buffer.from(chunk).toString("base64") });
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) + 1 > MAX_EXPERIMENT_MESSAGE_BYTES) throw new Error("experiment control frame exceeds 1 MiB");
      if (line.trim()) this.frame(JSON.parse(line));
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer) >= MAX_EXPERIMENT_MESSAGE_BYTES) throw new Error("experiment control frame exceeds 1 MiB");
  }

  private frame(frame: JsonObject): void {
    if (this.result) throw new Error("Claude sent a frame after its result");
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("invalid experiment control frame");
    if (typeof frame.type !== "string" || !CLAUDE_FRAME_TYPES.has(frame.type)) {
      throw new Error("unknown or invalid experiment control frame type");
    }
    if (frame.type === "control_response") {
      if (frame.response?.request_id !== this.initRequest || this.initialized) throw new Error("unexpected control response");
      if (frame.response.subtype !== "success") throw new Error("Claude refused experiment SDK initialization");
      this.initialized = true;
      this.send({ type: "user", message: { role: "user", content: this.prompt } });
    } else if (frame.type === "control_request") {
      void this.control(frame).catch((error) => this.fail(error));
    } else if (frame.type === "control_cancel_request") {
      this.record("cancellation", { control_id: frame.request_id });
      throw new Error("Claude canceled an experiment control request");
    } else if (frame.type === "system" && frame.subtype === "init") {
      if (!this.initialized || !this.toolDefinitions || this.inventoryValidated ||
        !Array.isArray(frame.tools) || frame.tools.length === 0 || frame.tools.some((name: unknown) =>
        typeof name !== "string")) {
        throw new Error("Claude sent an invalid experiment tool inventory");
      }
      // The exposed set must equal the advertised set: a built-in tool the
      // server never offered is as much a leak as a dropped experiment tool.
      const advertised = [...this.toolNames].sort();
      const exposed = [...new Set<string>(frame.tools)].sort();
      const equal = exposed.length === frame.tools.length && isDeepStrictEqual(exposed, advertised);
      this.record("tool_inventory", { tools: frame.tools, server_tools: advertised, equal, mcp_servers: frame.mcp_servers });
      if (!equal) {
        throw new Error(`Claude's exposed tools must equal the experiment server's advertised set (server: ${advertised.join(", ") || "none"}; claude: ${JSON.stringify(frame.tools)})`);
      }
      this.inventoryValidated = true;
    } else if (frame.type === "assistant" || frame.type === "user") {
      if (!this.inventoryValidated) throw new Error("Claude conversation frame before validated Claude inventory");
      const content = frame.message?.content;
      if (!Array.isArray(content)) throw new Error("Claude message.content must be an array");
      if (frame.message.role !== frame.type) throw new Error("Claude message.role must match the conversation frame type");
      for (const block of content) {
        if (block.type === "tool_use") {
          if (frame.type !== "assistant" || frame.message.role !== "assistant") throw new Error("tool_use must come from the assistant");
          if (typeof block.id !== "string" || this.calls.has(block.id) || !this.toolNames.has(block.name)) {
            throw new Error("Claude called an unknown, duplicate, or built-in tool");
          }
          this.calls.set(block.id, { name: block.name, input: block.input, claimed: false, received: false });
          this.record("tool_call", { tool_use_id: block.id, name: block.name, input: block.input });
        } else if (block.type === "tool_result") {
          if (frame.type !== "user" || frame.message.role !== "user") throw new Error("tool_result must be delivered in a user frame");
          const call = this.calls.get(block.tool_use_id);
          this.record("model_tool_result", { tool_use_id: block.tool_use_id, block });
          if (!call?.result || call.received) throw new Error("unmatched model-bound experiment tool result");
          const equal = modelResultMatches(call.result.content, block.content);
          if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
            throw new Error("Claude tool_result is_error must be a boolean");
          }
          const isErrorEqual = (call.result.isError ?? false) === (block.is_error ?? false);
          this.record("result_comparison", { tool_use_id: block.tool_use_id, equal: equal && isErrorEqual });
          if (!equal || !isErrorEqual) throw new Error("Claude changed the experiment tool result before model delivery");
          call.received = true;
        }
      }
    } else if (frame.type === "result") {
      if (!this.initialized) throw new Error("Claude returned a result before SDK initialization");
      if (!this.inventoryValidated || !this.toolDefinitions || this.activeControls.size) {
        throw new Error("Claude returned a result before experiment inventory and control completion");
      }
      this.result = JSON.stringify(frame);
      if (!this.inventoryRecheck) this.end?.();
    }
    // Other documented notifications remain in control_stdout and the trace.
  }

  private async control(frame: JsonObject): Promise<void> {
    const id = frame.request_id;
    let registered = false;
    try {
      if (typeof id !== "string" || this.activeControls.has(id)) throw new Error("invalid or duplicate Claude control id");
      this.activeControls.add(id);
      registered = true;
      const request = frame.request;
      let response: JsonObject;
      if (request?.subtype === "mcp_message" && request.server_name === this.spec.name) {
        const message = request.message;
        if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error("invalid Claude MCP request");
        let callId: string | undefined;
        if (message.method === "tools/call") {
          if (!this.inventoryValidated) throw new Error("MCP tools/call before validated Claude inventory");
          const name = `mcp__${this.spec.name}__${message.params?.name}`;
          const nativeId = message.params?._meta?.["claudecode/toolUseId"];
          const call = typeof nativeId === "string" ? this.calls.get(nativeId) : undefined;
          if (message.id === undefined || !call || call.claimed || call.name !== name ||
              !isDeepStrictEqual(call.input, message.params?.arguments ?? {})) {
            throw new Error("MCP call lacks a matching native tool_use id");
          }
          callId = nativeId;
          call.claimed = true;
        }
        this.record("mcp_request", { control_id: id, rpc_id: message.id ?? null, tool_use_id: callId ?? null, message });
        const reply = await this.server.request(message);
        if (this.closed || this.failure) return;
        // A control acknowledgment is required even for an MCP notification,
        // but it must not contain a fabricated JSON-RPC response.
        if (reply === undefined) {
          this.send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
          return;
        }
        if (reply.id !== message.id) throw new Error("experiment MCP response id mismatch");
        // Any JSON-RPC error reply, for any method, fails the run: forwarding
        // one as if it were the tool's output would let the server inject a
        // result Claude never produced. Ping and tools/list are included.
        if (reply.error !== undefined) {
          const detail = reply.error && typeof reply.error.message === "string" ? `: ${reply.error.message}` : "";
          throw new Error(`experiment MCP ${message.method} returned a JSON-RPC error${detail}`);
        }
        if (message.method === "tools/list") {
          if (message.params?.cursor !== undefined) throw new Error("experiment tools/list must start at the first page");
          const tools = await this.collectInventory(reply, id);
          if (this.closed || this.failure) return;
          if (this.toolDefinitions && !isDeepStrictEqual(this.toolDefinitions, tools)) throw new Error("experiment tool definitions changed during the run");
          for (const tool of tools) this.toolNames.add(`mcp__${this.spec.name}__${tool.name}`);
          this.toolDefinitions = tools;
          this.recheckInventory();
          reply.result = { ...reply.result, tools };
          delete reply.result.nextCursor;
        }
        if (callId) {
          if (!Array.isArray(reply.result?.content)) throw new Error("experiment tools/call must return an MCP content result");
          if (reply.result.isError !== undefined && typeof reply.result.isError !== "boolean") {
            throw new Error("MCP tools/call isError must be a boolean");
          }
          this.calls.get(callId)!.result = reply.result;
          this.record("server_tool_result", { tool_use_id: callId, rpc_id: message.id, result: reply.result });
        }
        response = { mcp_response: reply };
      } else if (request?.subtype === "can_use_tool") {
        const allowed = this.toolNames.has(request.tool_name);
        response = allowed ? { behavior: "allow", updatedInput: request.input } :
          { behavior: "deny", message: "Only experiment MCP tools are allowed" };
        this.record("permission", { tool: request.tool_name, allowed });
      } else {
        throw new Error(`unsupported Claude control request: ${String(request?.subtype)}`);
      }
      this.send({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    } catch (error) {
      // Latch validation errors before the async function yields, so the
      // rest of this stdout chunk cannot forward another request.
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally { if (registered) this.activeControls.delete(id); }
  }

  private async inventoryPage(controlId: string | null, cursor?: string): Promise<JsonObject> {
    const message = { jsonrpc: "2.0", id: randomUUID(), method: "tools/list",
      ...(cursor === undefined ? {} : { params: { cursor } }) };
    this.record("mcp_request", { control_id: controlId, rpc_id: message.id, tool_use_id: null, message });
    const reply = await this.server.request(message);
    if (this.failure) throw this.failure;
    if (!reply || reply.id !== message.id) throw new Error("experiment MCP response id mismatch");
    if (reply.error !== undefined) throw new Error("experiment MCP tools/list returned a JSON-RPC error");
    return reply;
  }

  private async collectInventory(page: JsonObject, controlId: string | null): Promise<JsonObject[]> {
    const tools: JsonObject[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    for (;;) {
      if (!Array.isArray(page.result?.tools)) throw new Error("experiment server requires one complete nonempty tools/list");
      for (const tool of page.result.tools) {
        if (!tool || typeof tool.name !== "string" || !EXPERIMENT_TOOL_NAME.test(tool.name) || names.has(tool.name) ||
          `mcp__${this.spec.name}__${tool.name}`.length > MAX_NAMESPACED_TOOL_NAME) {
          throw new Error("experiment server exposes an unsupported or duplicate tool name");
        }
        names.add(tool.name);
        tools.push(tool);
      }
      const cursor = page.result.nextCursor;
      if (cursor === undefined) break;
      if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("invalid or repeated experiment tools/list cursor");
      cursors.add(cursor);
      page = await this.inventoryPage(controlId, cursor);
    }
    if (tools.length === 0) throw new Error("experiment server requires one complete nonempty tools/list");
    return tools;
  }

  private recheckInventory(): void {
    // Notifications during the first inventory wait for its validated baseline.
    // Serialize rechecks so a burst cannot exhaust the transport's pending IDs.
    if (!this.toolDefinitions || !this.inventoryChanges || this.inventoryRecheck || this.failure || this.closed) return;
    this.inventoryRecheck = (async () => {
      while (this.inventoryChanges && !this.failure) {
        this.inventoryChanges--;
        const tools = await this.collectInventory(await this.inventoryPage(null), null);
        const equal = isDeepStrictEqual(this.toolDefinitions, tools);
        this.record("tool_inventory_recheck", { equal, previous: this.toolDefinitions, current: tools });
        if (!equal) throw new Error("experiment tool definitions changed during the run");
      }
    })().catch((error) => this.fail(error instanceof Error ? error : new Error(String(error)))).finally(() => {
      this.inventoryRecheck = undefined;
      this.recheckInventory();
      if (this.result && !this.inventoryRecheck && !this.failure && !this.closed) this.end?.();
    });
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    try { this.record("failure", { message: error.message }); }
    catch { console.error(`codemux: experiment recording failed: ${error.message}`); }
    finally { this.abort?.(); }
  }

  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    if (this.failure) throw this.failure;
    if (this.buffer.length) {
      this.record("control_stdout_partial", { bytes_base64: Buffer.from(this.buffer).toString("base64") });
      this.buffer = "";
      if (!options?.timedOut && !options?.aborted) {
        const error = new Error("incomplete Claude control frame");
        this.fail(error);
        throw error;
      }
    }
    if (options?.aborted) {
      this.record("cancellation", { reason: "stdout capture aborted" });
      return this.result;
    }
    if (this.result && [...this.calls.values()].some((call) => !call.received)) {
      const error = new Error("Claude ended without emitting every model-bound tool result");
      this.fail(error);
      throw error;
    }
    return this.result;
  }
  keptBytes(): number { return Buffer.byteLength(this.trace) + Buffer.byteLength(this.result); }
  scanSurface(): string { return this.trace; }
  terminateProtocol(): void { this.server.terminate(); }

  /** Unexpected exit cannot drain readers. Record that loss and close now. */
  closeSync(): void {
    if (this.closed) return;
    try { this.terminateProtocol(); }
    finally { this.closeRecording(this.failure?.message ?? "process exited before asynchronous experiment cleanup completed"); }
  }

  async closeProtocol(): Promise<void> {
    await this.close();
    // The run's single decision point: after every failure source (protocol,
    // comparison, server exit) has had its chance and the run_end record
    // holds the outcome, a recorded failure makes the whole run fail --
    // including one recorded after Claude's own successful finish().
    const failure = this.failure ?? this.closeFailure;
    if (failure) throw failure;
  }

  async close(): Promise<void> {
    // Cache a settled outcome, so launcher and exit cleanup cannot replay a
    // finalization rejection already reported by the protocol owner.
    await (this.closing ??= this.finalize().catch((error) => {
      this.closeFailure = error instanceof Error ? error : new Error(String(error));
    }));
    if (this.closeFailure !== undefined && !this.closeFailureReported) {
      this.closeFailureReported = true;
      throw this.closeFailure;
    }
  }

  private async finalize(): Promise<void> {
    try {
      try {
        // A peer can exit without waiting for stdin to close. Give rechecks a
        // bounded chance to finish before terminating their server.
        if (this.inventoryRecheck && !this.failure) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const settled = async () => { while (this.inventoryRecheck) await this.inventoryRecheck; };
            await Promise.race([settled(), new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                this.fail(new Error("experiment tool inventory recheck did not complete before shutdown"));
                resolve();
              }, PIPE_GIVE_UP_MS);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        }
        await this.server.close();
        await this.inventoryRecheck;
      }
      catch (error) {
        // An operational cleanup error is evidence to retain, not a new
        // protocol abort that can replace the completed child's result.
        this.closeFailure = error instanceof Error ? error : new Error(String(error));
        this.record("failure", { message: this.closeFailure.message });
        throw error;
      }
      if (this.buffer.length) {
        this.record("control_stdout_partial", { bytes_base64: Buffer.from(this.buffer).toString("base64") });
        this.buffer = "";
        this.fail(new Error("incomplete Claude control frame"));
      }
    } finally { this.closeRecording(this.failure?.message ?? this.closeFailure?.message ?? null); }
  }

  private closeRecording(error: string | null): void {
    if (this.closed) return;
    try {
      this.record("run_end", { result_received: Boolean(this.result), tool_calls: this.calls.size,
        model_results: [...this.calls.values()].filter((call) => call.received).length, error });
      fsyncSync(this.fd);
    } finally {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}
