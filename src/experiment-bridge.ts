import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PIPE_GIVE_UP_MS, type StdoutSink } from "./process-runner.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { ExperimentServer, MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "./experiment-server.js";
import { canonicalWorkingDirectory, compareSpill } from "./experiment-spill.js";
import type { ClaudeChildProject } from "./adapters/claude.js";
import { ExperimentFailure, ExperimentFailureCode, experimentFailure, ExperimentRecording, toolResultDeliveredRecord, turnCallRecord, type ExperimentRecord } from "./experiment-records.js";
import { ExperimentInventory } from "./experiment-inventory.js";
import { ClaudeExperimentUsage } from "./experiment-claude-usage.js";

// SDKMessage discriminants and the SDK control transport envelopes.
// https://code.claude.com/docs/en/agent-sdk/typescript#sdkmessage
const CLAUDE_FRAME_TYPES = new Set([
  "assistant", "user", "result", "system", "stream_event", "tool_progress",
  "auth_status", "tool_use_summary", "rate_limit_event", "prompt_suggestion",
  "conversation_reset", "control_request", "control_response", "control_cancel_request", "keep_alive",
]);

/** Prompt preflight and bridge frames use the same byte bound. */
export { MAX_EXPERIMENT_MESSAGE_BYTES };

/** Measure the serialized user frame, including its envelope and newline. */
export function experimentUserFrameBytes(prompt: string): number {
  return Buffer.byteLength(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
}

/** Claude's SDK control transport. Raw stdio and the harness's emitted
 * model-bound tool_result blocks are different evidence and remain separate.
 */
// Claude Code 2.1.300 delivers a server result whose content is one text
// block as that block's text, a plain string, with trailing whitespace removed
// (seen on an `isError` Playwright result: "...\n" arrived without the newline).
// That canonical form is accepted in either error state. The only other
// accepted difference is an oversize-result spill verified by compareSpill;
// anything else (another block type, more than one block, a changed
// character, leading whitespace) still fails the run.
// Claude Code 2.1.300 rebuilds each MCP content block before delivery (its
// `ho()`): a text block as {type, text} plus a truthy _meta, with annotations
// dropped; an image block whose media type it inlines (PNG, JPEG, GIF, WebP;
// "image/jpg" read as JPEG) as the API's base64 image source with the same
// bytes, as long as the image is within its size and dimension budgets (a
// larger one is resized, and its changed bytes fail the run). Other blocks
// (audio, resource, resource_link) become Claude's own text and are not
// reproduced here, so they fail the run too.
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function claudeContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const { type, text, data, mimeType, _meta } = block as JsonObject;
    if (type === "text" && typeof text === "string") return { type: "text", text, ...(_meta ? { _meta } : {}) };
    if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
      const media = mimeType.split(";")[0]!.trim().toLowerCase();
      const mediaType = media === "image/jpg" ? "image/jpeg" : media;
      if (INLINE_IMAGE_TYPES.has(mediaType)) return { type: "image", source: { type: "base64", media_type: mediaType, data } };
    }
    return block;
  });
}

export function modelResultMatches(expected: unknown, actual: unknown): boolean {
  const canonical = claudeContentBlocks(expected);
  if (isDeepStrictEqual(canonical, actual)) return true;
  if (!Array.isArray(canonical) || canonical.length !== 1) return false;
  const block = canonical[0];
  if (!block || typeof block !== "object" || (block as JsonObject).type !== "text") return false;
  const text = (block as JsonObject).text;
  // Claude removes trailing whitespace; it never adds any, so only the
  // removed form is accepted, never an actual with whitespace the server did not send.
  return typeof text === "string" && typeof actual === "string" && (actual === text || actual === text.trimEnd());
}

