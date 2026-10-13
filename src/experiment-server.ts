import { createTerminationTarget, type TerminationTarget } from "./process-tree.js";
import { FORCE_KILL_DELAY_MS, PIPE_GIVE_UP_MS, signalProcess } from "./process-runner.js";
import type { ExperimentSpec } from "./experiment-mcp.js";
import { resolveTrustedExecutable } from "./executable-security.js";

export type JsonObject = Record<string, any>;
export type ExperimentRecord = (kind: string, fields: JsonObject) => void;
export const MAX_EXPERIMENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;

/** A single experiment-owned stdio process, outside the harness sandbox.
 * No shell, ambient environment, sampling, or elicitation is supplied.
 */
export class ExperimentServer {
  private proc?: ReturnType<typeof Bun.spawn>;
  private target?: TerminationTarget;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readers: Promise<void>[] = [];
  private closing?: Promise<void>;
  private drainDeadline = 0;
  private abandoned = false;
  private giveUp!: () => void;
  private readonly pipeGiveUp = new Promise<void>((resolve) => { this.giveUp = resolve; });
  private onExit = (): void => this.terminate();
  private pending = new Map<string, { resolve: (reply: JsonObject) => void; reject: (error: Error) => void }>();

  constructor(private spec: ExperimentSpec, private cwd: string,
    private environment: NodeJS.ProcessEnv, private record: ExperimentRecord,
    private fail: (error: Error) => void) {}

  start(): void {
    const env: Record<string, string> = {};
    for (const name of this.spec.env) {
      const value = this.environment[name];
      if (value === undefined) throw new Error(`experiment MCP environment variable ${name} is unset`);
      env[name] = value;
    }
    const command = resolveTrustedExecutable(this.spec.command, "experiment MCP server", this.cwd);
    const proc = Bun.spawn([command, ...this.spec.args], {
      cwd: this.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    this.proc = proc;
    this.target = createTerminationTarget(proc, true);
    process.once("exit", this.onExit);
    this.readers = [this.read(proc.stdout as ReadableStream<Uint8Array>, "server_stdout"),
      this.read(proc.stderr as ReadableStream<Uint8Array>, "server_stderr")];
    this.record("server_spawn", { pid: proc.pid });
    void proc.exited.then((code) => {
      if (!this.closed) this.fail(new Error(`experiment MCP server exited unexpectedly (${code})`));
    });
  }

  request(message: JsonObject): Promise<JsonObject | undefined> {
    if (!this.proc || this.closed) return Promise.reject(new Error("experiment MCP server is closed"));
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_EXPERIMENT_MESSAGE_BYTES) throw new Error("experiment MCP request exceeds 1 MiB");
    const id = message.id;
    let key: string | undefined;
    if (id !== undefined) {
      key = this.key(id);
      if (this.pending.has(key) || this.pending.size >= MAX_PENDING_REQUESTS) {
        throw new Error("experiment MCP duplicate id or too many outstanding requests");
      }
    }
    this.record("server_stdin", { bytes_base64: Buffer.from(line).toString("base64"), rpc_id: id ?? null });
    (this.proc.stdin as Bun.FileSink).write(line);
    // No await occurs before registration, so a response cannot overtake it.
    return key === undefined ? Promise.resolve(undefined) :
      new Promise((resolve, reject) => this.pending.set(key!, { resolve, reject }));
  }

  private key(id: unknown): string {
    if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) {
      throw new Error("experiment MCP id must be a string or safe integer");
    }
    return JSON.stringify(id);
  }

  private async read(stream: ReadableStream<Uint8Array>, kind: string): Promise<void> {
    const reader = stream.getReader();
    // One reaction per reader. Per-read races retain every consumed chunk.
    void this.pipeGiveUp.then(() => { void reader.cancel().catch(() => {}); });
    try {
      while (!this.abandoned) {
        const next = await reader.read();
        if (next.done || this.abandoned) break;
        const bytes = next.value;
        this.record(kind, { bytes_base64: Buffer.from(bytes).toString("base64") });
        if (kind !== "server_stdout") continue;
        this.buffer = Buffer.concat([this.buffer, bytes]);
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) !== -1) {
          if (newline + 1 > MAX_EXPERIMENT_MESSAGE_BYTES) throw new Error("experiment MCP response exceeds 1 MiB");
          const line = this.buffer.subarray(0, newline);
          this.buffer = this.buffer.subarray(newline + 1);
          if (line.length === 0) continue;
          const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
          if (!message || message.jsonrpc !== "2.0") throw new Error("invalid experiment MCP JSON-RPC response");
          // The experiment is a tool server, not an additional model client.
          if (message.method !== undefined) throw new Error("experiment MCP server-initiated requests and notifications are unsupported");
          const key = this.key(message.id);
          const pending = this.pending.get(key);
          if (!pending || ("result" in message) === ("error" in message)) throw new Error("unexpected experiment MCP response");
          this.pending.delete(key);
          pending.resolve(message);
        }
        if (this.buffer.length >= MAX_EXPERIMENT_MESSAGE_BYTES) throw new Error("experiment MCP response exceeds 1 MiB");
      }
      if (!this.closed && kind === "server_stdout") throw new Error("experiment MCP stdout closed before run completion");
    } catch (error) {
      if (!this.abandoned) this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Cancellation itself need not settle if a descendant retains the pipe.
      void reader.cancel().catch(() => {});
    }
  }

  validatePartial(): void {
    if (this.buffer.length === 0) return;
    const bytes = this.buffer;
    this.buffer = Buffer.alloc(0);
    try { this.record("server_stdout_partial", { bytes_base64: bytes.toString("base64") }); }
    finally { this.fail(new Error("incomplete experiment MCP server stdout frame")); }
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.drainDeadline = performance.now() + FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS;
    // Kill the tree even after the leader exits: background commands belong
    // to this run. The runner's documented orphan-before-snapshot limit applies.
    if (this.target) signalProcess(this.target, "SIGKILL", "tree");
  }

  close(): Promise<void> {
    return this.closing ??= this.drain();
  }

  private async drain(): Promise<void> {
    this.terminate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = Promise.allSettled(this.readers);
    try {
      const complete = await Promise.race([
        drained.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, this.drainDeadline - performance.now()));
        }),
      ]);
      if (!complete) {
        this.abandoned = true;
        this.giveUp();
        await drained;
        this.fail(new Error("experiment MCP server kept output pipes open after termination; readers abandoned"));
      }
    } finally { if (timer) clearTimeout(timer); }
    process.off("exit", this.onExit);
    this.validatePartial();
    for (const pending of this.pending.values()) pending.reject(new Error("experiment MCP run ended"));
    this.pending.clear();
  }
}
