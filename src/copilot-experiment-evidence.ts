import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";
import { recordVerifiedDeliveries } from "./experiment-delivery-records.js";

export function copilotExperimentObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperimentFailure(Code.Protocol, "Copilot experiment requires an object");
  return value as JsonObject;
}

/** A single text block has an exact string projection in all three
 * provider wires. Other content needs a verified native projection. */
export function assertCopilotExperimentResult(value: JsonObject): void {
  if (Object.keys(value).some((key) => !["content", "isError"].includes(key)) ||
      !Array.isArray(value.content) || value.content.length !== 1 ||
      value.content[0]?.type !== "text" || typeof value.content[0]?.text !== "string" ||
      Object.keys(value.content[0]).some((key) => !["type", "text"].includes(key)) ||
      (value.isError !== undefined && typeof value.isError !== "boolean")) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Copilot experiment requires one plain text result block");
  }
}

export interface CopilotExperimentSource {
  spec: { name: string };
  calls: readonly ExperimentRelayCall[];
  toolDefinitions: readonly JsonObject[] | undefined;
  record: ExperimentRecord;
}
export interface CopilotExperimentDelivery { readonly callIds: readonly string[]; readonly wireApi: "chat" | "responses" | "anthropic"; }
export interface CopilotDeliveryObserver {
  request(bytes: Uint8Array, context?: JsonObject): CopilotExperimentDelivery;
  commit(delivery: CopilotExperimentDelivery, response?: Uint8Array): void;
  discard(delivery: CopilotExperimentDelivery): void;
}

/** Installed @github/copilot 1.0.85 copilot-sdk/types.d.ts
 * PreMcpToolCallHookInput and generated/rpc.d.ts CurrentToolMetadata,
 * LlmInferenceHttpRequestStartRequest/ChunkRequest, read 2026-11-09.
 * These channels expose native call identity, model-facing tool names,
 * and the final request bytes. No transcript model field is treated as
 * produced-model provenance, and no tool-completion UI text proves delivery. */
export class CopilotExperimentEvidence {
  private readonly tools = new Map<string, JsonObject>();
  private readonly calls = new Map<string, { name: string; input: unknown }>();
  private readonly delivered = new Set<string>();
  private readonly deliveries: { id: string; t: number }[] = [];
  private recorded = false;
  private requests = 0;
  private readonly pending = new Set<CopilotExperimentDelivery>();

  constructor(private readonly source: CopilotExperimentSource, private readonly sessionId: string) {}

  catalog(metadata: unknown): void {
    if (this.tools.size || !Array.isArray(metadata) || !this.source.toolDefinitions?.length) {
      throw new ExperimentFailure(Code.InventoryMismatch, "Copilot experiment needs one nonempty native catalog");
    }
    for (const value of metadata) {
      const tool = copilotExperimentObject(value);
      const definition = this.source.toolDefinitions.find((entry) => entry.name === tool.mcpToolName);
      if (!definition || tool.mcpServerName !== this.source.spec.name || typeof tool.name !== "string" || !tool.name ||
          this.tools.has(tool.name) || tool.description !== definition.description ||
          !isDeepStrictEqual(tool.input_schema, definition.inputSchema)) {
        throw new ExperimentFailure(Code.InventoryMismatch, "Copilot native tools differ from the server catalog");
      }
      this.tools.set(tool.name, definition);
    }
    if (this.tools.size !== this.source.toolDefinitions.length ||
        new Set([...this.tools.values()].map((tool) => tool.name)).size !== this.tools.size) {
      throw new ExperimentFailure(Code.InventoryMismatch, "Copilot native catalog omitted or repeated a server tool");
    }
    this.source.record("copilot_native_catalog", { tools: metadata });
  }

  hook(params: JsonObject): JsonObject {
    if (params.sessionId !== this.sessionId) throw new ExperimentFailure(Code.Protocol, "Copilot hook names a different session");
    if (params.hookType !== "preMcpToolCall") return {};
    const input = copilotExperimentObject(params.input);
    const id = input.toolCallId;
    if (input.serverName !== this.source.spec.name || typeof id !== "string" || !id.trim() ||
        this.calls.has(id) || ![...this.tools.values()].some((tool) => tool.name === input.toolName)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Copilot MCP hook lacks a unique catalog-backed native call ID");
    }
    this.calls.set(id, { name: input.toolName, input: input.arguments });
    this.source.record("copilot_native_call", { call_id: id, name: input.toolName, input: input.arguments });
    return { output: { metaToUse: { ...(input._meta === undefined ? {} : copilotExperimentObject(input._meta)), "codemux/callId": id } } };
  }

