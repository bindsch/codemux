import { isDeepStrictEqual } from "node:util";
import { kimiObject, kimiProjectedResult, kimiToolName } from "./experiment-kimi-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code, toolResultDeliveredRecord, turnCallRecord, turnRecord, turnUsageRecord,
  type ExperimentRecord, type ExperimentUsage } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

export interface KimiNativeCall {
  callId: string; name: string; input: unknown; qualified: string; item: JsonObject;
  result?: JsonObject; content?: JsonObject[]; wireContent?: JsonObject[]; header?: string | null;
}
interface Step {
  uuid: string; calls: KimiNativeCall[]; parts: JsonObject[]; end?: JsonObject;
  turnTime?: number; usage?: ExperimentUsage; usageTime?: number; usageRecords: number;
  retry?: boolean; firstPartTime?: number;
}

export class KimiWireParser {
  readonly calls: KimiNativeCall[] = [];
  private byId = new Map<string, KimiNativeCall>();
  private steps = new Map<string, Step>();
  private completed: Step[] = [];
  private assistants: JsonObject[] = [];
  private inventorySeen = false;

  constructor(private readonly server: string, private readonly toolNames: () => ReadonlySet<string>,
    private readonly record: ExperimentRecord, private readonly toolDefinitions: () => readonly JsonObject[] | undefined) {}

  names(): Map<string, string> {
    const names = new Map<string, string>();
    for (const name of this.toolNames()) {
      const qualified = kimiToolName(this.server, name);
      if (names.has(qualified)) throw new ExperimentFailure(Code.InventoryMismatch, `Kimi tool name sanitizer collision for ${name}`);
      names.set(qualified, name);
    }
    return names;
  }

