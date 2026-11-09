import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ExperimentHttpRelay, type ExperimentRelayCall } from "./experiment-relay.js";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import { experimentToolTimeoutSeconds, type ExperimentSpec } from "./experiment-mcp.js";
import { MAX_CAPTURE_BYTES, type StdoutSink } from "./process-runner.js";
import { capturePrefix } from "./experiment-capture.js";
import { readUtf8FileBounded } from "./file-io.js";
import { OpenCodePlainFold } from "./plain-unwrap.js";
import { opencodeEvidenceObject, opencodeExperimentToolName, assertOpencodeExperimentResult, verifyOpencodeProviderPayload } from "./opencode-experiment-content.js";
import { opencodeExperimentPluginSource } from "./opencode-experiment-plugin.js";
import type { JsonObject } from "./experiment-server.js";
import type { RunContext } from "./run-context.js";
import { parseOpenCodeRunLine } from "./session/opencode-session.js";
import type { BaseAdapter } from "./adapters/base.js";
import type { RunRequest, RunResult } from "./types.js";

export const OPENCODE_EXPERIMENT_TOKEN_ENV = "CODEMUX_OPENCODE_EXPERIMENT_TOKEN";
export type OpencodeExperimentContext = RunContext & { experimentOpencode?: OpencodeExperimentRun };
export type OpencodeExperimentRelay = Pick<ExperimentHttpRelay, "token" | "url" | "spec" | "recordingPath" | "calls" | "toolDefinitions" |
  "record" | "failureError" | "resolveCallId" | "validateResult" | "onFailure" | "start" | "finish" | "fail" | "terminateProtocol" | "close" | "closeSync">;
type EvidenceSource = { spec: { name: string }; calls: readonly ExperimentRelayCall[];
  toolDefinitions: readonly JsonObject[] | undefined; record: ExperimentRecord };

/** Host-side verification remains mandatory: native plugin errors can be
 * logged and swallowed, so hook installation alone never establishes success. */
