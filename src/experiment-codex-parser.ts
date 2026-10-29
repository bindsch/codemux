import { isDeepStrictEqual } from "node:util";
import { object } from "./experiment-codex-content.js";
import { assertCodexToolDefinition } from "./experiment-codex-catalog.js";
import { sanitizeCodexToolName as sanitize } from "./experiment-tool-names.js";
import { ExperimentFailure, ExperimentFailureCode as Code, turnRecord, turnUsageRecord, turnCallRecord, toolResultDeliveredRecord,
  type ExperimentRecord, type ExperimentUsage } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

// Exact declaration identities observed in Codex 0.165.0. Sources: docs/experiment-codex-catalog.md.
const CODEX_BUILTIN_DECLARATIONS: ReadonlySet<string> = new Set([
  "functions.list_mcp_resources:function",
  "functions.list_mcp_resource_templates:function",
  "functions.read_mcp_resource:function",
  "functions.request_user_input:function",
  "functions.request_user_input_async:function",
  "functions.apply_patch:custom",
  "clock.curr_time:function",
  "clock.sleep:function",
  "collaboration.followup_task:function",
  "collaboration.interrupt_agent:function",
  "collaboration.list_agents:function",
  "collaboration.send_message:function",
  "collaboration.spawn_agent:function",
  "collaboration.wait_agent:function",
]);
// Codex rust-v0.165.0: core/src/tools/spec_plan.rs, app-server/src/extensions.rs, and their native tool contributors.
// Keep namespace-only tools qualified so unrelated invented names can still fail natively.
const CODEX_RESTRICTED_TOOLS: ReadonlySet<string> = new Set([
  "update_plan", "plan", "exec_command", "write_stdin", "apply_patch",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "wait_for_environment", "request_user_input", "request_user_input_async", "send_message_to_user_async",
  "request_permissions", "new_context", "get_context_remaining", "test_sync_tool", "view_image",
  "list_available_plugins_to_install", "request_plugin_install", "tool_search", "tool_search_tool", "exec", "wait",
  "spawn_agent", "send_input", "resume_agent", "close_agent", "send_message", "followup_task", "wait_agent",
  "interrupt_agent", "list_agents", "web_search", "clock.curr_time", "clock.sleep", "web.run", "image_gen.imagegen",
  "get_goal", "create_goal", "update_goal", "multi_env_copy_file",
  "create_channel", "get_channels", "list_threads", "search_posts", "read_thread", "read_post", "subscribe", "unsubscribe", "post",
  "history.list_windows", "history.list_items", "history.read_item", "history.search_contents",
  "notes.list_files_by_prefix", "notes.read_file", "notes.search_contents", "notes.append_to_file", "notes.write_file",
  "memories.add_ad_hoc_note", "memories.list", "memories.read", "memories.search",
  "skills.list", "skills.read", "skills.installations", "user_message.search_messages", "user_message.read_messages",
]);

function restrictedCodexTool(call: JsonObject): boolean {
  const name = typeof call.name === "string" ? call.name.replace(/^functions\./u, "") : "";
  const namespace = call.namespace && call.namespace !== "functions" ? call.namespace : undefined;
  const qualified = namespace ? `${namespace}.${name}` : name;
  if (CODEX_RESTRICTED_TOOLS.has(name.split(".").at(-1)!) || CODEX_RESTRICTED_TOOLS.has(qualified)) return true;
  // protocol/src/mcp.rs recognizes these browser/computer actor namespaces and flat aliases.
  if (namespace) return /^(?:mcp__)?(?:node_repl|cua_repl)(?:__)?$/u.test(namespace);
  return /^(?:mcp__)?(?:node_repl|cua_repl)(?:(?:__)?\.|__)/u.test(name);
}

export interface CodexNativeCall {
  callId: string; name: string; input: unknown; item: JsonObject;
  output?: { value: unknown; item: JsonObject };
}
interface PendingTurn {
  messageId?: string; functionId?: string; turnId?: string; messageSeen?: boolean; functionSeen?: boolean;
  responseId?: string; responseUsage?: ExperimentUsage;
  calls: { call: CodexNativeCall; t: number }[];
}