  accept(line: JsonObject): void {
    if (line.agentId !== undefined && line.agentId !== "main") throw new ExperimentFailure(Code.Protocol, "Unexpected Kimi subagent wire evidence");
    if (line.type === "llm.tools_snapshot") {
      const expected = this.names();
      const actual = Array.isArray(line.tools) ? line.tools.map((tool: unknown) => kimiObject(tool)?.name) : [];
      if (!expected.size || actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some((name: unknown) => typeof name !== "string" || !expected.has(name))) {
        throw new ExperimentFailure(Code.InventoryMismatch, "Kimi llm.tools_snapshot must expose exactly the experiment tools");
      }
      const definitions = this.toolDefinitions();
      if (!definitions || definitions.length !== expected.size || line.tools.some((tool: JsonObject) => {
        const original = definitions.find((definition) => definition.name === expected.get(tool.name));
        return !original || typeof tool.description !== "string" || !kimiObject(tool.parameters) ||
          tool.description !== (original.description ?? "") || !isDeepStrictEqual(tool.parameters, original.inputSchema);
      })) {
        throw new ExperimentFailure(Code.InventoryMismatch, "Kimi llm.tools_snapshot changed experiment tool descriptions or parameter schemas");
      }
      if (!this.inventorySeen) this.record("tool_inventory", { tools: line.tools });
      this.inventorySeen = true;
      this.record("harness_tool_inventory", { tools: line.tools, item: line });
    } else if (line.type === "context.append_loop_event") {
      const event = kimiObject(line.event);
      if (!event || typeof event.type !== "string") throw new ExperimentFailure(Code.Protocol, "Invalid Kimi loop event");
      if (["tool.call", "content.part", "step.end"].includes(event.type) && !this.inventorySeen) {
        throw new ExperimentFailure(Code.InventoryMismatch, "Kimi loop response preceded llm.tools_snapshot");
      }
      if (event.type === "tool.call") this.acceptCall(event, line.time);
      else if (event.type === "content.part") {
        if (!kimiObject(event.part)) throw new ExperimentFailure(Code.Protocol, "Invalid Kimi content.part");
        const step = this.step(event.stepUuid);
        if (step.retry) throw new ExperimentFailure(Code.Protocol, "Kimi response item follows a failed retry step");
        const t = timestamp(line.time);
        step.firstPartTime ??= t;
        step.parts.push(event.part);
        // Failed provider attempts can flush partial content before step.end.
        if (step.end) this.emitTurn(step, line.time);
      } else if (event.type === "step.end") this.acceptStep(event, line.time);
      else if (event.type === "tool.result") {
        this.record("harness_loop_tool_result", { call_id: event.toolCallId, result: event.result, item: event });
        const call = this.byId.get(event.toolCallId);
        if (!call || call.result || !kimiObject(event.result) || !(typeof event.result.output === "string" || Array.isArray(event.result.output))) {
          throw new ExperimentFailure(Code.Protocol, "Unmatched, duplicate, or malformed Kimi tool.result");
        }
        if (event.result.isError !== undefined && typeof event.result.isError !== "boolean") throw new ExperimentFailure(Code.Protocol, "Kimi tool.result isError must be a boolean");
        if (event.result.durationMs !== undefined && (typeof event.result.durationMs !== "number" || !Number.isFinite(event.result.durationMs) || event.result.durationMs < 0)) {
          throw new ExperimentFailure(Code.Protocol, "Kimi tool.result durationMs must be a finite nonnegative number");
        }
        if (event.result.note !== undefined && typeof event.result.note !== "string") throw new ExperimentFailure(Code.Protocol, "Kimi tool.result note must be a string");
        if (event.parentUuid !== call.item.uuid) throw new ExperimentFailure(Code.Protocol, "Kimi tool.result parentUuid does not match tool.call");
        call.result = event.result;
        this.record("tool_result_delivered", toolResultDeliveredRecord(call.callId, timestamp(line.time)));
      }
    } else if (line.type === "agent.message.appended") {
      const entry = kimiObject(line.message), message = kimiObject(entry?.message);
      if (!entry || !message) throw new ExperimentFailure(Code.Protocol, "Invalid Kimi agent.message.appended");
      if (message.role === "assistant") this.assistants.push(entry);
      else if (message.role === "tool") {
        const call = this.byId.get(message.toolCallId);
        if (!call || call.content !== undefined || !call.result || !Array.isArray(message.content) ||
            message.content.some((part: unknown) => !kimiObject(part) || (kimiObject(part)?.type === "text" && typeof kimiObject(part)?.text !== "string"))) {
          throw new ExperimentFailure(Code.Protocol, "Unmatched, duplicate, or malformed Kimi model tool message");
        }
        call.wireContent = message.content;
        const projected = kimiProjectedResult(message.content, call.result);
        call.content = projected.content;
        call.header = projected.header;
        this.record("model_tool_result", { call_id: message.toolCallId, content: call.content, output: call.content,
          wire_content: message.content, item: line });
      }
    }
  }

  private step(uuid: unknown): Step {
    if (typeof uuid !== "string" || !uuid.trim()) throw new ExperimentFailure(Code.MessageIdMissing, "Kimi loop response lacks a native step UUID");
    let step = this.steps.get(uuid);
    if (!step) { step = { uuid, calls: [], parts: [], usageRecords: 0 }; this.steps.set(uuid, step); }
    return step;
  }

  private acceptCall(event: JsonObject, time: unknown): void {
    const name = this.names().get(event.name);
    this.record(name === undefined ? "tool_call" : "harness_tool_call", { call_id: event.toolCallId,
      name: event.name, input: event.args, allowed: name !== undefined, item: event });
    if (name === undefined) throw new ExperimentFailure(Code.UnknownTool, `Kimi called a tool outside the experiment set: ${String(event.name)}`);
    if (typeof event.toolCallId !== "string" || !event.toolCallId.trim() || this.byId.has(event.toolCallId) ||
        typeof event.uuid !== "string" || !event.uuid.trim() || !kimiObject(event.args)) {
      throw new ExperimentFailure(Code.Protocol, "Duplicate or malformed Kimi tool.call");
    }
    const call: KimiNativeCall = { callId: event.toolCallId, name, input: event.args, qualified: event.name, item: event };
    const step = this.step(event.stepUuid);
    const t = timestamp(time);
    step.calls.push(call);
    this.byId.set(call.callId, call);
    this.emitTurn(step, time);
    this.record("turn_call", turnCallRecord(step.uuid, call.callId, call.name, t));
    this.calls.push(call);
  }

