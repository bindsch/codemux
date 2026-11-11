/** Native Pi extension API bridge, pinned to pi 0.85.1 (2026-11-09):
 * dist/core/extensions/types.d.ts registerTool, tool_result, context,
 * before_provider_request, and session_shutdown. Transport ownership stays
 * with the launcher; experiment callers supply the existing HTTP relay. */
type ObjectValue = Record<string, unknown>;

export interface PiMcpTransport {
  request(method: string, params?: ObjectValue, signal?: AbortSignal): Promise<unknown>;
  notify(method: string): Promise<void>;
  close(): Promise<void>;
}

export interface PiMcpTool {
  name: string;
  label: string;
  description: string;
  parameters: ObjectValue;
  execute(id: string, input: ObjectValue, signal?: AbortSignal): Promise<{ content: unknown[]; details: undefined }>;
}

export interface PiMcpExtensionApi {
  registerTool(tool: PiMcpTool): void;
  on(name: string, handler: (event: ObjectValue, context?: ObjectValue) => unknown): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface PiMcpExtensionOptions {
  name: string;
  exclusive: boolean;
  /** Experiment tool deadline only; ordinary MCP calls have no added timeout. */
  toolTimeoutMs?: number;
  record(kind: string, fields: ObjectValue): void;
}

/** All imported MCP definitions are collected before registration. Result
 * bytes remain unchanged; unsupported MCP block types fail before delivery.
 * The native tool_result hook carries isError without throwing away content.
 * Context evidence checks the actual messages Pi will convert for its model;
 * provider evidence records the final payload through Pi's native hook. */
export async function installPiMcpExtension(
  pi: PiMcpExtensionApi,
  transport: PiMcpTransport,
  options: PiMcpExtensionOptions
): Promise<void> {
  const object = (value: unknown): ObjectValue => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("pi MCP expected an object");
    }
    return value as ObjectValue;
  };
  const results = new Map<string, { content: unknown[]; isError: boolean }>();
  const calls = new Set<string>();
  const names = new Set<string>();
  const existing = new Set(pi.getActiveTools());
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await transport.close();
  };
  pi.on("session_shutdown", close);
  try {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.name)) throw new Error("pi MCP server name is invalid");
    if (options.toolTimeoutMs !== undefined && (!Number.isSafeInteger(options.toolTimeoutMs) || options.toolTimeoutMs <= 0 || options.toolTimeoutMs > 2_147_483_647)) {
      throw new Error("pi MCP tool timeout must be a positive timer-safe integer");
    }
    await transport.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codemux-pi", version: "2.0.0" },
    });
    await transport.notify("notifications/initialized");
    const definitions: ObjectValue[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = object(await transport.request("tools/list", cursor === undefined ? {} : { cursor }));
      if (!Array.isArray(page.tools)) throw new Error("pi MCP tools/list requires tools");
      for (const value of page.tools) {
        const tool = object(value);
        const name = `mcp__${options.name}__${String(tool.name)}`;
        if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
            name.length > 64 || names.has(name) || existing.has(name) ||
            (tool.description !== undefined && typeof tool.description !== "string")) {
          throw new Error("pi MCP tool name or description is invalid or duplicated");
        }
        object(tool.inputSchema);
        names.add(name);
        definitions.push(tool);
      }
      const next = page.nextCursor;
      if (next !== undefined && (typeof next !== "string" || cursors.has(next) || cursors.size >= 100)) {
        throw new Error("pi MCP invalid or repeated tools/list cursor");
      }
      cursor = next as string | undefined;
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    if (definitions.length === 0) throw new Error("pi MCP requires a nonempty tool inventory");
    options.record("tool_inventory", { tools: definitions });
    for (const tool of definitions) {
      const name = `mcp__${options.name}__${String(tool.name)}`;
      pi.registerTool({
        name, label: name, description: (tool.description as string | undefined) ?? "", parameters: object(tool.inputSchema),
        execute: async (id, input, signal) => {
          if (closed) throw new Error("pi MCP transport is closed");
          signal?.throwIfAborted();
          if (!id || calls.has(id)) throw new Error("pi MCP call id is missing or duplicated");
          calls.add(id);
          options.record("tool_call", { call_id: id, name, input });
          const controller = new AbortController();
          const abort = () => controller.abort(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          const timer = options.toolTimeoutMs === undefined ? undefined : setTimeout(() => {
            try {
              options.record("tool_timeout", { call_id: id, name, input, timeout_ms: options.toolTimeoutMs });
              controller.abort(new Error(`pi MCP tool call timed out after ${options.toolTimeoutMs} ms`));
            } catch (error) { controller.abort(error); }
          }, options.toolTimeoutMs);
          let result: ObjectValue;
          try {
            result = object(await transport.request("tools/call", {
              name: tool.name, arguments: input, _meta: { "codemux/callId": id },
            }, controller.signal));
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          }
          if (!Array.isArray(result.content) ||
              (result.isError !== undefined && typeof result.isError !== "boolean") ||
              "structuredContent" in result || "_meta" in result) {
            throw new Error("pi MCP result requires content and optional boolean isError only");
          }
          for (const value of result.content) {
            const block = object(value);
            if (!(block.type === "text" && typeof block.text === "string") &&
                !(block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")) {
              throw new Error(`pi MCP unsupported result block ${String(block.type)}`);
            }
          }
          const content = structuredClone(result.content);
          results.set(id, { content, isError: result.isError === true });
          options.record("server_tool_result", { call_id: id, content, is_error: result.isError === true });
          return { content: structuredClone(content), details: undefined };
        },
      });
    }
    pi.on("session_start", () => {
      pi.setActiveTools(options.exclusive ? [...names] : [...new Set([...pi.getActiveTools(), ...names])]);
    });
    pi.on("tool_result", (event) => {
      const result = results.get(String(event.toolCallId));
      if (result === undefined) return;
      return { content: structuredClone(result.content), isError: result.isError };
    });
    pi.on("context", (event) => {
      if (!Array.isArray(event.messages)) throw new Error("pi MCP context has no messages");
      if (options.exclusive) options.record("model_context", { messages: event.messages });
      for (const value of event.messages) {
        const message = object(value);
        if (message.role !== "toolResult") continue;
        const result = results.get(String(message.toolCallId));
        if (result === undefined) continue;
        if (JSON.stringify(message.content) !== JSON.stringify(result.content) || message.isError !== result.isError) {
          throw new Error("pi MCP model context changed the server result");
        }
        options.record("model_tool_result", { call_id: message.toolCallId, content: message.content, is_error: message.isError });
      }
    });
    pi.on("before_provider_request", (event, context) => {
      const model = context?.model as ObjectValue | undefined;
      options.record("provider_request", { payload: event.payload,
        ...(model === undefined ? {} : { api: model.api, model: model.id }) });
    });
  } catch (error) {
    await close();
    throw error;
  }
}
