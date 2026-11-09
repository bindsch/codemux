import type { PiMcpTransport } from "./pi-mcp-extension.js";

/** Self-contained for embedding in the native extension. Each request has
 * its own authenticated HTTP exchange; long tool calls accept relay SSE. */
export function createPiMcpHttpTransport(
  url: string, token: string, fetcher: typeof fetch = fetch
): PiMcpTransport {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp" ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token) {
    throw new Error("pi experiment requires an authenticated loopback MCP endpoint");
  }
  const maximum = 1024 * 1024;
  const maximumPendingExchanges = 64;
  const pending = new Set<AbortController>();
  let nextId = 0, closed = false;
  const exchange = async (method: string, params: Record<string, unknown> | undefined, notification: boolean, signal?: AbortSignal) => {
    if (closed) throw new Error("pi experiment HTTP transport is closed");
    signal?.throwIfAborted();
    if (pending.size >= maximumPendingExchanges) throw new Error("pi experiment HTTP transport exceeds 64 pending exchanges");
    const id = ++nextId;
    const body = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) });
    if (Buffer.byteLength(body) > maximum) throw new Error("pi experiment MCP request exceeds 1 MiB");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    let reader: { cancel(): Promise<void> } | undefined;
    try {
      const response = await fetcher(url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body });
      if (notification) {
        if (response.status !== 202) throw new Error(`pi MCP notification HTTP ${response.status}`);
        await response.body?.cancel();
        return;
      }
      if (!response.ok || !response.body) throw new Error(`pi MCP request HTTP ${response.status}`);
      const sse = response.headers.get("content-type")?.startsWith("text/event-stream") === true;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const bodyReader = response.body.getReader();
      reader = bodyReader;
      let buffer = "", json = "", bytes = 0, replies = 0;
      const take = (frame: string) => {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
        if (!data.length) return;
        if (++replies !== 1) throw new Error("pi MCP SSE has multiple responses");
        json = data.join("\n");
      };
      for (;;) {
        const chunk = await bodyReader.read();
        if (chunk.done) { buffer += decoder.decode(); break; }
        bytes += chunk.value.byteLength;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (Buffer.byteLength(buffer) > maximum || (!sse && bytes > maximum)) throw new Error("pi MCP response exceeds 1 MiB");
        if (sse) {
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            take(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
          }
        }
      }
      if (sse && buffer.trim()) throw new Error("pi MCP SSE response is incomplete");
      const reply = JSON.parse(sse ? json : buffer);
      if (reply?.jsonrpc !== "2.0" || reply.id !== id ||
          Object.hasOwn(reply, "result") === Object.hasOwn(reply, "error")) throw new Error("pi MCP response identity is invalid");
      if (reply.error !== undefined) throw new Error(`pi MCP server error: ${String(reply.error?.message)}`);
      return reply.result;
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.abort();
      pending.delete(controller);
      // An aborted fetch may already have errored its body stream.
      await reader?.cancel().catch(() => {});
    }
  };
  return {
    request: (method, params, signal) => exchange(method, params, false, signal),
    notify: async (method) => { await exchange(method, undefined, true); },
    close: async () => { closed = true; for (const controller of pending) controller.abort(); },
  };
}
