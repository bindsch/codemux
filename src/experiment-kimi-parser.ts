import { isDeepStrictEqual } from "node:util";
import { kimiContentParts, kimiObject, kimiOutputParts, kimiProjectedResult, kimiToolName } from "./experiment-kimi-content.js";
import { ExperimentFailure, ExperimentFailureCode as Code, toolResultDeliveredRecord, turnCallRecord, turnRecord, turnUsageRecord,
  type ExperimentRecord, type ExperimentUsage } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";
import { experimentToolTimeoutSeconds } from "./experiment-mcp.js";

export interface KimiNativeCall {
  callId: string; name: string; input: unknown; qualified: string; item: JsonObject;
  modelToolError?: boolean;
  /** Kimi rejected the call itself for arguments that failed its schema
   * (`args: {}` on the wire, an `Invalid args for tool` error result,
   * nothing dispatched to the server). */
  harnessRejectedArgs?: boolean;
  /** The assistant message's raw `arguments` string of a rejected call, so
   * the stdout evidence can be held to the same bytes (round 24, edges 1). */
  nativeArguments?: string;
  result?: JsonObject; content?: JsonObject[]; wireContent?: JsonObject[]; header?: string | null;
}
export interface KimiAssistantFrame { text: string; callIds: string[] }
interface Step {
  uuid: string; calls: KimiNativeCall[]; parts: JsonObject[]; end?: JsonObject;
  turnTime?: number; usage?: ExperimentUsage; usageTime?: number; usageRecords: number;
  retry?: boolean; firstPartTime?: number;
  /** The end arrived before any content or call — Kimi's early-usage shape,
   * whose content parts are still flushed after it. */
  lateContent?: boolean;
}

export class KimiWireParser {
  readonly calls: KimiNativeCall[] = [];
  private byId = new Map<string, KimiNativeCall>();
  private steps = new Map<string, Step>();
  private completed: Step[] = [];
  private verified?: Step[];
  private assistants: JsonObject[] = [];
  private inventorySeen = false;

  constructor(private readonly server: string, private readonly toolNames: () => ReadonlySet<string>,
    private readonly record: ExperimentRecord, private readonly toolDefinitions: () => readonly JsonObject[] | undefined,
    private readonly toolTimeoutMs = experimentToolTimeoutSeconds({}) * 1000,
    private readonly serverResults: () => readonly { name: string; input: unknown; result?: JsonObject }[] = () => []) {}

  assertToolAllowed(name: string): void {
    if (KIMI_BUILTIN_TOOLS.has(name)) throw new ExperimentFailure(Code.UnknownTool, `Kimi called a built-in tool outside the experiment set: ${name}`);
  }

  names(): Map<string, string> {
    const names = new Map<string, string>();
    for (const name of this.toolNames()) {
      const qualified = kimiToolName(this.server, name);
      if (names.has(qualified)) throw new ExperimentFailure(Code.InventoryMismatch, `Kimi tool name sanitizer collision for ${name}`);
      names.set(qualified, name);
    }
    return names;
  }

  assistantFrames(): KimiAssistantFrame[] {
    return (this.verified ?? this.completed).map((step) => ({
      text: step.parts.filter((part) => part.type === "text").map((part) => {
        if (typeof part.text !== "string") throw new ExperimentFailure(Code.Protocol, "Kimi assistant text part must contain a string");
        return part.text;
      }).join(""),
      callIds: step.calls.map((call) => call.callId),
    })).filter((frame) => frame.text.length > 0 || frame.callIds.length > 0);
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
        // A step whose end arrived after its content or calls is finalized:
        // a later part would mutate what the assistant-message comparison
        // checks (review round 331). The early-usage shape — usage recorded
        // before the step's first content — still flushes its parts after
        // the end and keeps emitting its turn from them.
        if (step.end && !step.lateContent) throw new ExperimentFailure(Code.Protocol, "Kimi content.part follows step.end");
        const t = timestamp(line.time);
        step.firstPartTime ??= t;
        step.parts.push(event.part);
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
        if (!call.modelToolError && event.result.isError === true && typeof event.result.output === "string" &&
            event.result.output.startsWith(`Tool "${call.qualified}" failed: `) && !this.isServerError(call, event.result)) this.assertNoToolTimeout(event.result);
        if (call.modelToolError && (event.result.isError !== true || event.result.output !== `Tool "${call.qualified}" not found`)) {
          throw new ExperimentFailure(Code.UnknownTool, `Kimi unknown tool lacks its own missing-tool error: ${call.qualified}`);
        }
        call.result = event.result;
        if (!call.modelToolError && event.result.isError === true && typeof event.result.output === "string" &&
            event.result.output.startsWith(`Invalid args for tool "${call.qualified}"`) && isDeepStrictEqual(call.input, {}) &&
            !this.isServerError(call, event.result)) {
          // Kimi's own schema rejection of a call whose arguments it could not
          // parse: the wire carries `args: {}`, the server never sees the call,
          // and the model gets this error. The hold probe of 2026-11-02 saw a
          // 14 KB unterminated argument string rejected this way 13 times. A
          // server that answered an empty-argument call with the same words is
          // a dispatched server error (isServerError) and keeps its relay
          // match (round 24, edges 2).
          call.harnessRejectedArgs = true;
          this.record("harness_invalid_args", { call_id: call.callId, name: call.qualified, output: event.result.output });
        }
        if (call.modelToolError) this.record("model_tool_error", { call_id: call.callId, name: call.qualified,
          input: call.input, harness_output: event.result.output });
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
    this.assertToolAllowed(event.name);
    if (typeof event.toolCallId !== "string" || !event.toolCallId.trim() || this.byId.has(event.toolCallId) ||
        typeof event.name !== "string" || !event.name.trim() || typeof event.uuid !== "string" || !event.uuid.trim() || !kimiObject(event.args)) {
      throw new ExperimentFailure(Code.Protocol, "Duplicate or malformed Kimi tool.call");
    }
    const step = this.step(event.stepUuid);
    if (step.end) throw new ExperimentFailure(Code.Protocol, "Kimi tool.call follows step.end");
    const call: KimiNativeCall = { callId: event.toolCallId, name: name ?? event.name, input: event.args,
      qualified: event.name, item: event, modelToolError: name === undefined };
    const t = timestamp(time);
    step.calls.push(call);
    this.byId.set(call.callId, call);
    this.emitTurn(step, time);
    this.record("turn_call", turnCallRecord(step.uuid, call.callId, call.name, t));
    this.calls.push(call);
  }

