import { COPILOT_SESSION_ID_PATTERN } from "./copilot-session.js";
import { CopilotRpcFramer, encodeCopilotRpc } from "./copilot-rpc-framing.js";
import { parseCopilotUsageMetrics } from "../copilot-usage.js";
import type { AutonomyLevel, ResultUsageBlock } from "../types.js";

const copilotRpcPendingLimit = 64;
const copilotRpcTimeoutMs = 30_000;

function copilotRpcRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Copilot RPC expected an object");
  }
  return value as Record<string, unknown>;
}

interface CopilotRpcPending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CopilotRpcSessionConfig extends Record<string, unknown> {
  model?: string;
  workingDirectory: string;
  availableTools?: string[];
  configDir?: string;
}

/** Native control hook, not an integrated session driver. Installed 1.0.85
 * copilot-sdk/index.js createSession/resumeSession/abort and generated RPC
 * permissions.handlePendingPermissionRequest define these method names
 * and shapes (read 2026-11-09). It never starts a process or sends a model
 * request until its caller explicitly invokes open/send. */
export class CopilotRpcControl {
  private readonly framer = new CopilotRpcFramer();
  private readonly pending = new Map<number, CopilotRpcPending>();
  private nextId = 1;
  private stopped: Error | null = null;

  constructor(private readonly options: {
    sessionId: string;
    write(bytes: Uint8Array): void;
    onEvent(event: Record<string, unknown>): void;
    onFailure(error: Error): void;
    denyPermissions: boolean;
    timeoutMs?: number;
    clientMethods?: Readonly<Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>>;
  }) {
    if (!COPILOT_SESSION_ID_PATTERN.test(options.sessionId)) throw new Error("invalid Copilot RPC session id");
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("Copilot RPC timeout must be a positive integer");
    }
  }

  async open(resume: boolean, config: CopilotRpcSessionConfig): Promise<void> {
    const response = copilotRpcRecord(await this.request(resume ? "session.resume" : "session.create", {
      ...config, requestPermission: this.options.denyPermissions, streaming: false,
      sessionId: this.options.sessionId,
    }));
    if (response.sessionId !== this.options.sessionId) {
      const error = new Error("Copilot RPC returned a different session id");
      this.fail(error);
      throw error;
    }
    if (this.options.denyPermissions) {
      const configured = copilotRpcRecord(await this.request("session.permissions.configure", {
        sessionId: this.options.sessionId, approveAllToolPermissionRequests: false,
        approveAllReadPermissionRequests: false,
      }));
      if (configured.success !== true) {
        const error = new Error("Copilot RPC did not disable automatic permission grants");
        this.fail(error);
        throw error;
      }
    }
  }

  send(prompt: string): Promise<unknown> {
    return this.request("session.send", { sessionId: this.options.sessionId, prompt });
  }

  abort(): Promise<unknown> {
    return this.request("session.abort", { sessionId: this.options.sessionId });
  }

  async configureAutonomy(autonomy: AutonomyLevel): Promise<void> {
    const grant = !this.options.denyPermissions;
    const response = copilotRpcRecord(await this.request("session.permissions.configure", {
      sessionId: this.options.sessionId,
      approveAllToolPermissionRequests: grant && (autonomy === "medium" || autonomy === "high"),
      approveAllReadPermissionRequests: grant && (autonomy === "low" || autonomy === "high"),
      paths: { unrestricted: grant && autonomy === "high", additionalDirectories: [], includeTempDirectory: !this.options.denyPermissions },
      urls: { unrestricted: grant && autonomy === "high", initialAllowed: [] },
    }));
    if (response.success !== true) throw new Error("Copilot RPC could not apply autonomy");
    if (autonomy === "read-only") {
      const mode = copilotRpcRecord(await this.request("session.mode.set", { sessionId: this.options.sessionId, mode: "plan" }));
      if (typeof mode.status !== "string" || mode.modeApplied === false) throw new Error("Copilot RPC could not apply plan mode");
    }
  }

  async detach(): Promise<void> {
    const result = copilotRpcRecord(await this.request("session.detach", { sessionId: this.options.sessionId }));
    if (result.success !== true) throw new Error("Copilot RPC could not persist and detach the session");
  }

  async usage(): Promise<ResultUsageBlock> {
    return parseCopilotUsageMetrics(await this.request("session.usage.getMetrics", { sessionId: this.options.sessionId }));
  }

  receive(bytes: Uint8Array): void {
    if (this.stopped !== null) return;
    try {
      for (const value of this.framer.push(bytes)) {
        if (this.stopped !== null) break;
        this.dispatch(copilotRpcRecord(value));
      }
    }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  end(): void {
    try { this.framer.end(); }
    catch (error) { this.fail(error as Error); return; }
    this.close(new Error("Copilot RPC transport closed"));
  }

  close(error = new Error("Copilot RPC transport closed")): void {
    if (this.stopped !== null) return;
    this.stopped = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error): void {
    if (this.stopped !== null) return;
    this.close(error);
    this.options.onFailure(error);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopped !== null) return Promise.reject(this.stopped);
    if (this.pending.size >= copilotRpcPendingLimit) return Promise.reject(new Error("too many pending Copilot RPC requests"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Copilot RPC ${method} timed out`)),
        this.options.timeoutMs ?? copilotRpcTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.options.write(encodeCopilotRpc({ jsonrpc: "2.0", id, method, params })); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message.jsonrpc !== "2.0") throw new Error("invalid Copilot RPC version");
    if (typeof message.method === "string") {
      // Optional server-to-client methods cannot receive an accidental grant.
      if (message.id !== undefined) {
        const handler = this.options.clientMethods?.[message.method];
        if (handler !== undefined) {
          if (typeof message.id !== "string" && typeof message.id !== "number") throw new Error("invalid Copilot client request id");
          const params = copilotRpcRecord(message.params);
          void Promise.resolve().then(() => handler(params)).then((result) => {
            if (this.stopped === null) this.options.write(encodeCopilotRpc({ jsonrpc: "2.0", id: message.id, result }));
          }).catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        this.options.write(encodeCopilotRpc({ jsonrpc: "2.0", id: message.id,
          error: { code: -32601, message: "codemux does not implement this client method" } }));
        return;
      }
      if (message.method !== "session.event") return;
      const params = copilotRpcRecord(message.params);
      if (params.sessionId !== this.options.sessionId) throw new Error("Copilot RPC event names a different session");
      const event = copilotRpcRecord(params.event);
      if (typeof event.type !== "string") throw new Error("Copilot RPC event has no type");
      if (event.type === "permission.requested" && this.options.denyPermissions) {
        const data = copilotRpcRecord(event.data);
        if (data.resolvedByHook !== true) {
          if (typeof data.requestId !== "string" || data.requestId === "") throw new Error("Copilot permission event has no request id");
          void this.request("session.permissions.handlePendingPermissionRequest", {
            sessionId: this.options.sessionId, requestId: data.requestId, result: { kind: "reject" },
          }).catch((error: Error) => this.fail(error));
        }
      }
      this.options.onEvent(event);
      return;
    }
    if (typeof message.id !== "number" || !this.pending.has(message.id)) throw new Error("unexpected Copilot RPC response id");
    const responseError = message.error === undefined ? null : copilotRpcRecord(message.error);
    const pending = this.pending.get(message.id)!;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (responseError !== null) {
      pending.reject(new Error(`Copilot RPC error: ${String(responseError.message)}`));
    } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(new Error("Copilot RPC response has neither result nor error"));
  }
}
