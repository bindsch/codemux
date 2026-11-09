import { describe, expect, spyOn, test } from "bun:test";
import { installPiMcpExtension, type PiMcpTool, type PiMcpTransport } from "../src/pi-mcp-extension.js";

const definition = { name: "echo", description: "Return the input", inputSchema: { type: "object", properties: {} } };
function rig(input: { pages?: unknown[]; result?: unknown; exclusive?: boolean; name?: string; existing?: string[]; toolTimeoutMs?: number } = {}) {
  const tools: PiMcpTool[] = [];
  const hooks = new Map<string, (event: Record<string, unknown>, context?: Record<string, unknown>) => unknown>();
  const records: { kind: string; fields: Record<string, unknown> }[] = [];
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  let page = 0, closed = 0;
  let active = input.existing ?? ["read", "bash"];
  const transport: PiMcpTransport = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "tools/list") return input.pages === undefined ? { tools: [definition] } : input.pages[page++];
      if (method === "tools/call") return Object.hasOwn(input, "result") ? input.result : { content: [{ type: "text", text: " exact\nbytes " }] };
      return {};
    },
    notify: async (method) => { requests.push({ method }); },
    close: async () => { closed++; },
  };
  const api = {
    registerTool: (tool: PiMcpTool) => { tools.push(tool); },
    on: (name: string, hook: (event: Record<string, unknown>, context?: Record<string, unknown>) => unknown) => { hooks.set(name, hook); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  };
  return { tools, hooks, records, requests, transport,
    install: () => installPiMcpExtension(api, transport, {
      name: input.name ?? "synthetic", exclusive: input.exclusive ?? true,
      toolTimeoutMs: input.toolTimeoutMs,
      record: (kind, fields) => { records.push({ kind, fields }); },
    }),
    active: () => active, closed: () => closed,
  };
}