export function verifyOpencodeExperimentEvidence(source: EvidenceSource, records: JsonObject[], stdout: string): string | null {
  if (!source.toolDefinitions?.length) throw new ExperimentFailure(Code.InventoryMismatch, "OpenCode experiment lacks a server inventory");
  const calls = new Map<string, ExperimentRelayCall>();
  for (const call of source.calls) {
    if (!call.call_id || calls.has(call.call_id) || !call.result) throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode relay call is incomplete or repeated");
    calls.set(call.call_id, call);
  }
  const dispatched = new Set<string>(), delivered = new Set<string>(), turns = new Set<string>();
  const acceptedIds = new Set<string>(), modelIds = new Set<string>();
  const servedModels = new Map<string, string | null>();
  const requests = new Map<string, { deliveries: string[]; t: number }>();
  let session: string | undefined;
  const sessionMatches = (id: unknown) => {
    if (typeof id !== "string" || !id || (session !== undefined && id !== session)) {
      throw new ExperimentFailure(Code.Protocol, "OpenCode experiment evidence changed session");
    }
    session ??= id;
  };
  const matchCall = (id: unknown, name: unknown, input: unknown) => {
    const call = typeof id === "string" ? calls.get(id) : undefined;
    if (!call || name !== opencodeExperimentToolName(source.spec.name, call.name) || !isDeepStrictEqual(input, call.input)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode native call identity or arguments differ from the relay");
    }
    return call;
  };
  let accepted = 0;
  for (const record of records) {
    const fields = opencodeEvidenceObject(record.fields);
    if (typeof record.t !== "number" || !Number.isFinite(record.t)) throw new ExperimentFailure(Code.Protocol, "OpenCode evidence lacks a timestamp");
    source.record("opencode_plugin_evidence", { evidence_kind: record.kind, ...fields, t: record.t });
    switch (record.kind) {
      case "model_turn":
        sessionMatches(fields.session_id);
        if (typeof fields.request_id !== "string" || turns.has(fields.request_id) || acceptedIds.has(fields.request_id)) throw new ExperimentFailure(Code.Protocol, "OpenCode repeated a model turn");
        turns.add(fields.request_id);
        break;
      case "tool_call":
        sessionMatches(fields.session_id);
        matchCall(fields.call_id, fields.name, fields.input);
        if (dispatched.has(fields.call_id)) throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode repeated a native call ID");
        dispatched.add(fields.call_id);
        break;
      case "provider_request": {
        if (!turns.has(fields.request_id) || requests.has(fields.request_id)) throw new ExperimentFailure(Code.Protocol, "OpenCode provider request has no unique model turn");
        const ids = verifyOpencodeProviderPayload(source.spec.name, source.toolDefinitions, fields.payload, calls);
        if (ids.some((id) => !dispatched.has(id))) throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode provider result precedes native dispatch");
        requests.set(fields.request_id, { deliveries: ids, t: record.t });
        source.record("tool_inventory", { tools: source.toolDefinitions.map((tool) => opencodeExperimentToolName(source.spec.name, tool.name)), equal: true,
          provider_request_id: fields.request_id });
        break;
      }
      case "provider_response": {
        const request = requests.get(fields.request_id);
        if (!request || !Number.isInteger(fields.status) || fields.status < 0 || fields.status > 599) {
          throw new ExperimentFailure(Code.HarnessLogMissing, "OpenCode provider did not accept the recorded request");
        }
        // Authentication refresh and transport retries reuse the native turn.
        // Only a successful attempt proves delivery; an exhausted turn remains
        // pending and fails the final completeness check.
        if (fields.status < 200 || fields.status >= 300) { requests.delete(fields.request_id); break; }
        requests.delete(fields.request_id); turns.delete(fields.request_id); acceptedIds.add(fields.request_id); accepted++;
        for (const id of request.deliveries) {
          if (!delivered.has(id)) source.record("tool_result_delivered", { call_id: id, t: request.t });
          delivered.add(id);
        }
        break;
      }
      case "provider_model":
        // Provider identity is response evidence only; request.model is never
        // promoted to a served identity. It does not replace result proof.
        if (!acceptedIds.has(fields.request_id) || modelIds.has(fields.request_id) ||
            (fields.served_model !== null && (typeof fields.served_model !== "string" || !fields.served_model))) {
          throw new ExperimentFailure(Code.Protocol, "OpenCode provider model evidence is malformed");
        }
        modelIds.add(fields.request_id);
        servedModels.set(fields.request_id, fields.served_model);
        break;
      default: throw new ExperimentFailure(Code.Protocol, "OpenCode experiment has an unknown evidence record");
    }
  }
  const declared = new Set<string>();
  let terminal = false;
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    const event = opencodeEvidenceObject(JSON.parse(line));
    sessionMatches(event.sessionID);
    const parsed = parseOpenCodeRunLine(line, { knownSessionId: session! });
    if (parsed.kind === "grammar_error" || parsed.kind === "unusable" ||
        typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)) {
      throw new ExperimentFailure(Code.Protocol, "OpenCode stdout contains malformed native evidence");
    }
    const part = event.part;
    if (event.type === "tool_use") {
      const call = matchCall(part?.callID, part?.tool, part?.state?.input);
      if (declared.has(part.callID)) throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode stdout repeats a call ID");
      declared.add(part.callID);
      assertOpencodeExperimentResult(call.result);
      const expected = call.result.content.map((block: JsonObject) => block.text).join("\n\n");
      if (part.state.status !== (call.result.isError ? "error" : "completed") ||
          (call.result.isError ? part.state.error : part.state.output) !== expected || part.state.metadata?.truncated) {
        throw new ExperimentFailure(Code.ResultChanged, "OpenCode native tool result changed or was truncated");
      }
      source.record("turn_call", { message_id: part.messageID, call_id: part.callID, name: call.name, t: event.timestamp / 1000 });
    }
    if (event.type === "step_finish") {
      terminal = part?.reason === "stop";
      const tokens = part?.tokens;
      source.record("turn", { message_id: part.messageID, t: event.timestamp / 1000, tool_calls: [],
        usage: tokens ? { input: tokens.input, output: tokens.output,
          cache_read: tokens.cache?.read ?? 0, cache_write: tokens.cache?.write ?? 0 } : null });
    }
    if (event.type === "error") throw new ExperimentFailure(Code.Protocol, "OpenCode emitted an error event");
  }
  if (!terminal || !accepted || turns.size || requests.size || calls.size !== delivered.size ||
      calls.size !== dispatched.size || calls.size !== declared.size) {
    throw new ExperimentFailure(Code.HarnessLogMissing, "OpenCode experiment lacks complete native calls, provider delivery, or terminal evidence");
  }
  const identities = new Set([...acceptedIds].map((id) => servedModels.get(id) ?? null));
  return identities.size === 1 ? identities.values().next().value ?? null : null;
}