  private acceptStep(event: JsonObject, time: unknown): void {
    const step = this.step(event.uuid);
    if (step.end) throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi wire log has duplicate step.end usage evidence");
    if (event.messageId !== undefined && (typeof event.messageId !== "string" || !event.messageId.trim())) {
      throw new ExperimentFailure(Code.Protocol, "Kimi step.end has an invalid provider messageId");
    }
    if (event.finishReason === "error" && event.usage == null && step.calls.length === 0) {
      step.end = event;
      step.retry = true;
      this.record("harness_retry", { message_id: step.uuid, t: timestamp(time), item: event });
      return;
    }
    const usage = event.usage == null ? undefined : normalizedUsage(event.usage);
    if (step.firstPartTime !== undefined) this.emitTurn(step, time);
    step.usageTime = timestamp(time);
    step.usage = usage;
    step.end = event;
    this.completed.push(step);
    this.emitUsage(step);
  }

  private emitTurn(step: Step, time: unknown): void {
    const t = step.firstPartTime ?? timestamp(time);
    if (step.retry) throw new ExperimentFailure(Code.Protocol, "Kimi response item follows a failed retry step");
    if (step.turnTime !== undefined) return;
    step.turnTime = t;
    this.record("turn", turnRecord(step.uuid, t, step.usage ?? null,
      step.calls.map((call) => ({ call_id: call.callId, name: call.name }))));
    this.emitUsage(step);
  }

  private emitUsage(step: Step): void {
    if (step.turnTime === undefined || !step.usage || step.usageRecords) return;
    this.record("turn_usage", turnUsageRecord(step.uuid, step.usage, step.usageTime!));
    step.usageRecords++;
  }

  finish(): void {
    if (!this.inventorySeen) throw new ExperimentFailure(Code.InventoryMismatch, "Kimi wire log is missing llm.tools_snapshot");
    if (!this.completed.length || [...this.steps.values()].some((step) => !step.retry && (!step.end || step.turnTime === undefined || step.usageRecords !== 1))) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi wire log requires a completed step and exactly one usage record per turn");
    }
    if (this.completed.length !== this.assistants.length) throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi assistant message count does not match completed steps");
    for (const [index, step] of this.completed.entries()) {
      const entry = this.assistants[index]!, message = entry.message, meta = kimiObject(entry.meta);
      const toolCalls = message.toolCalls;
      if (!Array.isArray(toolCalls) || !Array.isArray(message.content) || !isDeepStrictEqual(message.content, step.parts) ||
          !isDeepStrictEqual(normalizedUsage(meta?.usage), normalizedUsage(step.end!.usage)) ||
          (step.end!.messageId !== undefined && step.end!.messageId !== meta?.messageId) || toolCalls.length !== step.calls.length) {
        throw new ExperimentFailure(Code.Protocol, "Kimi assistant message does not match its loop step content, usage, or calls");
      }
      for (const [callIndex, call] of step.calls.entries()) {
        const native = kimiObject(toolCalls[callIndex]);
        let input: unknown;
        try { input = JSON.parse(native?.arguments); } catch { /* The comparison below rejects invalid arguments. */ }
        if (native?.type !== "function" || native.id !== call.callId || native.name !== call.qualified || !isDeepStrictEqual(input, call.input)) {
          throw new ExperimentFailure(Code.Protocol, "Kimi assistant native tool call does not match tool.call evidence");
        }
      }
    }
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ExperimentFailure(Code.Protocol, "Kimi wire time must be Unix epoch milliseconds");
  return value / 1000;
}

function normalizedUsage(value: unknown): ExperimentUsage {
  const usage = kimiObject(value);
  for (const key of ["inputOther", "output", "inputCacheRead", "inputCacheCreation"]) {
    if (!usage || !Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new ExperimentFailure(Code.Protocol, `Invalid Kimi usage ${key}`);
  }
  return { input: usage!.inputOther, output: usage!.output, cache_read: usage!.inputCacheRead, cache_write: usage!.inputCacheCreation };
}