/** Native items, normalized records, and call lookup share this parser for the whole run. */
export class CodexRolloutParser {
  readonly calls: CodexNativeCall[] = [];
  private modelErrors: CodexNativeCall[] = [];
  private byId = new Map<string, CodexNativeCall>();
  private declaredBuiltins = new Set<string>();
  private pending?: PendingTurn;
  private lastCompleted?: { responseId: string; counters: JsonObject; totals: unknown };
  private responseIds = new Set<string>();
  private turnIds = new Set<string>();
  private catalogSeen = false;
  private turns = 0;
  private usageRecords = 0;

  constructor(private readonly threadId: string, private readonly server: string,
    private readonly toolNames: () => ReadonlySet<string>, private readonly record: ExperimentRecord,
    private readonly toolDefinitions: () => readonly JsonObject[] | undefined,
    private readonly beforeFunctionCall?: () => void,
    private readonly onCall?: (call: CodexNativeCall, index: number) => void) {}

  accept(line: JsonObject): void {
    const payload = line.payload as JsonObject;
    const t = Date.parse(line.timestamp) / 1000;
    if (line.type === "token_usage_record") {
      if (payload.thread_id !== this.threadId || typeof payload.response_id !== "string" || !payload.response_id) {
        throw new ExperimentFailure(Code.Protocol, "Invalid Codex token_usage_record response identity");
      }
      if (this.responseIds.has(payload.response_id)) {
        throw new ExperimentFailure(Code.HarnessLogMissing, `Codex rollout repeats response usage ${payload.response_id}`);
      }
      if (this.pending?.responseId) throw new ExperimentFailure(Code.HarnessLogMissing,
        `Codex response ${payload.response_id} overlaps ${this.pending.responseId} before its token_count usage event`);
      const usage = normalizedUsage(payload.usage);
      this.responseIds.add(payload.response_id);
      this.pending ??= { calls: [] };
      this.pending.responseId = payload.response_id;
      this.pending.responseUsage = usage;
    }
    if (line.type === "event_msg" && payload.type === "token_count" && object(payload.info)?.last_token_usage) {
      const pending = this.pending;
      const usage = normalizedUsage(payload.info.last_token_usage);
      const newResponse = pending?.responseId !== undefined && pending.responseId !== this.lastCompleted?.responseId &&
        pending.responseUsage !== undefined && sameUsage(pending.responseUsage, usage);
      if (!newResponse && this.lastCompleted && isDeepStrictEqual(this.lastCompleted.counters, payload.info.last_token_usage)) {
        if (isDeepStrictEqual(this.lastCompleted.totals, payload.info.total_token_usage)) {
          this.record("harness_retry", { response_id: this.lastCompleted.responseId, t, item: payload });
          return;
        }
        if (!cumulativeUsageAdvanced(this.lastCompleted.totals, payload.info.total_token_usage)) {
          throw new ExperimentFailure(Code.HarnessLogMissing, "Codex token_count cumulative usage conflicts with the last completed response");
        }
      }
      if (!pending) {
        throw new ExperimentFailure(Code.HarnessLogMissing, "Codex token_count usage without a pending response conflicts with the last completed response");
      }
      if (pending.responseUsage && !sameUsage(pending.responseUsage, usage)) {
        throw new ExperimentFailure(Code.HarnessLogMissing, `Codex token_count conflicts with response usage ${pending.responseId}`);
      }
      const id = pending.turnId;
      if (!id) throw new ExperimentFailure(Code.MessageIdMissing, "Codex response has no native message or function_call item id");
      this.record("turn_usage", turnUsageRecord(id, usage, t));
      this.usageRecords++;
      this.lastCompleted = pending.responseId
        ? { responseId: pending.responseId, counters: payload.info.last_token_usage, totals: payload.info.total_token_usage } : undefined;
      this.pending = undefined;
    }
    if (line.type !== "response_item") return;
    if (payload.type === "additional_tools") { this.acceptCatalog(payload); return; }
    if ((payload.type === "message" && payload.role === "assistant") || payload.type === "reasoning" ||
        payload.type === "function_call" || payload.type === "custom_tool_call") {
      this.pending ??= { calls: [] };
      if (payload.type === "message" && !this.pending.messageSeen) {
        this.pending.messageSeen = true;
        if (typeof payload.id === "string" && payload.id) this.pending.messageId = payload.id;
        this.emitTurn(t);
      }
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      if (!this.catalogSeen) throw new ExperimentFailure(Code.InventoryMismatch,
        "Codex function_call precedes a complete additional_tools catalog");
      this.beforeFunctionCall?.(); this.acceptCall(payload, t);
    }
    else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      this.record("model_tool_result", { call_id: payload.call_id, output: payload.output, item: payload });
      const call = this.byId.get(payload.call_id);
      if (!call || call.output) throw new ExperimentFailure(Code.Protocol, `Unmatched or duplicate Codex function_call_output ${String(payload.call_id)}`);
      const expectedType = call.item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output";
      if (payload.type !== expectedType) throw new ExperimentFailure(Code.Protocol, "Codex tool output type does not match its call");
      if (this.modelErrors.includes(call)) {
        const text = typeof payload.output === "string" ? payload.output : Array.isArray(payload.output) &&
          payload.output.every((part: unknown) => object(part)?.type === "input_text" && typeof object(part)?.text === "string")
          ? payload.output.map((part: JsonObject) => part.text).join("") : undefined;
        const prefix = call.item.type === "custom_tool_call" ? "unsupported custom tool call: " : "unsupported call: ";
        // ToolName::Display drops the default namespace and concatenates other namespaces.
        const namespace = call.item.namespace;
        const nativeName = namespace && namespace !== "functions" ? namespace + call.item.name : call.item.name;
        if (text !== prefix + nativeName) this.refuseTool(call.item);
        this.record("model_tool_error", { call_id: call.callId, name: call.name, input: call.input, harness_output: payload.output });
      }
      call.output = { value: payload.output, item: payload };
      this.record("tool_result_delivered", toolResultDeliveredRecord(call.callId, t));
    } else if (typeof payload.type === "string" && payload.type.endsWith("_call")) {
      this.record("tool_call", { ...payload, allowed: false });
      this.refuseTool(payload);
    }
  }

  finish(options?: { timedOut?: boolean }): void {
    for (const call of this.modelErrors) if (!call.output) this.refuseTool(call.item);
    if (!options?.timedOut && this.pending) throw new ExperimentFailure(Code.HarnessLogMissing, "Codex rollout is missing a following token_count usage event");
    if (!options?.timedOut && this.usageRecords !== this.turns) throw new ExperimentFailure(Code.HarnessLogMissing, "Codex rollout is missing normalized turn usage");
    if (this.turns === 0) throw new ExperimentFailure(Code.HarnessLogMissing, "Codex rollout has no completed response evidence");
  }

  private emitTurn(t: number): boolean {
    const pending = this.pending!;
    const id = pending.messageId ?? pending.functionId;
    if (pending.turnId || !id) return false;
    if (this.turnIds.has(id)) throw new ExperimentFailure(Code.HarnessLogMissing, `Codex rollout repeats native turn ID ${id}`);
    this.turnIds.add(id);
    pending.turnId = id;
    this.record("turn", turnRecord(id, t, null, pending.calls.map(({ call }) => ({ call_id: call.callId, name: call.name }))));
    this.turns++;
    for (const { call, t: callTime } of pending.calls) this.record("turn_call", turnCallRecord(id, call.callId, call.name, callTime));
    return true;
  }

  private acceptCatalog(payload: JsonObject): void {
    const declarations: JsonObject[] = [];
    const experimentNames = new Set<string>();
    const builtinNames = new Set<string>();
    try {
      if (!Array.isArray(payload.tools)) throw new ExperimentFailure(Code.InventoryMismatch, "Invalid Codex additional_tools catalog");
      for (const value of payload.tools) {
        const declaration = object(value);
        let namespace: string | undefined;
        let tools: unknown[] = [value];
        if (declaration?.type === "namespace") {
          if (typeof declaration.name !== "string" || !declaration.name || !Array.isArray(declaration.tools)) {
            throw new ExperimentFailure(Code.InventoryMismatch, "Invalid Codex additional_tools namespace");
          }
          namespace = declaration.name;
          tools = declaration.tools;
        }
        for (const value of tools) {
          const tool = object(value);
          const identity = `${namespace}.${tool?.name}:${tool?.type}`;
          const builtin = tool && CODEX_BUILTIN_DECLARATIONS.has(identity);
          if (builtin) this.declaredBuiltins.add(JSON.stringify([namespace ?? "functions", tool.name]));
          const name = tool?.type === "function" ? this.bareName({ ...tool, namespace }) : undefined;
          const classification = builtin ? "builtin" : name !== undefined ? "experiment" : "foreign";
          const entry: JsonObject = { namespace: namespace ?? null, name: tool?.name ?? null, type: tool?.type ?? null, classification };
          declarations.push(entry);
          if (classification === "foreign") {
            const name = String(tool?.name ?? tool?.type ?? "invalid declaration");
            throw new ExperimentFailure(Code.InventoryMismatch,
              `Codex additional_tools contains a tool outside the experiment set: ${namespace ? `${namespace}.` : ""}${name}`);
          }
          const seen = builtin ? builtinNames : experimentNames;
          const key = builtin ? identity : name!;
          if (seen.has(key)) throw new ExperimentFailure(Code.InventoryMismatch,
            `Codex additional_tools repeats a declaration: ${key}`);
          if (!builtin) entry.catalog_pruned_paths = assertCodexToolDefinition(tool!, name!, this.toolDefinitions());
          seen.add(key);
        }
      }
      const missing = [...this.toolNames()].filter((name) => !experimentNames.has(name));
      if (missing.length) throw new ExperimentFailure(Code.InventoryMismatch,
        `Codex additional_tools omits experiment tools: ${missing.join(", ")}`);
      this.catalogSeen = true;
    } finally {
      this.record("harness_tool_catalog", { tools: payload.tools, item: payload, declarations });
    }
  }

  private acceptCall(payload: JsonObject, t: number): void {
    if (payload.namespace !== undefined && payload.namespace !== null && typeof payload.namespace !== "string") {
      throw new ExperimentFailure(Code.Protocol, "Invalid Codex tool call namespace");
    }
    if (payload.type === "function_call" && typeof payload.arguments !== "string") {
      throw new ExperimentFailure(Code.Protocol, "Invalid Codex function_call arguments");
    }
    if (payload.type === "custom_tool_call" && this.bareName(payload) !== undefined) this.refuseTool(payload);
    const name = payload.type === "function_call" ? this.bareName(payload) : undefined;
    let input: unknown;
    let invalidArguments = false;
    try { input = payload.type === "custom_tool_call" ? payload.input : JSON.parse(payload.arguments); }
    catch { invalidArguments = true; input = payload.arguments; }
    this.record(name === undefined ? "tool_call" : "harness_tool_call", { call_id: payload.call_id, name: payload.name,
      ...(payload.namespace === undefined ? {} : { namespace: payload.namespace }), input, allowed: name !== undefined, item: payload });
    const qualified = payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name;
    if (name === undefined && (typeof payload.name !== "string" || !payload.name ||
        typeof payload.call_id !== "string" || !payload.call_id ||
        restrictedCodexTool(payload) || this.declaredBuiltins.has(JSON.stringify([payload.namespace || "functions", payload.name])))) this.refuseTool(payload);
    if (payload.type === "custom_tool_call" && typeof input !== "string") {
      throw new ExperimentFailure(Code.Protocol, "Invalid Codex custom_tool_call input");
    }
    if (input === undefined) throw new ExperimentFailure(Code.Protocol, "Missing Codex tool call input");
    if ((invalidArguments || !object(input)) && name !== undefined) {
      throw new ExperimentFailure(Code.Protocol, `Invalid Codex function_call arguments for ${String(payload.call_id)}`);
    }
    if (typeof payload.call_id !== "string" || !payload.call_id || this.byId.has(payload.call_id)) {
      throw new ExperimentFailure(Code.Protocol, "Duplicate or missing Codex function_call call_id");
    }
    const call: CodexNativeCall = { callId: payload.call_id, name: name ?? qualified, input, item: payload };
    if (name === undefined) this.modelErrors.push(call); else this.calls.push(call);
    this.byId.set(call.callId, call);
    if (!this.pending!.functionSeen) {
      this.pending!.functionSeen = true;
      if (typeof payload.id === "string" && payload.id) this.pending!.functionId = payload.id;
    }
    this.pending!.calls.push({ call, t });
    if (!this.emitTurn(t) && this.pending!.turnId) {
      this.record("turn_call", turnCallRecord(this.pending!.turnId, call.callId, call.name, t));
    }
    if (name !== undefined) this.onCall?.(call, this.calls.length - 1);
  }

  private bareName(call: JsonObject): string | undefined {
    const names = new Map<string, string>();
    for (const name of this.toolNames()) {
      const sanitized = sanitize(name);
      if (names.has(sanitized)) throw new ExperimentFailure(Code.InventoryMismatch, `Codex experiment tool name sanitizer collision for ${name}`);
      names.set(sanitized, name);
    }
    const server = sanitize(this.server);
    const namespace = server.startsWith("mcp__") ? server : `mcp__${server}`;
    if (call.namespace === namespace) return names.get(call.name);
    if (call.namespace !== undefined && call.namespace !== null && call.namespace !== "" && call.namespace !== "functions") return undefined;
    if (typeof call.name === "string" && call.name.startsWith(`${namespace}__`)) return names.get(call.name.slice(namespace.length + 2));
    return undefined;
  }

  private refuseTool(call: JsonObject): never {
    const name = typeof call.name === "string" && call.name ? call.name : call.type;
    const baseName = name.split(".").at(-1);
    const qualified = call.namespace ? `${call.namespace}.${name}` : name;
    if (call.type === "tool_search_call" || baseName === "tool_search" || baseName === "tool_search_tool") {
      throw new ExperimentFailure(Code.UnknownTool,
        "Codex offered its tool search instead of the experiment tools; " +
        "the experiment server table omits the deferred surface, so this means the exposure policy changed: " + qualified);
    }
    throw new ExperimentFailure(Code.UnknownTool, `Codex called a tool outside the experiment set: ${qualified}`);
  }
}

