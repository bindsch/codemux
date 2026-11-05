import { isDeepStrictEqual } from "node:util";
import { assertCodexResult, compareCodexOutput, object } from "./experiment-codex-content.js";
import { CodexRolloutCursor, findRollout } from "./experiment-codex-rollout.js";
import { CodexRolloutParser, type CodexNativeCall } from "./experiment-codex-parser.js";
import { isCodexResourceRefusal, matchesCodexResourceResult } from "./experiment-codex-resource.js";
import { ExperimentFailure, ExperimentFailureCode as Code, experimentFailure, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";

export const ROLLOUT_POLL_MS = 250;
const CALL_ID_TIMEOUT_MS = 5000;

export interface CodexEvidenceRelay {
  spec: { name: string; accept_harness_prefix?: string[] };
  toolNames: ReadonlySet<string>;
  readonly toolDefinitions: readonly JsonObject[] | undefined;
  calls: ExperimentRelayCall[];
  record: ExperimentRecord;
  readonly catalogServed?: boolean;
}
interface EvidenceOptions {
  codexHome?: string;
  callIdTimeoutMs?: number;
  onFailure?: (error: ExperimentFailure) => void;
  catalogRequired?: boolean;
}

/** Exec observations and a live rollout cursor verify the persisted model context. */
export class ExperimentCodexEvidence {
  private threadId?: string;
  private execResults: JsonObject[] = [];
  private finished = false;
  private finishError?: ExperimentFailure;
  private liveError?: ExperimentFailure;
  private cursor?: CodexRolloutCursor;
  private parser?: CodexRolloutParser;
  private timer?: ReturnType<typeof setInterval>;
  private waiters = new Set<() => void>();
  private requestIds = new Map<number, string>();

  constructor(private readonly relay: CodexEvidenceRelay, private readonly options: EvidenceOptions = {}) {}

  get hasThread(): boolean { return this.threadId !== undefined; }
  get rolloutPath(): string | undefined {
    return this.cursor?.path ?? (this.options.codexHome
      ? findRollout(this.options.codexHome, this.threadId, false) : undefined);
  }

  accept(event: unknown): void {
    if (this.finished) throw new ExperimentFailure(Code.Protocol, "Codex experiment evidence is already finalized");
    if (this.liveError) throw this.liveError;
    const frame = object(event);
    if (!frame) return;
    if (frame.type === "thread.started") {
      if (typeof frame.thread_id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(frame.thread_id)) throw new ExperimentFailure(Code.Protocol, "Invalid Codex exec thread id");
      if (this.threadId && this.threadId !== frame.thread_id) throw new ExperimentFailure(Code.Protocol, "Codex exec reported conflicting thread ids");
      this.threadId = frame.thread_id;
      if (this.options.codexHome && !this.cursor) {
        this.initialize(this.options.codexHome);
        this.poll();
        if (!this.liveError) {
          this.timer = setInterval(() => this.poll(), ROLLOUT_POLL_MS);
          this.timer.unref();
        }
      }
    } else if (frame.type === "item.completed" && object(frame.item)?.type === "mcp_tool_call") {
      this.execResults.push(frame.item);
      const error = frame.item.error;
      const errorText = typeof error === "string" ? error : object(error)?.message;
      this.relay.record("harness_tool_result", { ...frame.item, item: frame.item,
        ...(typeof errorText === "string" ? { error_text: errorText } : {}) });
    } else if (frame.type === "turn.completed") {
      if (!object(frame.usage)) throw new ExperimentFailure(Code.Protocol, "Codex exec turn.completed requires usage");
      this.relay.record("harness_usage", { usage: frame.usage });
    }
  }

  async resolveCallId(call: ExperimentRelayCall, request?: JsonObject): Promise<string> {
    if (this.liveError || this.finishError) throw this.liveError ?? this.finishError;
    if (this.finished) throw new ExperimentFailure(Code.CallIdUnresolved, "Codex evidence closed before native call ID resolution");
    this.assertCatalog();
    const requestId = object(object(request?.params)?._meta)?.callId;
    if (typeof requestId === "string" && requestId.trim()) {
      this.requestIds.set(call.relay_index, requestId);
      call.native_call_id_source = "request_meta";
    }
    const deadline = this.options.callIdTimeoutMs ?? CALL_ID_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: ExperimentFailure, id?: string) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error); else resolve(id!);
      };
      const check = () => {
        if (this.liveError || this.finishError) { settle(this.liveError ?? this.finishError); return; }
        if (this.finished) { settle(new ExperimentFailure(this.parser?.inventoryChecked ? Code.CallIdUnresolved : Code.HarnessLogMissing,
          "Codex evidence closed before top-level inventory and native call ID verification")); return; }
        if (!this.parser?.inventoryChecked) return;
        const native = this.nativeCall(call);
        if (this.requestIds.has(call.relay_index)) {
          try { if (native) this.assertNativeCall(native, call); settle(undefined, this.requestIds.get(call.relay_index)); }
          catch (error) { settle(experimentFailure(error)); }
          return;
        }
        if (native) {
          try { this.assertNativeCall(native, call); settle(undefined, native.callId); }
          catch (error) { settle(experimentFailure(error)); }
        }
      };
      this.waiters.add(check);
      timer = setTimeout(() => settle(new ExperimentFailure(this.parser?.inventoryChecked ? Code.CallIdUnresolved : Code.HarnessLogMissing,
        this.parser?.inventoryChecked ? `Codex native call ID unresolved for relay call ${call.relay_index} after ${deadline} ms`
          : `Codex world_state top_level_tools missing before relay call ${call.relay_index} after ${deadline} ms`)), deadline);
      check();
    });
  }

  private initialize(home: string): void {
    this.parser = new CodexRolloutParser(this.threadId!, this.relay.spec.name, () => this.relay.toolNames,
      (kind, fields) => this.relay.record(kind, fields), () => this.relay.toolDefinitions, () => this.assertCatalog(),
      (call, index) => this.verifyNativeCall(call, index));
    this.cursor = new CodexRolloutCursor(home, this.threadId!, (line) => this.parser!.accept(line));
  }

  private assertCatalog(): void {
    if (this.options.catalogRequired && !this.relay.catalogServed) {
      throw new ExperimentFailure(Code.CodeMode, "Codex did not fetch the experiment catalog before its first function_call");
    }
  }

  private verifyNativeCall(native: CodexNativeCall, index: number): void {
    const identified = this.relay.calls.find((call) => this.nativeId(call) === native.callId);
    const ordered = this.relay.calls[index];
    const call = identified ?? (ordered && this.nativeId(ordered) === undefined ? ordered : undefined);
    if (call) this.assertNativeCall(native, call);
  }

  private nativeId(call: ExperimentRelayCall): string | undefined {
    return this.requestIds.get(call.relay_index) ?? call.call_id;
  }

  private nativeCall(call: ExperimentRelayCall): CodexNativeCall | undefined {
    const id = this.nativeId(call);
    return id === undefined ? this.parser?.calls[call.relay_index]
      : this.parser?.calls.find((native) => native.callId === id);
  }

  private assertNativeCall(native: CodexNativeCall, call: ExperimentRelayCall): void {
    const index = call.relay_index;
    if (this.relay.calls[index] !== call || native.name !== call.name || !isDeepStrictEqual(native.input, call.input)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, `Codex rollout does not match relay call ${index} by native identity, name, and arguments`);
    }
  }

  private poll(): void {
    if (this.liveError || this.finished) return;
    try { this.cursor?.poll(); }
    catch (error) {
      this.liveError = experimentFailure(error);
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.options.onFailure?.(this.liveError);
    }
    for (const notify of [...this.waiters]) notify();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.finished = true;
    for (const notify of [...this.waiters]) notify();
  }

  finish(codexHome: string, options?: { timedOut?: boolean }): void {
    if (this.finished) { if (this.finishError ?? this.liveError) throw this.finishError ?? this.liveError; return; }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      if (this.liveError) throw this.liveError;
      if (!this.threadId) throw new ExperimentFailure(Code.HarnessLogMissing, `Missing Codex exec thread.started; cannot locate rollout under ${codexHome}/sessions`);
      if (!this.relay.spec.accept_harness_prefix?.includes("codex-wall-time")) {
        throw new ExperimentFailure(Code.Protocol, 'Codex experiment MCP requires accept_harness_prefix: ["codex-wall-time"]');
      }
      if (!this.cursor) this.initialize(codexHome);
      const path = this.cursor!.finish();
      this.relay.record("harness_rollout", { path, thread_id: this.threadId });
      if (!this.parser!.inventoryChecked) throw new ExperimentFailure(Code.HarnessLogMissing,
        "Codex rollout is missing world_state top_level_tools");
      this.parser!.finish(options);
      this.verifyCalls(path);
      this.verifyExecResults();
    } catch (error) { this.finishError = experimentFailure(error); throw this.finishError; }
    finally { this.finished = true; for (const notify of [...this.waiters]) notify(); }
  }

  private verifyCalls(path: string): void {
    const calls = this.parser!.calls;
    if (calls.length !== this.relay.calls.length || calls.some((call) => !call.output)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, `Codex rollout ${path} is missing correlated experiment calls or model outputs`);
    }
    let outputError: ExperimentFailure | undefined;
    const matched = new Set<string>();
    for (const call of this.relay.calls) {
      const index = call.relay_index;
      const native = this.nativeCall(call);
      if (!native || matched.has(native.callId)) {
        throw new ExperimentFailure(Code.CallIdUnresolved,
          `Codex relay call ${index} native ID mismatch: request ${this.nativeId(call)}, rollout ${calls.map((entry) => entry.callId).join(", ")}`);
      }
      matched.add(native.callId);
      this.assertNativeCall(native, call);
      assertCodexResult(call.result, `Experiment relay call ${index} result`);
      const comparison = compareCodexOutput(call.result.content, native.output!.value);
      this.relay.record("result_comparison", { call_id: native.callId, relay_index: index,
        equal: comparison.equal, harness_prefix: "codex-wall-time", header: comparison.header });
      if (!comparison.equal) outputError ??= new ExperimentFailure(Code.ResultChanged,
        `Codex model output ${native.callId} has an invalid Wall time header or changed or truncated result`);
    }
    if (outputError) throw outputError;
  }

  private verifyExecResults(): void {
    const remaining = [...this.relay.calls];
    const builtinCalls = [...this.parser!.builtinCalls];
    for (const item of this.execResults) {
      const nativeId = item.call_id ?? item.callId;
      const index = remaining.findIndex((call) => item.server === this.relay.spec.name && item.tool === call.name &&
        (nativeId === undefined || nativeId === this.nativeId(call)) &&
        item.status === (call.result?.isError === true ? "failed" : "completed") &&
        isDeepStrictEqual(item.arguments, call.input) && isDeepStrictEqual(object(item.result)?.content, call.result?.content));
      if (index === -1) {
        const builtin = builtinCalls.findIndex((call) => matchesCodexResourceResult(call, item));
        if (builtin !== -1) { builtinCalls.splice(builtin, 1); continue; }
      }
      if (index === -1 || (item.error != null && item.status !== "failed") || !object(item.result)) {
        throw new ExperimentFailure(Code.ResultChanged, "Codex exec MCP result does not match a completed experiment relay call");
      }
      const [call] = remaining.splice(index, 1);
      assertCodexResult(call!.result, `Experiment relay call ${call!.relay_index} result`);
      for (const key of ["structuredContent", "_meta"]) {
        if (key in item.result) throw new ExperimentFailure(Code.UnsupportedResult, `Codex exec MCP result carrying ${key} is unsupported`);
      }
      if (item.result.structured_content != null) throw new ExperimentFailure(Code.UnsupportedResult, "Codex exec MCP result carrying structured_content is unsupported");
    }
    if (remaining.length !== 0) throw new ExperimentFailure(Code.HarnessLogMissing, `Missing Codex exec MCP results for ${remaining.length} experiment relay calls`);
    // The parser's builtinCalls hold only resource operations (the
    // list/read MCP resource trio), and those emit MCP exec completions
    // without native call ids — the matcher above is the one that pairs
    // them with the exec stream (src/experiment-codex-resource.ts). An
    // entry left over is a rollout call whose exec completion never
    // arrived — the same defect the `remaining` check names for relay
    // calls — unless the harness refused the call outright (the
    // unsupported-call text as its whole output, the saved-rollout
    // shape): nothing executed, so no completion can exist (review
    // round 110).
    const refused = builtinCalls.filter(isCodexResourceRefusal).length;
    if (builtinCalls.length !== refused) throw new ExperimentFailure(Code.HarnessLogMissing,
      `Missing Codex exec MCP results for ${builtinCalls.length - refused} resource builtin calls`);
  }
}
