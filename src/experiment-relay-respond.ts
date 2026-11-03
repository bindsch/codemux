/** The experiment HTTP relay's reply plumbing: reading one bounded request
 * body, deciding whether a request declared one, and writing the relay's
 * HTTP answers. The relay itself (ExperimentHttpRelay,
 * experiment-relay.ts) owns the routing and the failure state; everything
 * here is the wire side of a reply. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "./experiment-server.js";
import type { ExperimentRecord } from "./experiment-records.js";

/** Whether the request declared a body (a nonzero Content-Length or a
 * Transfer-Encoding). The catalog and rejection routes answer without
 * reading such a body, and its unread bytes are exactly what a reused
 * keep-alive socket would parse as the next request's start: a 405
 * answered while a chunked body was still in flight left the late
 * chunks to be read as a request line, and the NEXT request on the
 * socket was answered 400 instead of its own status (lane C30, item
 * 6). Those routes close the connection whenever a body is declared;
 * the /mcp route reads its body to the end before answering and keeps
 * the keep-alive the MCP clients reuse. */
export function relayDeclaresBody(request: IncomingMessage): boolean {
  return (
    Number(request.headers["content-length"] ?? 0) > 0 ||
    request.headers["transfer-encoding"] !== undefined
  );
}

/** Reads one request body under the deadline and the 1 MiB message bound.
 * A body past the bound resolves with rejectedStatus 413 (the upload may
 * still be streaming; the caller drains or cuts it), a slow one with 408,
 * and a broken one rejects. */
export function readRelayBody(
  request: IncomingMessage,
  deadline: number
): Promise<{ bytes: Buffer; rejectedStatus?: 408 | 413 }> {
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

/** `close` ends the connection after the reply (the Connection: close
 * header and no socket reuse) — the answer for every reply the request
 * was not fully read before (see relayDeclaresBody), and always after 413
 * and 408, whose uploads are cut short. */
export function respondRelay(
  record: ExperimentRecord,
  response: ServerResponse,
  status: number,
  bytes: Buffer = Buffer.alloc(0),
  allowedMethod = "POST",
  close = false
): void {
  const endConnection = close || status === 413 || status === 408;
  if (endConnection) response.shouldKeepAlive = false;
  record("http_response", { status, bytes_base64: bytes.toString("base64") });
  response.writeHead(status, { ...(status === 200 ? { "Content-Type": "application/json" } : {}),
    ...(status === 405 ? { Allow: allowedMethod } : {}), ...(endConnection ? { Connection: "close" } : {}), "Content-Length": bytes.length });
  response.end(bytes);
}

/** The 413 answer: the complete empty reply is flushed before an upload
 * with pending writes is closed, and draining shares the original body
 * deadline, including time already spent reading. */
export function rejectRelayOversized(
  record: ExperimentRecord,
  request: IncomingMessage,
  response: ServerResponse,
  deadline: number
): void {
  record("http_response", { status: 413, bytes_base64: "" });
  response.shouldKeepAlive = false;
  response.writeHead(413, { Connection: "close", "Content-Length": 0 });
  response.flushHeaders();
  if (request.readableEnded || request.destroyed) { response.end(); return; }
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

/** Parses one JSON-RPC request or notification object, refusing anything
 * else the relay would forward to the server. */
export function parseRelayMessage(bytes: Buffer): JsonObject {
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