  /** Called before the transport forwards exactly these bytes upstream.
   * HTTP retries may repeat prior results; delivery is recorded once. */
  request(bytes: Uint8Array): CopilotExperimentDelivery {
    const frame = copilotExperimentObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const payload = frame.type === "response.create" && frame.response !== undefined ? copilotExperimentObject(frame.response) : frame;
    let tools: JsonObject[], results: JsonObject[], declared: JsonObject[], kind: "chat" | "responses" | "anthropic";
    if (Array.isArray(payload.input)) {
      const input = payload.input.map((item: JsonObject, position: number) => ({ ...item, copilotPosition: position }));
      kind = "responses"; tools = payload.tools; results = input.filter((item: JsonObject) => item.type === "function_call_output");
      declared = input.filter((item: JsonObject) => item.type === "function_call").map((call: JsonObject) => ({ id: call.call_id, name: call.name, input: JSON.parse(call.arguments), position: call.copilotPosition }));
    } else if (Array.isArray(payload.messages) && Array.isArray(payload.tools) && payload.tools.every((tool: JsonObject) => tool.type === "function")) {
      kind = "chat"; tools = payload.tools.map((tool: JsonObject) => tool.function);
      results = payload.messages.map((item: JsonObject, position: number) => ({ ...item, copilotPosition: position })).filter((item: JsonObject) => item.role === "tool");
      declared = payload.messages.flatMap((item: JsonObject, position: number) => item.role === "assistant"
        ? (item.tool_calls ?? []).map((call: JsonObject) => ({ id: call.id, name: call.function?.name, input: JSON.parse(call.function?.arguments), position })) : []);
    } else if (Array.isArray(payload.messages) && Array.isArray(payload.tools)) {
      kind = "anthropic"; tools = payload.tools;
      results = []; declared = [];
      payload.messages.forEach((item: JsonObject, position: number) => {
        if (!Array.isArray(item.content)) return;
        for (const part of item.content) {
          if (part.type === "tool_result") {
            if (item.role !== "user") throw new ExperimentFailure(Code.ResultChanged, "Copilot Anthropic tool result has the wrong role");
            results.push({ ...part, copilotPosition: position });
          }
          if (part.type === "tool_use") {
            if (item.role !== "assistant") throw new ExperimentFailure(Code.CallIdUnresolved, "Copilot Anthropic tool call has the wrong role");
            declared.push({ id: part.id, name: part.name, input: part.input, position });
          }
        }
      });
    } else throw new ExperimentFailure(Code.ModelUnavailable, "Copilot experiment has no decoder for the final provider request");
    if (!Array.isArray(tools) || tools.length !== this.tools.size || !tools.length) throw new ExperimentFailure(Code.InventoryMismatch, "Copilot provider catalog has a different size");
    const seenTools = new Set<string>();
    for (const raw of tools) {
      const tool = copilotExperimentObject(raw), definition = this.tools.get(tool.name);
      if (!definition || seenTools.has(tool.name) || tool.description !== definition.description ||
          !isDeepStrictEqual(tool.parameters ?? tool.input_schema, definition.inputSchema)) {
        throw new ExperimentFailure(Code.InventoryMismatch, "Copilot provider changed a tool name, description, or schema");
      }
      seenTools.add(tool.name);
    }
    const declaredIds = new Map<string, number>();
    for (const call of declared) {
      const hook = this.calls.get(call.id), definition = this.tools.get(call.name);
      if (!hook || !definition || declaredIds.has(call.id) || definition.name !== hook.name || !isDeepStrictEqual(hook.input, call.input)) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Copilot provider changed an assistant tool-call name, ID, or arguments");
      }
      declaredIds.set(call.id, call.position);
    }
    const seenResults = new Set<string>();
    for (const result of results) {
      const id = result.tool_call_id ?? result.call_id ?? result.tool_use_id;
      const hook = this.calls.get(id), relay = this.source.calls.find((call) => call.call_id === id);
      if (!hook || !relay?.result || !declaredIds.has(id) || declaredIds.get(id)! >= result.copilotPosition || seenResults.has(id) || hook.name !== relay.name || !isDeepStrictEqual(hook.input, relay.input)) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "Copilot provider result lacks a unique matching hook and relay call");
      }
      assertCopilotExperimentResult(relay.result);
      const projected = kind === "responses" ? result.output : result.content;
      if (projected !== relay.result.content[0].text ||
          (kind === "anthropic" && (result.is_error === true) !== (relay.result.isError === true))) {
        throw new ExperimentFailure(Code.ResultChanged, "Copilot provider changed or wrapped the server result");
      }
      seenResults.add(id);
    }
    this.source.record("copilot_provider_request", { bytes_base64: Buffer.from(bytes).toString("base64"), wire_api: kind });
    const delivery = { callIds: [...seenResults], wireApi: kind }; this.pending.add(delivery); return delivery;
  }

  commit(delivery: CopilotExperimentDelivery): void {
    if (!this.pending.delete(delivery)) throw new ExperimentFailure(Code.Protocol, "Copilot provider delivery was not pending");
    this.requests++;
    for (const id of delivery.callIds) {
      if (!this.delivered.has(id)) {
        const t = Date.now() / 1000;
        this.source.record("tool_result_delivered", { call_id: id, t });
        this.deliveries.push({ id, t });
      }
      this.delivered.add(id);
    }
  }

  discard(delivery: CopilotExperimentDelivery): void { this.pending.delete(delivery); }

  complete(): void {
    if (!this.requests || this.pending.size || this.calls.size !== this.source.calls.length || this.delivered.size !== this.calls.size ||
        this.source.calls.some((call) => !call.call_id || !this.delivered.has(call.call_id))) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Copilot experiment lacks complete provider delivery evidence");
    }
    if (!this.recorded) {
      recordVerifiedDeliveries(this.source, "copilot", new Map(this.source.calls.map((call) => [call.call_id!, call])), this.deliveries);
      this.recorded = true;
    }
  }
}
