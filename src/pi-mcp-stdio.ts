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
  // A canceled server call can still return once. Bound these IDs together
  // with pending requests so an uncooperative server cannot grow the set.
  const canceled = new Set<number>();
  let nextId = 0, buffered = "", closed = false;
  let closing: Promise<void> | undefined;
  const maxBytes = 1024 * 1024;
  const maxPendingRequests = 256;
  const reject = (error: Error) => {
    closed = true;
    for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(error); }
    pending.clear();
    canceled.clear();
    child.kill("SIGTERM");
  };
  child.on("error", reject);
  child.on("exit", () => reject(new Error("pi MCP server exited")));
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
      if (pending.size + canceled.size >= maxPendingRequests) return Promise.reject(new Error("pi MCP too many pending requests"));
      const id = ++nextId;
      return new Promise((resolve, fail) => {
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
          if (!pending.delete(id)) return;
          cleanup();
          canceled.add(id);
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
    close() {
      return closing ??= new Promise((resolve) => {
        if (closed) { resolve(); return; }
        closed = true;
        for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(new Error("pi MCP transport closed")); }
        pending.clear();
        canceled.clear();
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
        input.end();
        child.kill("SIGTERM");
      });
    },
  };
}
