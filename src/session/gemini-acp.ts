/** Native Gemini 0.60.0 ACP transport. Evidence: gemini-LUNNHKPJ.js
 * GeminiAgent.initialize/newSession/loadSession/prompt/cancel and
 * Session.requestPermission (read 2026-11-09). Gemini and Cline session
 * drivers share this transport; no child is started here. */
import type { AutonomyLevel } from "../types.js";
import { geminiSessionAutonomyFlags } from "./gemini-session.js";

export const MAX_GEMINI_ACP_LINE_BYTES = 1024 * 1024;
const GEMINI_ACP_MAX_EARLY_UPDATES = 64;
const GEMINI_ACP_MAX_PENDING_REQUESTS = 32;
type JsonObject = Record<string, unknown>;
type RpcId = string | number;

export interface GeminiAcpPermission {
  sessionId: string;
  toolCall: JsonObject;
  options: { optionId: string; kind: string; name?: string }[];
}

export interface GeminiAcpHost {
  /** The process writer returns false when its input has closed. */
  write(line: string): boolean;
  onUpdate(update: JsonObject, raw: string): void;
  onFailure?(error: Error): void;
  /** The outer driver applies its autonomy ceiling before returning allow. */
  onPermission?(request: GeminiAcpPermission): Promise<"allow" | "deny"> | "allow" | "deny";
  permissionPolicy?: "default" | "deny";
}

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

export function buildGeminiAcpCommand(options: {
  autonomy: AutonomyLevel; model?: string; home?: string; policyPath?: string;
}): string[] {
  const command = options.home === undefined ? ["gemini"] : ["env", `GEMINI_CLI_HOME=${options.home}`, "gemini"];
  command.push("--sandbox=false", "--acp", ...geminiSessionAutonomyFlags(options.autonomy));
  if (options.model !== undefined) command.push("-m", options.model);
  if (options.policyPath !== undefined) command.push("--policy", options.policyPath);
  return command;
}

export class GeminiAcpTransport {
  private nextId = 0;
  private readonly requests = new Map<number, {
    method: string; resolve: (value: JsonObject) => void; reject: (error: Error) => void;
  }>();
  private readonly permissions = new Set<RpcId>();
  private readonly earlyUpdates: { params: JsonObject; raw: string }[] = [];
  private initialized = false;
  private opening = false;
  private busy = false;
  private canceling = false;
  private promptGeneration = 0;
  private failed: Error | null = null;
  private id: string | null = null;

  constructor(private readonly host: GeminiAcpHost) {}

  get sessionId(): string | null { return this.id; }

  async initialize(): Promise<JsonObject> {
    if (this.initialized || this.requests.size > 0) throw new Error("Gemini ACP was already initialized");
    const result = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (result.protocolVersion !== 1) {
      const error = new Error("Gemini ACP returned an unsupported protocol version");
      this.close(error);
      throw error;
    }
    this.initialized = true;
    return result;
  }

  async authenticate(methodId: string, metadata?: JsonObject): Promise<void> {
    this.assertReady(false);
    await this.request("authenticate", { methodId, ...(metadata === undefined ? {} : { _meta: metadata }) });
  }