  private acceptStep(event: JsonObject, time: unknown): void {
    const step = this.step(event.uuid);
    if (event.finishReason === "error" && step.calls.some((call) => !call.modelToolError && !call.result)) this.assertNoToolTimeout(event.error ?? event);
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
    step.lateContent = step.parts.length === 0 && step.calls.length === 0;
    step.usageTime = timestamp(time);
    step.usage = usage;
    step.end = event;
    this.completed.push(step);
    this.emitUsage(step);
  }

  private assertNoToolTimeout(value: JsonObject): void {
    const text = JSON.stringify(value);
    if (!/(?:\bRequest timed out\b|\btool (?:call )?timed out\b|"code":-32001)/i.test(text)) return;
    const error = kimiObject(value.error) ?? value;
    const supplied = kimiObject(error.data)?.timeout ?? error.timeoutMs ?? error.timeout;
    const milliseconds = Number.isSafeInteger(supplied) && supplied > 0 ? supplied : this.toolTimeoutMs;
    throw new ExperimentFailure(Code.ServerError, `kimi tool call timed out after ${milliseconds} ms`);
  }

  private isServerError(call: KimiNativeCall, result: JsonObject): boolean {
    return this.serverResults().some((server) => server.name === call.name && isDeepStrictEqual(server.input, call.input) &&
      server.result?.isError === true && Array.isArray(server.result.content) &&
      isDeepStrictEqual(kimiContentParts(server.result.content, call.qualified), kimiOutputParts(result.output)));
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

  finish(options?: { timedOut?: boolean }): void {
    if (!this.inventorySeen) throw new ExperimentFailure(Code.InventoryMismatch, "Kimi wire log is missing llm.tools_snapshot");
    const unresolved = this.calls.find((call) => call.modelToolError && !call.result);
    if (unresolved) throw new ExperimentFailure(Code.UnknownTool, `Kimi unknown tool lacks its own missing-tool error: ${unresolved.qualified}`);
    const finalStep = [...this.steps.values()].filter((step) => !step.retry).at(-1);
    const isTimedOutFinal = (step: Step) => options?.timedOut === true && step === finalStep;
    const completed = [...this.completed];
    if (finalStep && isTimedOutFinal(finalStep) && !finalStep.end) {
      if (finalStep.turnTime === undefined && finalStep.firstPartTime !== undefined) this.emitTurn(finalStep, finalStep.firstPartTime * 1000);
      completed.push(finalStep);
    }
    if (!completed.length || [...this.steps.values()].some((step) => !step.retry &&
        ((!step.end && !isTimedOutFinal(step)) || step.turnTime === undefined ||
        (step.usageRecords !== 1 && !(isTimedOutFinal(step) && step.usage === undefined))))) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi wire log requires a completed step and exactly one usage record per turn");
    }
    if (completed.length !== this.assistants.length) throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi assistant message count does not match completed steps");
    for (const [index, step] of completed.entries()) {
      const entry = this.assistants[index]!, message = entry.message, meta = kimiObject(entry.meta);
      const toolCalls = message.toolCalls;
      const messageUsage = meta?.usage == null ? undefined : normalizedUsage(meta.usage);
      // Both sides are already the normalized form of the usage each
      // channel carried, and undefined when that channel had none:
      // normalizedUsage throws on an absent input, so the old fallback
      // arms (`messageUsage ?? normalizedUsage(meta?.usage)` and the
      // step.end twin) could never produce a value — a completed step
      // whose assistant message lacks meta.usage failed with the
      // misattributed "Invalid Kimi usage" instead of this mismatch
      // (review round 361, item 3). An absent usage is itself the
      // mismatch; the verdict is fail-closed either way.
      const usageMatches = isTimedOutFinal(step) && (!step.usage || !messageUsage) ||
        isDeepStrictEqual(messageUsage, step.usage);
      if (!Array.isArray(toolCalls) || !Array.isArray(message.content) || !isDeepStrictEqual(message.content, step.parts) ||
          !usageMatches ||
          (step.end?.messageId !== undefined && step.end.messageId !== meta?.messageId) || toolCalls.length !== step.calls.length) {
        throw new ExperimentFailure(Code.Protocol, "Kimi assistant message does not match its loop step content, usage, or calls");
      }
      for (const [callIndex, call] of step.calls.entries()) {
        const native = kimiObject(toolCalls[callIndex]);
        // The wire carries `arguments` as a JSON string always; an absent or
        // non-string field is a protocol break, not malformed arguments
        // (review round 43: `String(undefined)` matched stdout "undefined").
        if (typeof native?.arguments !== "string") {
          throw new ExperimentFailure(Code.Protocol, "Kimi assistant native tool call carries no string arguments field");
        }
        let input: unknown, parseError: string | null = null;
        try { input = JSON.parse(native.arguments); } catch (error) { parseError = error instanceof Error ? error.message : String(error); }
        // Native arguments Kimi itself could not parse match the `{}` it
        // recorded only when Kimi also rejected the call (harnessRejectedArgs);
        // unparseable arguments on a call Kimi ran are still a mismatch.
        const rejectedMalformed = parseError !== null && call.harnessRejectedArgs === true;
        if (native?.type !== "function" || native.id !== call.callId || native.name !== call.qualified ||
            (!rejectedMalformed && !isDeepStrictEqual(input, call.input))) {
          throw new ExperimentFailure(Code.Protocol, "Kimi assistant native tool call does not match tool.call evidence");
        }
        // Every harness-rejected call keeps its raw argument string for the
        // stdout comparison, parseable or not (round 34, contracts 1); only
        // the unparseable case is recorded as malformed.
        if (call.harnessRejectedArgs) call.nativeArguments = String(native.arguments);
        if (rejectedMalformed) {
          this.record("native_arguments_malformed", { call_id: call.callId, name: call.qualified,
            bytes: Buffer.byteLength(call.nativeArguments!), parse_error: parseError });
        }
      }
    }
    this.verified = completed;
  }
}