function cumulativeUsageAdvanced(previous: unknown, current: unknown): boolean {
  const before = object(previous);
  const after = object(current);
  if (!before || !after || !Object.keys(before).length) return false;
  let advanced = false;
  for (const [key, value] of Object.entries(before)) {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(after[key]) || after[key] < value) return false;
    advanced ||= after[key] > value;
  }
  return advanced;
}

function sameUsage(left: ExperimentUsage, right: ExperimentUsage): boolean {
  return left.input === right.input && left.output === right.output &&
    left.cache_read === right.cache_read && left.cache_write === right.cache_write;
}

function normalizedUsage(value: unknown): ExperimentUsage {
  const usage = object(value);
  if (!usage) throw new ExperimentFailure(Code.Protocol, "Invalid Codex token_count last_token_usage");
  for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens"]) {
    if (key === "cache_write_input_tokens" && usage[key] === undefined) continue;
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new ExperimentFailure(Code.Protocol, `Invalid Codex token_count ${key}`);
  }
  if (usage.cached_input_tokens > usage.input_tokens) throw new ExperimentFailure(Code.Protocol, "Codex cached_input_tokens exceeds input_tokens");
  return { input: Math.max(0, usage.input_tokens - usage.cached_input_tokens - (usage.cache_write_input_tokens ?? 0)), output: usage.output_tokens,
    cache_read: usage.cached_input_tokens, cache_write: usage.cache_write_input_tokens ?? 0 };
}