  async open(options: { cwd: string; resumeId?: string; mcpServers?: JsonObject[] }): Promise<string> {
    this.assertReady(false);
    if (this.id !== null || this.opening) throw new Error("Gemini ACP already owns a session");
    if (options.resumeId !== undefined && !/^[a-zA-Z0-9_-]+$/.test(options.resumeId)) {
      throw new Error("Gemini ACP cannot resume an invalid session identity");
    }
    this.opening = true;
    this.id = options.resumeId ?? null;
    try {
      const result = await this.request(options.resumeId === undefined ? "session/new" : "session/load", {
        cwd: options.cwd, mcpServers: options.mcpServers ?? [],
        ...(options.resumeId === undefined ? {} : { sessionId: options.resumeId }),
      });
      const id = options.resumeId ?? result.sessionId;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        const error = new Error("Gemini ACP returned no valid session identity");
        this.close(error);
        throw error;
      }
      this.id = id;
      this.opening = false;
      try { for (const { params, raw } of this.earlyUpdates.splice(0)) this.update(params, raw); }
      catch (error) { this.close(error as Error); throw error; }
      return id;
    } catch (error) {
      this.opening = false;
      this.id = null;
      this.earlyUpdates.length = 0;
      throw error;
    }
  }

  async prompt(text: string): Promise<JsonObject> {
    this.assertReady(true);
    if (this.busy) throw new Error("Gemini ACP already has an active prompt");
    this.busy = true;
    this.canceling = false;
    this.promptGeneration++;
    try {
      const result = await this.request("session/prompt", {
        sessionId: this.id, prompt: [{ type: "text", text }],
      });
      if (typeof result.stopReason !== "string" || result.stopReason === "") {
        const error = new Error("Gemini ACP prompt returned no stopReason");
        this.close(error);
        throw error;
      }
      return result;
    } finally {
      this.busy = false;
      this.canceling = false;
    }
  }

  cancel(): boolean {
    this.assertReady(true);
    if (!this.busy || this.canceling) return false;
    this.canceling = true;
    try { this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.id } }); }
    catch (error) { this.close(error as Error); throw error; }
    return true;
  }

  handleLine(line: string): void {
    if (this.failed !== null || line.trim() === "") return;
    try {
      if (Buffer.byteLength(line) > MAX_GEMINI_ACP_LINE_BYTES) throw new Error("Gemini ACP output frame exceeds 1 MiB");
      const frame: unknown = JSON.parse(line);
      if (!record(frame) || frame.jsonrpc !== "2.0") throw new Error("Gemini ACP returned an invalid JSON-RPC frame");
      if (typeof frame.method === "string") {
        if (frame.method === "session/update" && frame.id === undefined) {
          if (!record(frame.params)) throw new Error("Gemini ACP update has no parameters");
          this.update(frame.params, line);
        } else if (frame.method === "session/request_permission" && rpcId(frame.id)) {
          void this.permission(frame.id, frame.params);
        } else if (rpcId(frame.id)) {
          this.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Client method is not supported" } });
        }
        return;
      }
      if (typeof frame.id !== "number" || !this.requests.has(frame.id)) throw new Error("Gemini ACP returned an unknown response identity");
      const pending = this.requests.get(frame.id)!;
      this.requests.delete(frame.id);
      if (record(frame.error)) {
        pending.reject(new Error(`Gemini ACP ${pending.method} failed: ${String(frame.error.message ?? "unknown error")}`));
      } else if (record(frame.result)) {
        pending.resolve(frame.result);
      } else {
        const error = new Error(`Gemini ACP ${pending.method} returned no result object`);
        pending.reject(error);
        throw error;
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(error = new Error("Gemini ACP process closed")): void {
    if (this.failed !== null) return;
    this.failed = error;
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    this.permissions.clear();
    this.earlyUpdates.length = 0;
    this.host.onFailure?.(error);
  }

  private assertReady(session: boolean): void {
    if (this.failed !== null) throw this.failed;
    if (!this.initialized) throw new Error("Gemini ACP is not initialized");
    if (session && (this.id === null || this.opening)) throw new Error("Gemini ACP session is not ready");
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.failed !== null) return Promise.reject(this.failed);
    if (this.requests.size >= GEMINI_ACP_MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Gemini ACP has too many pending requests"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { method, resolve, reject });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private send(frame: JsonObject): void {
    if (this.failed !== null) throw this.failed;
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_GEMINI_ACP_LINE_BYTES) throw new Error("Gemini ACP input frame exceeds 1 MiB");
    if (!this.host.write(line)) throw new Error("Gemini ACP input closed before the frame was written");
  }

  private update(params: JsonObject, raw: string): void {
    if (this.opening && this.id === null) {
      if (this.earlyUpdates.length >= GEMINI_ACP_MAX_EARLY_UPDATES) throw new Error("Gemini ACP sent too many updates before its session identity");
      this.earlyUpdates.push({ params, raw });
      return;
    }
    if (this.id === null || params.sessionId !== this.id || !record(params.update)) throw new Error("Gemini ACP update names a foreign session or has no update object");
    this.host.onUpdate(params.update, raw);
  }

  private async permission(id: RpcId, raw: unknown): Promise<void> {
    if (this.permissions.has(id)) { this.close(new Error("Gemini ACP repeated a permission request identity")); return; }
    if (this.permissions.size >= GEMINI_ACP_MAX_PENDING_REQUESTS) { this.close(new Error("Gemini ACP has too many pending permissions")); return; }
    this.permissions.add(id);
    const generation = this.promptGeneration;
    let choice: "allow" | "deny" = "deny";
    let options: GeminiAcpPermission["options"] = [];
    try {
      if (this.id === null || !this.busy || !record(raw) || raw.sessionId !== this.id || !record(raw.toolCall) || !Array.isArray(raw.options) ||
          raw.options.some((option) => !record(option) || typeof option.optionId !== "string" || typeof option.kind !== "string")) {
        throw new Error("Gemini ACP permission request is malformed or names a foreign session");
      }
      options = raw.options as GeminiAcpPermission["options"];
      if (this.host.permissionPolicy !== "deny" && !this.canceling && this.host.onPermission) {
        choice = await this.host.onPermission({ sessionId: this.id!, toolCall: raw.toolCall, options });
      }
    } catch {
      // A caller callback or malformed request never grants permission.
      choice = "deny";
    }
    if (this.failed !== null || !this.permissions.delete(id)) return;
    if (this.canceling || !this.busy || generation !== this.promptGeneration) choice = "deny";
    const selected = options.find((option) => option.kind === (choice === "allow" ? "allow_once" : "reject_once"));
    try {
      this.send({ jsonrpc: "2.0", id, result: {
        outcome: selected === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: selected.optionId }, // allow-british: native ACP enum
      } });
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