export class ExperimentBridge implements StdoutSink {
  private recording: ExperimentRecording;
  get runId(): string { return this.recording.runId; }
  get recordingPath(): string { return this.recording.recordingPath; }
  private canonicalCwd: string;
  private buffer = "";
  private result = "";
  private trace = "";
  private server: ExperimentServer;
  private write?: (line: string) => void;
  private end?: () => void;
  private abort?: () => void;
  private failure?: ExperimentFailure;
  get failureError(): ExperimentFailure | null { return this.failure ?? this.closeFailure ?? null; }
  get failureCode(): ExperimentFailureCode | null { return this.failure?.code ?? this.closeFailure?.code ?? null; }
  private closed = false;
  private closing?: Promise<void>;
  private closeFailure?: ExperimentFailure;
  private closeFailureReported = false;
  private initialized = false;
  private inventoryValidated = false;
  private initRequest = randomUUID();
  private calls = new Map<string, { name: string; input: unknown; claimed: boolean; result?: JsonObject; received: boolean }>();
  private activeControls = new Set<string>();
  private inventory: ExperimentInventory;
  private get toolNames(): Set<string> { return this.inventory.names; }
  private get toolDefinitions(): JsonObject[] | undefined { return this.inventory.definitions; }
  private get inventoryRecheck(): Promise<void> | undefined { return this.inventory.rechecking; }
  private usage: ClaudeExperimentUsage;
  private get turn() { return this.usage.turn; }

  // `claudeProject` is where the CHILD Claude keeps this project's files:
  // the adapter resolves it (claudeChildProject), because CLAUDE_CONFIG_DIR
  // and CLAUDE_CODE_PROJECT_DIR_NAME reach the child only when passed
  // through while HOME always does. The default covers callers without an
  // adapter.
  constructor(readonly spec: ExperimentSpec, private readonly cwd: string, private prompt: string,
    environment: NodeJS.ProcessEnv = process.env,
    private claudeProject: ClaudeChildProject = { configDir: environment.HOME ? join(environment.HOME, ".claude") : undefined }) {
    // Keep recordings outside the harness's run directory. start() replaces
    // this cwd with the runner's resolved child directory.
    this.canonicalCwd = canonicalWorkingDirectory(cwd);
    this.recording = new ExperimentRecording(spec, cwd, environment);
    this.usage = new ClaudeExperimentUsage(this.record);
    try {
      this.server = new ExperimentServer(spec, cwd, environment,
        this.record, (error) => this.fail(error), () => this.inventory.changed());
      this.inventory = new ExperimentInventory(spec.name, (message) => this.server.request(message),
        this.record, (error) => this.fail(error), () => !this.failure && !this.closed, () => {
          if (this.result && !this.inventoryRecheck && !this.failure && !this.closed) this.end?.();
        });
    } catch (error) {
      this.recording.discard();
      throw error;
    }
  }

  private readonly record: ExperimentRecord = (kind, fields) => this.recording.record(kind, fields);

