import { isDeepStrictEqual } from "node:util";
import { relative, sep } from "node:path";
import { assertKimiResult, kimiContentParts, kimiObject, kimiOutputParts, kimiStatusParts, kimiWithoutHeader } from "./experiment-kimi-content.js";
import { KimiWireParser, type KimiAssistantFrame, type KimiNativeCall } from "./experiment-kimi-parser.js";
import { KimiWireCursor } from "./experiment-kimi-wire.js";
import { ExperimentFailure, ExperimentFailureCode as Code, experimentFailure, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import type { JsonObject } from "./experiment-server.js";
import { parseKimiStreamLine } from "./session/kimi-session.js";

export { kimiToolName } from "./experiment-kimi-content.js";
export interface KimiEvidenceRelay {
  spec: { name: string; accept_harness_prefix?: string[] };
  toolNames: ReadonlySet<string>;
  toolDefinitions: readonly JsonObject[] | undefined;
  calls: ExperimentRelayCall[];
  record: ExperimentRecord;
}
interface EvidenceOptions { kimiHome: string; onFailure?: (error: Error) => void; callIdTimeoutMs?: number }
const WIRE_POLL_MS = 250;
const CALL_ID_TIMEOUT_MS = 5000;

export class ExperimentKimiEvidence {
  private readonly parser: KimiWireParser;
  private readonly cursor: KimiWireCursor;
  private timer?: ReturnType<typeof setInterval>;
  private waiters = new Set<() => void>();
  private stdoutResults = new Map<string, string>();
  private stdoutCalls = new Map<string, { name: string; input: unknown }>();
  private stdoutAssistants: KimiAssistantFrame[] = [];
  private identified = new Map<number, KimiNativeCall>();
  private matchedNativeIds = new Set<string>();
  private sessionId?: string;
  private finished = false;
  private liveError?: ExperimentFailure;
  private finishError?: ExperimentFailure;

  constructor(private readonly relay: KimiEvidenceRelay, private readonly options: EvidenceOptions) {
    this.parser = new KimiWireParser(relay.spec.name, () => relay.toolNames, relay.record, () => relay.toolDefinitions);
    this.cursor = new KimiWireCursor(options.kimiHome, (line) => this.parser.accept(line));
    this.poll();
    if (!this.liveError) { this.timer = setInterval(() => this.poll(), WIRE_POLL_MS); this.timer.unref(); }
  }

  get wireLogPath(): string | undefined { return this.cursor.path; }

  accept(frame: unknown): void {
    if (this.sessionId !== undefined) {
      throw new ExperimentFailure(Code.Protocol, "Kimi stream-json frame followed terminal session.resume_hint");
    }
    const event = kimiObject(frame);
    if (!event) throw new ExperimentFailure(Code.Protocol, "Kimi stream-json frame must be an object");
    const parsed = parseKimiStreamLine(JSON.stringify(event), { knownSessionId: this.sessionId ?? null });
    if (parsed.kind === "grammar_error") throw new ExperimentFailure(Code.Protocol, `Kimi stream-json: ${parsed.message}`);
    if (parsed.kind === "resume_hint") {
      this.sessionId = parsed.sessionId;
    } else if (parsed.kind === "tool_result") {
      this.relay.record("harness_tool_result", { tool_call_id: event.tool_call_id, call_id: event.tool_call_id, content: event.content, item: event });
      if (typeof event.tool_call_id !== "string" || !event.tool_call_id.trim() || typeof event.content !== "string" || this.stdoutResults.has(event.tool_call_id)) {
        throw new ExperimentFailure(Code.Protocol, "Duplicate or malformed Kimi stdout tool result");
      }
      this.stdoutResults.set(event.tool_call_id, event.content);
    } else if (parsed.kind === "assistant") {
      for (const call of parsed.toolCalls) {
        if (!this.parser.names().has(call.name)) throw new ExperimentFailure(Code.UnknownTool, "Kimi stdout called a tool outside the experiment set");
        if (this.stdoutCalls.has(call.callId)) throw new ExperimentFailure(Code.Protocol, "Duplicate Kimi stdout assistant tool call ID");
        this.stdoutCalls.set(call.callId, { name: call.name, input: call.input });
      }
      this.stdoutAssistants.push({ text: parsed.text ?? "", callIds: parsed.toolCalls.map((call) => call.callId) });
    } else if (event.type === "error" || event.role === "error") {
      throw new ExperimentFailure(Code.Protocol, `Kimi stream-json reported an error: ${String(event.message ?? event.error ?? "unknown")}`);
    }
  }

  resolveCallId(call: ExperimentRelayCall): Promise<string> {
    const deadline = this.options.callIdTimeoutMs ?? CALL_ID_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: ExperimentFailure, id?: string) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error); else resolve(id!);
      };
      const check = () => {
        if (this.liveError || this.finishError) { settle(this.liveError ?? this.finishError); return; }
        if (this.finished) { settle(new ExperimentFailure(Code.CallIdUnresolved, "Kimi evidence closed before native call ID resolution")); return; }
        try {
          const native = this.matchCall(call);
          if (native) settle(undefined, native.callId);
        } catch (error) { settle(experimentFailure(error)); }
      };
      this.waiters.add(check);
      timer = setTimeout(() => settle(new ExperimentFailure(Code.CallIdUnresolved,
        `Kimi native call ID unresolved for relay call ${call.relay_index} after ${deadline} ms`)), deadline);
      check();
    });
  }

  private matchCall(call: ExperimentRelayCall): KimiNativeCall | undefined {
    const identified = this.identified.get(call.relay_index);
    if (identified) return identified;
    if (this.relay.calls.some((other) => other !== call &&
        (other.call_id === undefined || other.result === undefined) &&
        call.name === other.name && isDeepStrictEqual(call.input, other.input))) {
      throw new ExperimentFailure(Code.CallIdUnresolved,
        "Kimi cannot carry identical concurrent calls because its MCP requests have no native call ID");
    }
    const matches = this.parser.calls.filter((candidate) => !this.matchedNativeIds.has(candidate.callId) &&
      call.name === candidate.name && isDeepStrictEqual(call.input, candidate.input));
    if (matches.length > 1) throw new ExperimentFailure(Code.CallIdUnresolved,
      "Kimi cannot carry identical concurrent calls because its MCP requests have no native call ID");
    const native = matches[0];
    if (native) {
      this.relay.record("tool_call_identified", { relay_index: call.relay_index, call_id: native.callId, name: call.name, input: call.input });
      this.identified.set(call.relay_index, native);
      this.matchedNativeIds.add(native.callId);
    }
    return native;
  }

  private poll(): void {
    if (this.finished || this.liveError) return;
    try { this.cursor.poll(); }
    catch (error) {
      this.liveError = experimentFailure(error);
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.options.onFailure?.(this.liveError);
    }
    for (const notify of [...this.waiters]) notify();
  }

  finish(path?: string, options?: { timedOut?: boolean }): void {
    if (this.finished) { if (this.finishError ?? this.liveError) throw this.finishError ?? this.liveError; return; }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      if (this.liveError) throw this.liveError;
      if (!this.relay.spec.accept_harness_prefix?.includes("kimi-wall-time")) {
        throw new ExperimentFailure(Code.Protocol, 'Kimi experiment MCP requires accept_harness_prefix: ["kimi-wall-time"]');
      }
      const wirePath = this.cursor.finish(path);
      const sessionDirectory = this.sessionId?.startsWith("session_") ? this.sessionId : `session_${this.sessionId}`;
      const segments = relative(this.options.kimiHome, wirePath).split(sep);
      if (this.sessionId && !isDeepStrictEqual(segments, ["sessions", segments[1], sessionDirectory, "agents", "main", "wire.jsonl"])) {
        throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi stdout session ID does not match the discovered wire log");
      }
      this.relay.record("harness_wire_log", { path: wirePath, session_id: this.sessionId ?? null });
      this.parser.finish(options);
      this.verifyResults();
    } catch (error) { this.finishError = experimentFailure(error); throw this.finishError; }
    finally { this.finished = true; for (const notify of [...this.waiters]) notify(); }
  }

  private verifyResults(): void {
    if (this.stdoutCalls.size !== this.parser.calls.length || this.parser.calls.some((native) => {
      const stdout = this.stdoutCalls.get(native.callId);
      return !stdout || stdout.name !== native.qualified || !isDeepStrictEqual(stdout.input, native.input);
    })) {
      throw new ExperimentFailure(Code.Protocol, "Kimi stdout assistant tool calls do not match wire tool.call IDs, names, and arguments");
    }
    if (!isDeepStrictEqual(this.stdoutAssistants, this.parser.assistantFrames())) {
      throw new ExperimentFailure(Code.Protocol, "Kimi stdout assistant text and calls do not match the same wire steps");
    }
    if (this.parser.calls.length !== this.relay.calls.length || this.stdoutResults.size !== this.relay.calls.length) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Kimi wire, stdout, and relay call counts do not agree");
    }
    let changed = false;
    for (const [index, call] of this.relay.calls.entries()) {
      const native = this.matchCall(call);
      if (call.relay_index !== index || !native || call.name !== native.name || !isDeepStrictEqual(call.input, native.input) || (call.call_id !== undefined && call.call_id !== native.callId)) {
        throw new ExperimentFailure(Code.CallIdUnresolved, `Kimi wire does not match relay call ${index} by native ID, name, and arguments`);
      }
      assertKimiResult(call.result);
      if (!native.result || native.content === undefined || !this.stdoutResults.has(native.callId)) {
        throw new ExperimentFailure(Code.HarnessLogMissing, `Missing Kimi delivery, model, or stdout evidence for ${native.callId}`);
      }
      const expected = kimiContentParts(call.result.content, native.qualified);
      const stdout = typeof native.result.output === "string" ? native.result.output : JSON.stringify(native.result.output);
      const equal = isDeepStrictEqual(kimiWithoutHeader(native.content, native.header ?? null), kimiStatusParts(expected, call.result.isError === true)) &&
        isDeepStrictEqual(expected, native.wireContent) && isDeepStrictEqual(kimiOutputParts(native.result.output), native.wireContent) &&
        stdout === this.stdoutResults.get(native.callId) && (call.result.isError === true) === (native.result.isError === true);
      this.relay.record("result_comparison", { call_id: native.callId, relay_index: index, equal,
        harness_prefix: "kimi-wall-time", header: native.header ?? null });
      changed ||= !equal;
    }
    if (changed) throw new ExperimentFailure(Code.ResultChanged, "Kimi model, loop, or stdout result changed or truncated the experiment server result");
  }

  stop(message = "interrupted before verification"): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const interrupted = !this.finished && !this.liveError;
    if (!this.finished) {
      this.finishError ??= this.liveError ?? new ExperimentFailure(Code.Protocol, message);
    }
    this.finished = true;
    if (interrupted) this.options.onFailure?.(this.finishError!);
    for (const notify of [...this.waiters]) notify();
  }
}