// Kimi Code 2.3.2 agent/tools, feature contributions, and human/media/tool.ts.
const KIMI_BUILTIN_TOOLS = new Set(["Agent", "AskUserQuestion", "Bash", "Edit", "FetchURL", "Glob", "Grep", "Read",
  "ReadMediaFile", "TaskList", "TaskOutput", "TaskStop", "WaitFor", "WebSearch", "Write", "select_tools", "EnterPlanMode",
  "ExitPlanMode", "TodoList", "NotifyUser", "Skill", "AgentSwarm", "CronCreate", "CronList", "CronDelete", "CreateGoal",
  "GetGoal", "SetGoalBudget", "UpdateGoal", "TowerInit", "TowerPlan", "TowerSpawn", "TowerMerge", "TowerRebase",
  "TowerTeardown", "TowerComplete", "TowerSend", "TowerInbox", "TowerFinding", "TowerReview", "TowerMission", "TowerStatus"]);

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ExperimentFailure(Code.Protocol, "Kimi wire time must be Unix epoch milliseconds");
  return value / 1000;
}

// Kimi Code 2.5.0 declares `inputCacheRead` optional in its own usage
// schema and leaves it out when nothing was read from cache; its own
// token total counts the absent field as zero. So does this: a 2.5.0
// experiment whose first request read no cache failed here with
// "Invalid Kimi usage inputCacheRead" (live gate, 2026-11-06). A field
// that is present is still validated, and the other three stay required.
function normalizedUsage(value: unknown): ExperimentUsage {
  const reported = kimiObject(value);
  const usage = reported && reported.inputCacheRead === undefined ? { ...reported, inputCacheRead: 0 } : reported;
  for (const key of ["inputOther", "output", "inputCacheRead", "inputCacheCreation"]) {
    if (!usage || !Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new ExperimentFailure(Code.Protocol, `Invalid Kimi usage ${key}`);
  }
  return { input: usage!.inputOther, output: usage!.output, cache_read: usage!.inputCacheRead, cache_write: usage!.inputCacheCreation };
}