  start(write: (line: string) => void, end: () => void, abort: () => void, cwd?: string): void {
    // Use the child's resolved directory even if a cwd symlink changes later.
    this.canonicalCwd = canonicalWorkingDirectory(cwd ?? this.cwd);
    this.write = write;
    this.end = () => { this.end = undefined; end(); };
    this.abort = abort;
    try {
      this.server.start();
      this.send({ type: "control_request", request_id: this.initRequest,
        request: { subtype: "initialize", sdkMcpServers: [this.spec.name] } });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  /** The tool's own result cap, when its definition carries Claude's `anthropic/maxResultSizeChars`. */
  private resultCap(toolName: string): number {
    const tool = (this.toolDefinitions ?? []).find((definition) => (definition as JsonObject).name === toolName) as JsonObject | undefined;
    const meta = tool?._meta as JsonObject | undefined;
    const cap = meta?.["anthropic/maxResultSizeChars"];
    return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
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
        throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "Claude sent an invalid experiment tool inventory");
      }
      // The exposed set must equal the advertised set: a built-in tool the
      // server never offered is as much a leak as a dropped experiment tool.
      const advertised = [...this.toolNames].sort();
      const exposed = [...new Set<string>(frame.tools)].sort();
      const equal = exposed.length === frame.tools.length && isDeepStrictEqual(exposed, advertised);
      this.record("tool_inventory", { tools: frame.tools, server_tools: advertised, equal, mcp_servers: frame.mcp_servers });
      if (!equal) {
        throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, `Claude's exposed tools must equal the experiment server's advertised set (server: ${advertised.join(", ") || "none"}; claude: ${JSON.stringify(frame.tools)})`);
      }
      this.inventoryValidated = true;
    } else if (frame.type === "assistant" || frame.type === "user") {
      if (!this.inventoryValidated) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "Claude conversation frame before validated Claude inventory");
      const content = frame.message?.content;
      if (!Array.isArray(content)) throw new Error("Claude message.content must be an array");
      if (frame.message.role !== frame.type) throw new Error("Claude message.role must match the conversation frame type");
      const receivedAt = Date.now() / 1000;
      const firstFrame = frame.type === "assistant" && this.usage.begin(frame.message, receivedAt);
      const newCalls: { id: string; name: string; input: unknown }[] = [];
      const frameCallIds = new Set<string>();
      for (const block of content) {
        if (block.type === "tool_use") {
          if (frame.type !== "assistant" || frame.message.role !== "assistant") throw new Error("tool_use must come from the assistant");
          if (frameCallIds.has(block.id)) throw new ExperimentFailure(ExperimentFailureCode.Protocol, "Claude repeated a tool ID within one frame");
          frameCallIds.add(block.id);
          const previous = this.calls.get(block.id);
          const turn = this.turn;
          if (previous && turn && turn.message_id === frame.message.id &&
              turn.tool_calls.some((call) => call.call_id === block.id) &&
              previous.name === block.name && isDeepStrictEqual(previous.input, block.input)) continue;
          if (typeof block.id !== "string" || previous) {
            throw new ExperimentFailure(ExperimentFailureCode.Protocol, "Claude emitted an invalid or reused tool ID");
          }
          if (!this.toolNames.has(block.name)) {
            throw new ExperimentFailure(ExperimentFailureCode.UnknownTool, "Claude called an unknown or built-in tool");
          }
          this.calls.set(block.id, { name: block.name, input: block.input, claimed: false, received: false });
          newCalls.push(block);
          this.turn?.tool_calls.push({ call_id: block.id, name: block.name.slice(`mcp__${this.spec.name}__`.length) });
        } else if (block.type === "tool_result") {
          if (frame.type !== "user" || frame.message.role !== "user") throw new Error("tool_result must be delivered in a user frame");
          const call = this.calls.get(block.tool_use_id);
          this.record("model_tool_result", { tool_use_id: block.tool_use_id, block });
          if (!call?.result || call.received) throw new Error("unmatched model-bound experiment tool result");
          this.record("tool_result_delivered", toolResultDeliveredRecord(block.tool_use_id, receivedAt));
          if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
            throw new Error("Claude tool_result is_error must be a boolean");
          }
          const isErrorEqual = (call.result.isError ?? false) === (block.is_error ?? false);
          const plainMatch = modelResultMatches(call.result.content, block.content);
          const toolName = call.name.slice(`mcp__${this.spec.name}__`.length);
          let comparison = plainMatch ? { equal: isErrorEqual } : compareSpill(call.result.content, block.content,
            this.canonicalCwd, this.claudeProject, this.spec.name, toolName, block.tool_use_id, this.resultCap(toolName));
          if (!plainMatch && comparison.equal && !isErrorEqual) {
            const spill_kind = "spill_kind" in comparison ? comparison.spill_kind : undefined;
            comparison = { equal: false, spilled: false, spill_kind, spill_rejected: "error flag" };
          }
          this.record("result_comparison", { tool_use_id: block.tool_use_id, ...comparison });
          if (!comparison.equal) throw new ExperimentFailure(ExperimentFailureCode.ResultChanged, "Claude changed the experiment tool result before model delivery");
          call.received = true;
        }
      }
      if (firstFrame && this.turn) {
        this.record("turn", this.turn);
      }
      for (const call of newCalls) {
        this.record("tool_call", { tool_use_id: call.id, name: call.name, input: call.input });
        if (this.turn) this.record("turn_call", turnCallRecord(this.turn.message_id, call.id,
          call.name.slice(`mcp__${this.spec.name}__`.length), receivedAt));
      }
    } else if (frame.type === "stream_event") {
      this.usage.stream(frame.event, Date.now() / 1000);
    } else if (frame.type === "result") {
      if (!this.initialized) throw new Error("Claude returned a result before SDK initialization");
      if (!this.inventoryValidated || !this.toolDefinitions || this.activeControls.size) {
        throw new Error("Claude returned a result before experiment inventory and control completion");
      }
      this.usage.complete();
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
          if (!this.inventoryValidated) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "MCP tools/call before validated Claude inventory");
          const input = message.params?.arguments === undefined ? {} : message.params.arguments;
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new ExperimentFailure(ExperimentFailureCode.Protocol, "experiment MCP tool arguments must be an object");
          }
          const name = `mcp__${this.spec.name}__${message.params?.name}`;
          const nativeId = message.params?._meta?.["claudecode/toolUseId"];
          const call = typeof nativeId === "string" ? this.calls.get(nativeId) : undefined;
          if (message.id === undefined || !call || call.claimed || call.name !== name ||
              !isDeepStrictEqual(call.input, input)) {
            throw new ExperimentFailure(ExperimentFailureCode.CallIdUnresolved, "MCP call lacks a matching native tool_use id");
          }
          callId = nativeId;
          call.claimed = true;
          message.params.arguments = input;
          message.params._meta = { ...message.params._meta, "codemux/callId": callId };
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
          throw new ExperimentFailure(ExperimentFailureCode.ServerError, `experiment MCP ${message.method} returned a JSON-RPC error${detail}`);
        }
        if (message.method === "tools/list") {
          if (message.params?.cursor !== undefined) throw new Error("experiment tools/list must start at the first page");
          await this.inventory.accept(reply, id);
          if (this.closed || this.failure) return;
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

  fail(cause: unknown): void {
    if (this.failure || this.closed) return;
    const error = this.failure = experimentFailure(cause);
    try { this.record("failure", { code: error.code, message: error.message }); }
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
    if (!this.result && !options?.timedOut) {
      const error = new ExperimentFailure(ExperimentFailureCode.Protocol, "Claude returned no experiment result envelope");
      this.fail(error);
      throw error;
    }
    if (this.result && [...this.calls.values()].some((call) => !call.received)) {
      const error = new Error("Claude ended without emitting every model-bound tool result");
      this.fail(error);
      throw error;
    }
    if (!options?.timedOut) {
      try { this.usage.verify(); }
      catch (error) { this.fail(experimentFailure(error)); throw error; }
    }
    return this.result;
  }
  keptBytes(): number { return Buffer.byteLength(this.trace) + Buffer.byteLength(this.result); }
  scanSurface(): string { return this.trace; }
  terminateProtocol(): void { this.server.terminate(); }

  closeSync(): void {
    if (this.closed) return;
    this.fail(new ExperimentFailure(ExperimentFailureCode.Protocol, "process exited before asynchronous experiment cleanup completed"));
    try { this.terminateProtocol(); }
    finally { this.closeRecording(this.failure!.message); }
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
      this.closeFailure = experimentFailure(error);
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
                this.fail(new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment tool inventory recheck did not complete before shutdown"));
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
        this.closeFailure = experimentFailure(error);
        this.record("failure", { code: this.closeFailure.code, message: this.closeFailure.message });
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
      this.recording.close({ result_received: Boolean(this.result), tool_calls: this.calls.size,
        model_results: [...this.calls.values()].filter((call) => call.received).length, error,
        code: error ? this.failureCode ?? ExperimentFailureCode.Protocol : null });
    } finally {
      this.closed = true;
    }
  }
}