/** One run owns its relay, plugin and bounded evidence capture. Shared
 * launch integration must prepare before spawn and complete before cleanup. */
export class OpencodeExperimentRun implements StdoutSink {
  readonly relay: OpencodeExperimentRelay;
  readonly pluginPath: string;
  readonly evidencePath: string;
  readonly agent = `codemux_experiment_${crypto.randomUUID().replaceAll("-", "")}`;
  readonly fold = new OpenCodePlainFold();
  private capture = "";
  private evidenceCapture = "";
  private model: string | null = null;
  private bytes = 0;
  private preparing?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private interrupted = false;
  private finished = false;
  private claimed = new Set<string>();
  private removeFailureListener?: () => void;

  constructor(spec: ExperimentSpec, cwd: string, home: string, environment: NodeJS.ProcessEnv,
    private readonly prompt: string, relay?: OpencodeExperimentRelay) {
    this.pluginPath = join(home, "experiment.mjs");
    this.evidencePath = join(home, "experiment-evidence.jsonl");
    this.relay = relay ?? new ExperimentHttpRelay(spec, cwd, environment);
    this.relay.validateResult = assertOpencodeExperimentResult;
    this.relay.resolveCallId = async (call) => {
      const matches = this.readEvidence().filter((record) => record.kind === "tool_call" &&
        !this.claimed.has(record.fields.call_id) && record.fields.name === opencodeExperimentToolName(spec.name, call.name) &&
        isDeepStrictEqual(record.fields.input, call.input));
      if (matches.length !== 1 || typeof matches[0]!.fields.call_id !== "string" || !matches[0]!.fields.call_id) {
        throw new ExperimentFailure(Code.CallIdUnresolved, "OpenCode MCP request lacks an unambiguous native call ID");
      }
      const id = matches[0]!.fields.call_id as string;
      this.claimed.add(id); return id;
    };
  }
  get recordingPath(): string { return this.relay.recordingPath; }
  get capturedOutput(): string { return this.capture; }
  get hasOutput(): boolean { return this.bytes > 0; }
  get servedModel(): string | null { return this.model; }
  scanSurface(): string { return `${this.capture}\n${this.evidenceCapture}`; }
  get config(): JsonObject {
    // Read 2026-11-09, bin/opencode 1.19.5: "run without external plugins"
    // and `if(e.pure)process.env.OPENCODE_PURE="1"`. The adapter omits --pure
    // only for this owned plugin and unsets the inherited flag. Ordinary
    // launches retain --pure; hermetic config/project isolation stays active.
    return { plugin: [pathToFileURL(this.pluginPath).href],
      mcp: { [this.relay.spec.name]: { type: "remote", url: this.relay.url, oauth: false, enabled: true,
        headers: { Authorization: `Bearer {env:${OPENCODE_EXPERIMENT_TOKEN_ENV}}` },
        timeout: experimentToolTimeoutSeconds(this.relay.spec) * 1000 } },
      agent: { [this.agent]: { mode: "primary", permission: { "*": "deny", [`${this.relay.spec.name}_*`]: "allow" } } } };
  }
  prepare(): Promise<void> {
    return this.preparing ??= (async () => {
      try {
        await this.relay.start();
        writeFileSync(this.evidencePath, "", { mode: 0o600, flag: "wx" });
        writeFileSync(this.pluginPath, opencodeExperimentPluginSource(this.evidencePath), { mode: 0o600, flag: "wx" });
      } catch (error) { this.relay.fail(error); throw error; }
    })();
  }
  private readEvidence(): JsonObject[] {
    const text = readUtf8FileBounded(this.evidencePath, { maxBytes: 32 * 1024 * 1024, label: "OpenCode experiment evidence", noFollow: true });
    if (text && !text.endsWith("\n")) throw new ExperimentFailure(Code.HarnessLogMissing, "OpenCode experiment evidence is truncated");
    return text.split("\n").filter(Boolean).map((line) => opencodeEvidenceObject(JSON.parse(line)));
  }
  start(write: (text: string) => void, end: () => void, abort: () => void): void {
    this.closeProtocol();
    this.removeFailureListener = this.relay.onFailure(abort);
    if (this.relay.failureError) { abort(); return; }
    write(this.prompt); end();
  }
  push(chunk: string): void {
    if (this.finished) return;
    this.fold.push(chunk);
    this.capture += capturePrefix(chunk, Math.max(0, MAX_CAPTURE_BYTES - this.bytes));
    this.bytes += Buffer.byteLength(chunk);
  }
  finish(options?: { timedOut: boolean; aborted?: boolean }): string {
    this.interrupted ||= options?.timedOut === true || options?.aborted === true;
    this.finished = true; this.fold.finish(); return this.capture;
  }
  keptBytes(): number { return this.bytes; }
  closeProtocol(): void { this.removeFailureListener?.(); this.removeFailureListener = undefined; }
  terminateProtocol(): void { this.interrupted = true; this.relay.terminateProtocol(); }
  interruptBeforeEvidence(): void {
    this.terminateProtocol(); this.relay.fail(new Error("interrupted before OpenCode experiment verification"));
  }
  complete(options?: { timedOut: boolean }): Promise<void> {
    this.interrupted ||= options?.timedOut === true;
    return this.completing ??= (async () => {
      try {
        this.relay.record("harness_stdout", { bytes_base64: Buffer.from(this.capture).toString("base64") });
        const evidence = readUtf8FileBounded(this.evidencePath, { maxBytes: 32 * 1024 * 1024, label: "OpenCode experiment evidence", noFollow: true });
        this.evidenceCapture = evidence;
        this.relay.record("opencode_evidence_copy", { bytes_base64: Buffer.from(evidence).toString("base64") });
        if (this.interrupted || this.bytes > MAX_CAPTURE_BYTES) throw new ExperimentFailure(Code.HarnessLogMissing, "OpenCode experiment capture was interrupted or exceeded its bound");
        this.model = verifyOpencodeExperimentEvidence(this.relay, this.readEvidence(), this.capture);
        this.relay.finish();
      } catch (error) { this.relay.fail(error); }
      if (this.relay.failureError) throw this.relay.failureError;
    })();
  }
  close(): Promise<void> { this.closeProtocol(); return this.closing ??= this.relay.close(); }
  closeSync(): void { this.closeProtocol(); this.relay.closeSync(); }
}

/** Normalize retained native output before shared cleanup removes its evidence. */
export function opencodeExperimentFailureResult(adapter: Pick<BaseAdapter, "processRunResult">,
  request: RunRequest, context: OpencodeExperimentContext | undefined,
  captured: RunResult | undefined, processed: RunResult | undefined): RunResult | undefined {
  if (!request.experimentMcp || request.agent !== "opencode" || processed) return processed;
  return adapter.processRunResult(captured ?? { stdout: context?.experimentOpencode?.capturedOutput ?? "",
    stderr: "", exitCode: 1, success: false }, request, context);
}
