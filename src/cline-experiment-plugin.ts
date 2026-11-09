import { createPiMcpHttpTransport } from "./pi-mcp-http.js";
import type { JsonObject } from "./experiment-server.js";

export const CLINE_EXPERIMENT_TOKEN_ENV = "CODEMUX_CLINE_EXPERIMENT_TOKEN";
export const CLINE_EXPERIMENT_CAPTURE_BYTES = 32 * 1024 * 1024;

/** Standalone native extension factory. Cline cli-v3.0.74, inspected 2026-11-09:
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/extensions/plugin/plugin-sandbox.ts#L748-L839 preserves
 * plain tool definitions; the createTool helper would remove schema fields. */
export function createClineExperimentPlugin(options: {
  name?: string; timeoutMs: number; transport?: ReturnType<typeof createPiMcpHttpTransport>;
  record: (kind: string, fields: JsonObject) => void;
}) {
  const definitions: JsonObject[] = [];
  const originals = new Map<string, JsonObject>();
  let ready = options.name === undefined;
  const fail = (reason: string) => { options.record("failure", { reason }); return { stop: true, reason }; };
  const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
  const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const nativeName = (name: string) => `mcp__${options.name}__${name}`;
  return {
    name: "codemux-experiment",
    manifest: { capabilities: ["hooks", "tools"] },
    async setup(api: { registerTool(tool: JsonObject): void }, context: { onDispose?: (fn: () => Promise<void>) => void }) {
      if (!options.transport) return;
      context.onDispose?.(() => options.transport!.close());
      await options.transport.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codemux-cline", version: "1" } });
      await options.transport.notify("notifications/initialized");
      const result = await options.transport.request("tools/list");
      if (!object(result) || !Array.isArray(result.tools) || !result.tools.length || result.nextCursor !== undefined) {
        throw new Error("Cline experiment requires the relay's complete nonempty inventory");
      }
      const names = new Set<string>();
      for (const tool of result.tools) {
        if (!object(tool) || typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name) ||
            nativeName(tool.name).length > 64 || typeof tool.description !== "string" || !object(tool.inputSchema) ||
            tool.inputSchema.type !== "object" || Object.keys(tool).some((key) => !["name", "description", "inputSchema"].includes(key))) {
          throw new Error("Cline experiment requires unique object-schema tools with explicit descriptions and no extra definition fields");
        }
        names.add(tool.name);
        const definition = { name: nativeName(tool.name), description: tool.description, inputSchema: tool.inputSchema };
        definitions.push(definition);
        api.registerTool({ ...definition, retryable: false, timeoutMs: options.timeoutMs,
          async execute(input: unknown, context: JsonObject) {
            const id = context.toolCallId;
            const original = originals.get(id);
            if (!original || original.toolName !== definition.name || !equal(input, original.input)) {
              throw new Error("Cline experiment dispatch lacks unchanged native call arguments");
            }
            options.record("dispatch", { call_id: id, name: definition.name, input });
            const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
            const response = await options.transport!.request("tools/call", { name: tool.name, arguments: input as JsonObject,
              _meta: { "codemux/callId": id } }, signal);
            if (!object(response) || (response.isError !== undefined && response.isError !== false) ||
                Object.keys(response).some((key) => !["content", "isError"].includes(key)) || !Array.isArray(response.content) || response.content.length !== 1 ||
                !object(response.content[0]) || response.content[0].type !== "text" || typeof response.content[0].text !== "string" ||
                Object.keys(response.content[0]).some((key) => !["type", "text"].includes(key)) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(response.content[0].text)) {
              throw new Error("Cline experiment requires one successful unannotated text result");
            }
            options.record("result", { call_id: id, content: response.content });
            return response.content;
          } });
      }
      ready = true;
      options.record("ready", { tools: definitions });
    },
    hooks: {
      beforeModel(context: JsonObject) {
        if (!ready || !object(context.request) || (context.request.modelTools?.length ?? 0) !== 0) return fail("Cline experiment has missing setup or native model tools");
        options.record("request", { run_id: context.snapshot.runId, iteration: context.snapshot.iteration,
          tools: definitions });
        return { tools: definitions };
      },
      afterModel(context: JsonObject) {
        const message = context.assistantMessage;
        if (!object(message) || typeof message.id !== "string" || !message.id || !Array.isArray(message.content)) return fail("Cline experiment lacks a native assistant message");
        for (const part of message.content) {
          if (part.type !== "tool-call") continue;
          if (typeof part.toolCallId !== "string" || !part.toolCallId || originals.has(part.toolCallId) || !object(part.input) ||
              !definitions.some((tool) => tool.name === part.toolName)) return fail("Cline experiment received an unknown, repeated or malformed tool call");
          originals.set(part.toolCallId, JSON.parse(JSON.stringify({ toolName: part.toolName, input: part.input })));
        }
        // Retain required native evidence, excluding unrelated provider metadata.
        options.record("turn", { run_id: context.snapshot.runId, iteration: context.snapshot.iteration,
          message: { id: message.id, metrics: { inputTokens: message.metrics?.inputTokens, outputTokens: message.metrics?.outputTokens,
            cacheReadTokens: message.metrics?.cacheReadTokens, cacheWriteTokens: message.metrics?.cacheWriteTokens },
          content: message.content.filter((part: JsonObject) => part.type === "tool-call").map((part: JsonObject) => ({
            type: part.type, toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })) } });
      },
      beforeTool(context: JsonObject) {
        const original = originals.get(context.toolCall?.toolCallId);
        if (!original || original.toolName !== context.toolCall.toolName) return fail("Cline experiment refused an unadvertised tool");
        // Cline recursively parses schema-typed JSON strings before this hook.
        return { input: original.input };
      },
    },
  };
}

