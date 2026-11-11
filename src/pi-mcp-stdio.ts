import type { spawn as nodeSpawn } from "node:child_process";
import type { PiMcpTransport } from "./pi-mcp-extension.js";

/** Runs inside Pi's sandbox as extension code. The launcher has already
 * resolved and trust-checked command. No shell or remote install is used. */
export function createPiMcpStdioTransport(
  command: string,
  args: string[],
  spawn: typeof nodeSpawn
): PiMcpTransport {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], shell: false });
  if (child.stdin === null || child.stdout === null) throw new Error("pi MCP server has no stdio pipes");
  const input = child.stdin;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>();
  // Canceled calls normally receive no reply. Retain only the most recent
  // IDs for late replies, independently of active request capacity.
  const canceled = new Set<number>();
  let nextId = 0, buffered = "", closed = false;
  let closing: Promise<void> | undefined;
  let processClosed = false;
  const maxBytes = 1024 * 1024;
  const maxPendingRequests = 256;
  const maxCanceledRequests = 256;
  const close = (): Promise<void> => closing ??= new Promise((resolve) => {
    if (processClosed) { resolve(); return; }
    closed = true;
    for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(new Error("pi MCP transport closed")); }
    pending.clear();
    canceled.clear();
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    input.end();
    child.kill("SIGTERM");
  });
  const reject = (error: Error) => {
    closed = true;
    for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(error); }
    pending.clear();
    canceled.clear();
    void close();
  };
  child.once("close", () => { processClosed = true; });
  child.on("error", reject);
  input.on("error", reject);
  child.stdout.on("error", reject);
  child.on("exit", () => {
    reject(new Error("pi MCP server exited"));
    // Once the server exits, inherited pipes held by helpers cannot carry
    // another response. Release them so child close can finish cleanup.
    input.destroy();
    child.stdout!.destroy();
  });
  child.stdout.on("data", (data: Buffer) => {
    if (closed) return;
    try {
      buffered += decoder.decode(data, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > maxBytes) throw new Error("pi MCP response exceeds 1 MiB");
        if (!line.trim()) continue;
        const reply = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown };
        if (reply?.jsonrpc === "2.0" && typeof reply.method === "string" &&
            !("result" in reply) && !("error" in reply)) {
          if (reply.id === undefined) continue; // Server notifications need no reply.
          if (typeof reply.id === "string" || typeof reply.id === "number") {
            // This client advertises no server-request capabilities.
            void write({ jsonrpc: "2.0", id: reply.id,
              error: { code: -32601, message: "Method not found" } }).catch(reject);
            continue;
          }
        }
        if (reply === null || typeof reply !== "object" || reply.jsonrpc !== "2.0" ||
            typeof reply.id !== "number" || (!pending.has(reply.id) && !canceled.has(reply.id)) || reply.method !== undefined ||
            ("result" in reply) === ("error" in reply)) throw new Error("pi MCP invalid server response");
        if (canceled.delete(reply.id)) continue;
        const waiter = pending.get(reply.id)!;
        pending.delete(reply.id);
        waiter.cleanup();
        if (reply.error !== undefined) waiter.reject(new Error(`pi MCP server error: ${String(reply.error?.message)}`));
        else waiter.resolve(reply.result);
      }
      if (Buffer.byteLength(buffered) > maxBytes) throw new Error("pi MCP response exceeds 1 MiB");
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
  });
  const write = (message: Record<string, unknown>): Promise<void> => new Promise((resolve, fail) => {
    const body = JSON.stringify(message);
    if (closed) { fail(new Error("pi MCP transport is closed")); return; }
    if (Buffer.byteLength(body) > maxBytes) { fail(new Error("pi MCP request exceeds 1 MiB")); return; }
    input.write(`${body}\n`, (error) => {
      if (error) { reject(error); fail(error); }
      else resolve();
    });
  });
  return {
    request(method, params, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (pending.size >= maxPendingRequests) return Promise.reject(new Error("pi MCP too many pending requests"));
      const id = ++nextId;
      return new Promise((resolve, fail) => {
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
          if (!pending.delete(id)) return;
          cleanup();
          canceled.add(id);
          if (canceled.size > maxCanceledRequests) canceled.delete(canceled.values().next().value!);
          fail(signal?.reason);
          void write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }).catch(reject); // allow-british: native MCP method
        };
        pending.set(id, { resolve, reject: fail, cleanup });
        signal?.addEventListener("abort", abort, { once: true });
        void write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
          .catch((error) => { pending.delete(id); cleanup(); fail(error); });
      });
    },
    notify: (method) => write({ jsonrpc: "2.0", method }),
    close,
  };
}
