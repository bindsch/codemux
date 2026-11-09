import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { ExperimentRelayCall } from "./experiment-relay.js";
import { experimentToolTimeoutSeconds } from "./experiment-mcp.js";
import type { JsonObject } from "./experiment-server.js";
import { piObject, verifyPiProviderPayload } from "./pi-experiment-content.js";

export interface PiExperimentEvidenceSource {
  spec: { name: string; tool_timeout_seconds?: number };
  calls: readonly ExperimentRelayCall[];
  toolDefinitions: readonly JsonObject[] | undefined;
  record: ExperimentRecord;
}

/** Joins immutable relay results to native context and final provider
 * requests. Native hook failures are swallowed by Pi, so a missing or
 * contradictory event must fail here before the run can report success. */
export function verifyPiExperimentEvidence(source: PiExperimentEvidenceSource, records: JsonObject[], stdout: string): void {
  const definitions = source.toolDefinitions;
  if (!definitions?.length) throw new ExperimentFailure(Code.InventoryMismatch, "Pi experiment has no server inventory");
  // A native deadline necessarily leaves the relay result incomplete. Preserve
  // that cause before the normal completeness checks reject the missing result.
  for (const record of records.filter((entry) => entry.kind === "tool_timeout")) {
    const fields = piObject(record.fields);
    const call = source.calls.find((entry) => entry.call_id === fields.call_id);
    if (!call || fields.name !== `mcp__${source.spec.name}__${call.name}` || !isDeepStrictEqual(fields.input, call.input) ||
        fields.timeout_ms !== experimentToolTimeoutSeconds(source.spec) * 1000) {
      throw new ExperimentFailure(Code.Protocol, "Pi native tool timeout does not match the relay call and configured deadline");
    }
    source.record("pi_extension_evidence", { event_kind: record.kind, ...fields });
    throw new ExperimentFailure(Code.ServerError, `pi tool call timed out after ${fields.timeout_ms} ms`);
  }
  const calls = new Map<string, ExperimentRelayCall>();
  for (const call of source.calls) {
    if (!call.call_id || calls.has(call.call_id) || !call.result) throw new ExperimentFailure(Code.CallIdUnresolved, "Pi experiment has an incomplete or repeated relay call");
    calls.set(call.call_id, call);
  }
  const dispatched = new Set<string>(), delivered = new Set<string>();
  let messages: JsonObject[] | undefined, inventory = false, requests = 0;
  const matchCall = (id: unknown, name: unknown, input: unknown): ExperimentRelayCall => {
    const call = typeof id === "string" ? calls.get(id) : undefined;
    if (!call || name !== `mcp__${source.spec.name}__${call.name}` || !isDeepStrictEqual(input, call.input)) {
      throw new ExperimentFailure(Code.CallIdUnresolved, "Pi native tool call does not match relay identity and arguments");
    }
    return call;
  };
  for (const record of records) {
    const fields = piObject(record.fields);
    source.record("pi_extension_evidence", { event_kind: record.kind, ...fields });
    switch (record.kind) {
      case "tool_inventory":
        if (inventory || !isDeepStrictEqual(fields.tools, definitions)) throw new ExperimentFailure(Code.InventoryMismatch, "Pi extension catalog changed");
        inventory = true;
        break;
      case "tool_call":
        matchCall(fields.call_id, fields.name, fields.input);
        if (dispatched.has(fields.call_id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Pi extension repeated a call ID");
        dispatched.add(fields.call_id);
        break;
      case "server_tool_result":
      case "model_tool_result": {
        const call = calls.get(fields.call_id);
        if (!call || !isDeepStrictEqual(fields.content, call.result!.content) || fields.is_error !== (call.result!.isError === true)) {
          throw new ExperimentFailure(Code.ResultChanged, "Pi extension result changed");
        }
        break;
      }
      case "model_context":
        if (!Array.isArray(fields.messages)) throw new ExperimentFailure(Code.Protocol, "Pi context has no messages");
        messages = fields.messages.map(piObject);
        const contextCalls = new Set(messages!.filter((message) => message.role === "assistant")
          .flatMap((message) => Array.isArray(message.content)
            ? message.content.filter((block: JsonObject) => block.type === "toolCall").map((block: JsonObject) => block.id) : []));
        for (const message of messages!) {
          if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const block of message.content) if (block.type === "toolCall") matchCall(block.id, block.name, block.arguments);
          }
          if (message.role !== "toolResult") continue;
          if (!contextCalls.has(message.toolCallId)) throw new ExperimentFailure(Code.CallIdUnresolved, "Pi context result has no matching assistant tool call");
          const call = calls.get(message.toolCallId);
          if (!call || message.toolName !== `mcp__${source.spec.name}__${call.name}` ||
              !isDeepStrictEqual(message.content, call.result!.content) || message.isError !== (call.result!.isError === true)) {
            throw new ExperimentFailure(Code.ResultChanged, "Pi model context result differs from server bytes");
          }
        }
        break;
      case "provider_request":
        if (!inventory || !messages || typeof fields.api !== "string") throw new ExperimentFailure(Code.HarnessLogMissing, "Pi provider request lacks context, catalog, or API identity");
        for (const id of verifyPiProviderPayload(source.spec.name, definitions, fields.api, fields.payload, messages)) {
          if (!delivered.has(id)) source.record("tool_result_delivered", { call_id: id, t: record.t });
          delivered.add(id);
        }
        requests++;
        break;
      default: throw new ExperimentFailure(Code.Protocol, `Pi experiment has unknown evidence ${String(record.kind)}`);
    }
  }
  let ended = false, assistants = 0;
  const declared = new Set<string>();
  for (const line of stdout.split("\n").filter((value) => value.trim())) {
    const event = piObject(JSON.parse(line));
    if (event.type === "agent_end") ended = true;
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    assistants++;
    const message = event.message;
    const nativeCalls = (message.content as JsonObject[]).filter((part) => part.type === "toolCall");
    for (const call of nativeCalls) {
      matchCall(call.id, call.name, call.arguments);
      if (declared.has(call.id)) throw new ExperimentFailure(Code.CallIdUnresolved, "Pi stdout repeats a native call ID");
      declared.add(call.id);
    }
    source.record("pi_assistant_message", { message });
  }
  if (!ended || !assistants || requests < assistants || calls.size !== delivered.size || calls.size !== dispatched.size || calls.size !== declared.size) {
    throw new ExperimentFailure(Code.HarnessLogMissing, "Pi experiment lacks complete native call, provider delivery, or terminal evidence");
  }
}