describe("Pi native MCP extension", () => {
  test("registers the exact catalog, preserves result bytes and correlates model context", async () => {
    const h = rig();
    await h.install();
    expect(h.requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(h.tools[0]).toMatchObject({ name: "mcp__synthetic__echo", parameters: definition.inputSchema });
    h.hooks.get("session_start")!({});
    expect(h.active()).toEqual(["mcp__synthetic__echo"]);
    const result = await h.tools[0]!.execute("call-1", { text: "x" });
    expect(result.content).toEqual([{ type: "text", text: " exact\nbytes " }]);
    expect(h.requests.at(-1)?.params).toEqual({ name: "echo", arguments: { text: "x" }, _meta: { "codemux/callId": "call-1" } });
    expect(h.hooks.get("tool_result")!({ toolCallId: "unknown" })).toBeUndefined();
    expect(h.hooks.get("tool_result")!({ toolCallId: "call-1" })).toEqual({ content: result.content, isError: false });
    h.hooks.get("context")!({ messages: [
      { role: "user", content: "p" }, { role: "toolResult", toolCallId: "unknown", content: [] },
      { role: "toolResult", toolCallId: "call-1", content: result.content, isError: false },
    ] });
    h.hooks.get("before_provider_request")!({ payload: { messages: ["raw native request"] } });
    expect(h.records.some((record) => record.kind === "model_tool_result")).toBe(true);
    expect(h.records.at(-1)).toEqual({ kind: "provider_request", fields: { payload: { messages: ["raw native request"] } } });
    h.hooks.get("before_provider_request")!({ payload: {} }, { model: { api: "openai-completions", id: "synthetic" } });
    expect(h.records.at(-1)).toEqual({ kind: "provider_request", fields: { payload: {}, api: "openai-completions", model: "synthetic" } });
    await h.hooks.get("session_shutdown")!({});
    await h.hooks.get("session_shutdown")!({});
    expect(h.closed()).toBe(1);
    await expect(h.tools[0]!.execute("call-2", {})).rejects.toThrow("transport is closed");
  });

  test("normal MCP leaves ordinary tools available; errors and images stay intact", async () => {
    const content = [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "error" }];
    const h = rig({ exclusive: false, result: { content, isError: true } });
    await h.install(); h.hooks.get("session_start")!({});
    expect(h.active()).toEqual(["read", "bash", "mcp__synthetic__echo"]);
    expect(await h.tools[0]!.execute("image-call", {})).toEqual({ content, details: undefined });
    expect(h.hooks.get("tool_result")!({ toolCallId: "image-call" })).toEqual({ content, isError: true });
    await expect(h.tools[0]!.execute("image-call", {})).rejects.toThrow("duplicated");
    await expect(h.tools[0]!.execute("", {})).rejects.toThrow("missing");
    expect(() => h.hooks.get("context")!({})).toThrow("no messages");
    expect(() => h.hooks.get("context")!({ messages: [{ role: "toolResult", toolCallId: "image-call", content: [], isError: true }] }))
      .toThrow("changed the server result");
  });

  test("native abort settles a pending MCP call and detaches its listener", async () => {
    const h = rig({ exclusive: false }); await h.install();
    const controller = new AbortController();
    const removed = spyOn(controller.signal, "removeEventListener");
    let requestSignal: AbortSignal | undefined;
    h.transport.request = async (_method, _params, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    };
    const execution = h.tools[0]!.execute("abort-call", {}, controller.signal);
    controller.abort(new Error("native tool abort"));
    await expect(execution).rejects.toThrow("native tool abort");
    expect(requestSignal?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(h.records.some((record) => record.kind === "server_tool_result")).toBe(false);
    await expect(h.tools[0]!.execute("never-dispatched", {}, controller.signal)).rejects.toThrow("native tool abort");
    expect(h.records.filter((record) => record.kind === "tool_call")).toHaveLength(1);
    removed.mockRestore();
  });

  test("experiment deadlines cancel stalled calls, while ordinary MCP gets no timer", async () => {
    const h = rig({ toolTimeoutMs: 5 }); await h.install();
    let requestSignal: AbortSignal | undefined;
    h.transport.request = async (_method, _params, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    };
    await expect(h.tools[0]!.execute("timeout-call", {})).rejects.toThrow("timed out after 5 ms");
    expect(requestSignal?.aborted).toBe(true);
    expect(h.records.at(-1)).toEqual({ kind: "tool_timeout", fields: {
      call_id: "timeout-call", name: "mcp__synthetic__echo", input: {}, timeout_ms: 5,
    } });
    const normal = rig({ exclusive: false }); await normal.install();
    const timed = spyOn(globalThis, "setTimeout");
    try {
      await normal.tools[0]!.execute("ordinary", {});
      expect(timed).not.toHaveBeenCalled();
    } finally { timed.mockRestore(); }
  });

  test("successful calls clear deadline timers before they can cancel later work", async () => {
    const h = rig({ toolTimeoutMs: 5 }); await h.install();
    let requestSignal: AbortSignal | undefined;
    h.transport.request = async (_method, _params, signal) => { requestSignal = signal; return { content: [] }; };
    await h.tools[0]!.execute("fast", {});
    await Bun.sleep(10);
    expect(requestSignal?.aborted).toBe(false);
    await expect(rig({ toolTimeoutMs: 0 }).install()).rejects.toThrow("tool timeout");
  });

  test("deadline evidence write failures still cancel instead of escaping the timer", async () => {
    const h = rig({ toolTimeoutMs: 5 }); await h.install();
    h.transport.request = async (_method, _params, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
    const execution = h.tools[0]!.execute("disk-full", {});
    const recordWrite = spyOn(h.records, "push").mockImplementation(() => { throw new Error("evidence disk full"); });
    try { await expect(execution).rejects.toThrow("evidence disk full"); }
    finally { recordWrite.mockRestore(); }
  });

  test("collects all catalog pages before installing any tool", async () => {
    const h = rig({ pages: [{ tools: [definition], nextCursor: "next" }, { tools: [{ ...definition, name: "second" }] }] });
    await h.install();
    expect(h.tools).toHaveLength(2);
    expect(h.requests.at(-1)?.params).toEqual({ cursor: "next" });
  });

  for (const [label, pages] of [
    ["scalar page", [null]],
    ["missing inventory", [{}]],
    ["empty inventory", [{ tools: [] }]],
    ["scalar tool", [{ tools: [null] }]],
    ["missing schema", [{ tools: [{ name: "t", description: "d" }] }]],
    ["invalid name", [{ tools: [{ ...definition, name: "bad/name" }] }]],
    ["duplicate name", [{ tools: [definition, definition] }]],
    ["repeated cursor", [{ tools: [definition], nextCursor: "next" }, { tools: [], nextCursor: "next" }]],
    ["invalid cursor", [{ tools: [definition], nextCursor: 1 }]],
  ] as const) {
    test(`refuses ${label} and closes transport`, async () => {
      const h = rig({ pages: [...pages] });
      await expect(h.install()).rejects.toThrow();
      expect(h.tools).toHaveLength(0);
      expect(h.closed()).toBe(1);
    });
  }

  test("invalid server names and existing-name collisions refuse", async () => {
    await expect(rig({ name: "invalid/name" }).install()).rejects.toThrow("server name");
    await expect(rig({ existing: ["mcp__synthetic__echo"] }).install()).rejects.toThrow("duplicated");
  });

  for (const result of [
    null, {}, { content: [], isError: "yes" }, { content: [], structuredContent: {} },
    { content: [], _meta: {} }, { content: [null] }, { content: [{ type: "resource", resource: {} }] },
  ]) {
    test(`refuses unsupported result ${JSON.stringify(result)}`, async () => {
      const h = rig({ result });
      await h.install();
      await expect(h.tools[0]!.execute("call", {})).rejects.toThrow();
      expect(h.records.some((record) => record.kind === "server_tool_result")).toBe(false);
    });
  }
});
