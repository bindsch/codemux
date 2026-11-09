import { copilotExperimentObject, type CopilotDeliveryObserver, type CopilotExperimentDelivery } from "./copilot-experiment-evidence.js";
import { copilotModelResponseSucceeded } from "./copilot-experiment-response.js";
import type { JsonObject } from "./experiment-server.js";

/** Native 1.0.85 copilot-sdk/index.js createCopilotRequestAdapter routes
 * llmInference.httpRequestStart/Chunk to the host and forwards response
 * bytes verbatim through httpResponseStart/Chunk (read 2026-11-09).
 * This observer reads model identity only from those provider response
 * bytes. It never falls back to session config or transcript metadata. */
export class CopilotModelEvidence implements CopilotDeliveryObserver {
  private readonly models = new Set<string>();
  private invalidModel = false;
  private readonly pending = new Map<CopilotExperimentDelivery, boolean>();
  get servedModel(): string | null { return !this.invalidModel && this.models.size === 1 ? [...this.models][0]! : null; }

  request(bytes: Uint8Array, context?: JsonObject): CopilotExperimentDelivery {
    const frame = copilotExperimentObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const payload = frame.type === "response.create" && frame.response ? copilotExperimentObject(frame.response) : frame;
    const wireApi = Array.isArray(payload.input) ? "responses" :
      Array.isArray(payload.messages) && payload.max_tokens !== undefined && payload.anthropic_version !== undefined ? "anthropic" :
      String(context?.url).includes("/messages") ? "anthropic" : "chat";
    const delivery: CopilotExperimentDelivery = { callIds: [], wireApi };
    const main = context?.parentAgentId === undefined && context?.interactionType === "conversation-agent";
    this.pending.set(delivery, main);
    return delivery;
  }

  commit(delivery: CopilotExperimentDelivery, response?: Uint8Array): void {
    const main = this.pending.get(delivery);
    if (main === undefined) throw new Error("Copilot model response has no pending request");
    this.pending.delete(delivery);
    if (!main || !response || !copilotModelResponseSucceeded(delivery, response)) return;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response);
    const records: JsonObject[] = text.trimStart().startsWith("{") ? [JSON.parse(text)] : text.split(/\r?\n\r?\n/)
      .map((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))
      .filter((data) => data && data !== "[DONE]").map((data) => JSON.parse(data));
    const models: unknown[] = [];
    for (const record of records) for (const source of [record, record.response, record.message]) {
      if (source && typeof source === "object" && Object.hasOwn(source, "model")) models.push(source.model);
    }
    if (!models.length) this.invalidModel = true;
    for (const model of models) {
      if (typeof model !== "string" || !model || model.trim() !== model || /[\u0000-\u001f\u007f]/.test(model) || Buffer.byteLength(model) > 256) this.invalidModel = true;
      else this.models.add(model);
    }
  }

  discard(delivery: CopilotExperimentDelivery): void { this.pending.delete(delivery); }
}
