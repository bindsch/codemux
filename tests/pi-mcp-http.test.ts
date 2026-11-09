import { describe, expect, test } from "bun:test";
import { createPiMcpHttpTransport } from "../src/pi-mcp-http.js";

const url = "http://127.0.0.1:12345/mcp";
function fake(handler: (request: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((_: unknown, request: RequestInit) => Promise.resolve(handler(request))) as typeof fetch;
}
describe("Pi authenticated relay transport", () => {
  test("sends exact metadata and accepts JSON plus notifications", async () => {
    const transport = createPiMcpHttpTransport(url, "synthetic-token", fake((request) => {
      expect(request.redirect).toBe("error");
      expect(request.headers).toMatchObject({ Authorization: "Bearer synthetic-token" });
      const body = JSON.parse(String(request.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      expect(body.params).toEqual({ _meta: { "codemux/callId": "native" } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { exact: " bytes\n" } });
    }));
    expect(await transport.request("tools/call", { _meta: { "codemux/callId": "native" } })).toEqual({ exact: " bytes\n" });
    await transport.notify("notifications/initialized"); await transport.close();
    expect(transport.request("tools/list")).rejects.toThrow("closed");
  });
  test("accepts split UTF-8 SSE and discards keepalives", async () => {
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"text":"é"}}\n\n');
    const transport = createPiMcpHttpTransport(url, "token", fake(() => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { headers: { "Content-Type": "text/event-stream" } })));
    expect(await transport.request("tools/list")).toEqual({ text: "é" });
  });
  test.each([
    ["id", '{"jsonrpc":"2.0","id":2,"result":{}}', "application/json"],
    ["error", '{"jsonrpc":"2.0","id":1,"error":{"message":"broken"}}', "application/json"],
    ["two results", 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\ndata: {}\n\n', "text/event-stream"],
    ["partial SSE", 'data: {}', "text/event-stream"],
    ["oversized", "x".repeat(1024 * 1024 + 1), "application/json"],
  ])("rejects %s", async (_name, body, type) => {
    const t = createPiMcpHttpTransport(url, "token", fake(() => new Response(body, { headers: { "Content-Type": type! } })));
    expect(t.request("tools/list")).rejects.toThrow();
  });
  test("rejects wrong endpoint, HTTP failures and oversized requests", async () => {
    expect(() => createPiMcpHttpTransport("https://example.invalid/mcp", "token")).toThrow("loopback");
    const t = createPiMcpHttpTransport(url, "token", fake(() => new Response(null, { status: 500 })));
    expect(t.request("tools/list")).rejects.toThrow("HTTP 500");
    expect(t.notify("notifications/initialized")).rejects.toThrow("HTTP 500");
    expect(t.request("tools/call", { value: "x".repeat(1024 * 1024) })).rejects.toThrow("request exceeds");
  });
  test("close aborts every outstanding request", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const t = createPiMcpHttpTransport(url, "token", fake((request) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(new Error("aborted"))); started();
    })));
    const result = t.request("tools/call").catch((error: Error) => error.message);
    await ready; await t.close(); expect(await result).toBe("aborted");
  });
  test("native cancellation aborts only its exchange and accepts later calls", async () => {
    let fetched = 0;
    const t = createPiMcpHttpTransport(url, "token", fake((request) => {
      fetched++;
      const frame = JSON.parse(String(request.body));
      if (frame.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: frame.id, result: "still open" });
      return new Promise((_resolve, reject) => {
        request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
      });
    }));
    const controller = new AbortController();
    const result = t.request("tools/call", {}, controller.signal);
    controller.abort(new Error("native cancellation"));
    await expect(result).rejects.toThrow("native cancellation");
    await expect(t.request("tools/call", {}, controller.signal)).rejects.toThrow("native cancellation");
    expect(fetched).toBe(1);
    expect(await t.request("tools/list")).toBe("still open");
    await t.close();
  });
  test("cancellation while reading an SSE body releases the exchange", async () => {
    const t = createPiMcpHttpTransport(url, "token", fake((request) => {
      const frame = JSON.parse(String(request.body));
      if (frame.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: frame.id, result: {} });
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        request.signal!.addEventListener("abort", () => stream.error(request.signal!.reason), { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }));
    const controller = new AbortController();
    const result = t.request("tools/call", {}, controller.signal);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    controller.abort(new Error("cancel SSE"));
    await expect(result).rejects.toThrow("cancel SSE");
    expect(await t.request("tools/list")).toEqual({});
    await t.close();
  });
  test("bounds pending exchanges, releases settled slots, and cancels a full transport", async () => {
    const resolveResponses: (() => void)[] = [];
    const t = createPiMcpHttpTransport(url, "token", fake((request) => new Promise((resolve, reject) => {
      const frame = JSON.parse(String(request.body));
      resolveResponses.push(() => resolve(Response.json({ jsonrpc: "2.0", id: frame.id, result: "settled" })));
      request.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const calls = Array.from({ length: 64 }, () => t.request("tools/list").catch((error: Error) => error.message));
    await expect(t.request("tools/list")).rejects.toThrow("64 pending exchanges");
    expect(resolveResponses).toHaveLength(64);
    resolveResponses[0]!(); expect(await calls[0]).toBe("settled");
    const replacement = t.request("tools/list").catch((error: Error) => error.message);
    expect(resolveResponses).toHaveLength(65);
    await t.close();
    expect((await Promise.all([...calls.slice(1), replacement])).every((value) => value === "aborted")).toBe(true);
  });
});