export function clineExperimentPluginSource(evidencePath: string, timeoutMs: number, endpoint?: { url: string; name: string }): string {
  return `import { appendFileSync } from "node:fs";\n` +
    `const createTransport = ${createPiMcpHttpTransport.toString()};\n` +
    `const createPlugin = ${createClineExperimentPlugin.toString()};\n` +
    `let bytes = 0;\n` +
    `export default createPlugin({timeoutMs:${timeoutMs},${endpoint ? `name:${JSON.stringify(endpoint.name)},transport:createTransport(${JSON.stringify(endpoint.url)},process.env.${CLINE_EXPERIMENT_TOKEN_ENV}),` : ""}\n` +
    `record(kind,fields){const line=JSON.stringify({kind,fields,t:Date.now()/1000})+"\\n";bytes+=Buffer.byteLength(line);if(bytes>${CLINE_EXPERIMENT_CAPTURE_BYTES})throw new Error("Cline experiment evidence exceeds 32 MiB");appendFileSync(${JSON.stringify(evidencePath)},line,{mode:0o600});}});\n`;
}

/** Native wire capture runs after message projection. Its bounded full body,
 * rather than the earlier plugin hook, is the host's final delivery evidence.
 * Cline cli-v3.0.74, inspected 2026-11-09:
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/llms/src/providers/provider-request-capture.ts#L25-L57
 * https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/session/services/message-builder.ts#L92-L107 */
export function clineExperimentCaptureEnv(captureDir: string): Record<string, string> {
  return { CLINE_CAPTURE_PROVIDER_REQUEST: "full", CLINE_CAPTURE_WIRE: "true", CLINE_CAPTURE_DIR: captureDir,
    CLINE_CAPTURE_CLEANUP: "off", CLINE_CAPTURE_MAX_PREVIEW_BYTES: String(CLINE_EXPERIMENT_CAPTURE_BYTES),
    CLINE_MESSAGE_BUILDER_MAX_TOOL_RESULT_CHARS: String(CLINE_EXPERIMENT_CAPTURE_BYTES),
    CLINE_MESSAGE_BUILDER_MAX_TOTAL_TEXT_BYTES: String(CLINE_EXPERIMENT_CAPTURE_BYTES) };
}
