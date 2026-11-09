import { expect, test } from "bun:test";
import { CopilotModelEvidence } from "../src/copilot-model-evidence.js";
import { copilotModelResponseSucceeded } from "../src/copilot-experiment-response.js";
import type { CopilotExperimentDelivery } from "../src/copilot-experiment-evidence.js";

const copilotResponse = {
  chat: { id: "response", model: "provider-produced", choices: [{ index: 0, message: { content: "answer" }, finish_reason: "stop" }] },
  responses: { id: "response", model: "provider-produced", status: "completed", output: [] },
  anthropic: { id: "response", model: "provider-produced", type: "message", stop_reason: "end_turn", content: [] },
};
const copilotFrames = {
  chat: [{ id: "response", model: "provider-produced", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] }, "[DONE]"],
  responses: [{ type: "response.created", response: { id: "response", model: "provider-produced" } }, { type: "response.completed", response: copilotResponse.responses }],
  anthropic: [{ type: "message_start", message: copilotResponse.anthropic }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }],
};
const copilotSse = (frames: unknown[]) => frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");

test("Copilot requires complete native model responses for all supported API wires", () => {
  for (const wireApi of ["chat", "responses", "anthropic"] as const) {
    const delivery: CopilotExperimentDelivery = { wireApi, callIds: [] };
    expect(copilotModelResponseSucceeded(delivery, Buffer.from(JSON.stringify(copilotResponse[wireApi])))).toBe(true);
    expect(copilotModelResponseSucceeded(delivery, Buffer.from(copilotSse(copilotFrames[wireApi])))).toBe(true);
    for (const response of ["broken", "{}", JSON.stringify({ error: "failed" }), copilotSse([{ type: "error", error: { message: "failed" } }]),
      copilotSse(copilotFrames[wireApi]).trimEnd(), copilotSse(copilotFrames[wireApi].slice(0, -1))]) {
      expect(copilotModelResponseSucceeded(delivery, Buffer.from(response))).toBe(false);
    }
  }
});

test("Copilot produced model comes only from accepted main-agent provider responses", () => {
  for (const wireApi of ["chat", "responses", "anthropic"] as const) for (const stream of [false, true]) {
    const evidence = new CopilotModelEvidence();
    const payload = wireApi === "responses" ? { input: [], model: "requested" } : { messages: [], model: "requested" };
    const context = { url: wireApi === "anthropic" ? "https://synthetic.invalid/messages" : "https://synthetic.invalid/model", interactionType: "conversation-agent" };
    const delivery = evidence.request(Buffer.from(JSON.stringify(payload)), context);
    expect(evidence.servedModel).toBeNull();
    evidence.commit(delivery, Buffer.from(stream ? copilotSse(copilotFrames[wireApi]) : JSON.stringify(copilotResponse[wireApi])));
    expect(evidence.servedModel).toBe("provider-produced");
    expect(() => evidence.commit(delivery)).toThrow("no pending");
    const child = evidence.request(Buffer.from(JSON.stringify(payload)), { ...context, parentAgentId: "parent" });
    evidence.commit(child, Buffer.from(JSON.stringify({ ...copilotResponse[wireApi], model: "child-model" })));
    expect(evidence.servedModel).toBe("provider-produced");
    const missing = evidence.request(Buffer.from(JSON.stringify(payload)), context);
    evidence.commit(missing, Buffer.from(JSON.stringify({ ...copilotResponse[wireApi], model: undefined })));
    expect(evidence.servedModel).toBeNull();
    evidence.discard(evidence.request(Buffer.from(JSON.stringify(payload)), context));
  }
});

test("Copilot rejects a completed Responses SSE event containing an error", () => {
  const frames = [copilotFrames.responses[0], { type: "response.completed", response: { ...copilotResponse.responses, error: { message: "contradictory completion" } } }];
  expect(copilotModelResponseSucceeded({ wireApi: "responses", callIds: [] }, Buffer.from(copilotSse(frames)))).toBe(false);
});

test("Copilot excludes unclassified, failed and contradictory model provenance", () => {
  const evidence = new CopilotModelEvidence(), payload = Buffer.from(JSON.stringify({ type: "response.create", response: { input: [] } }));
  const ignored = evidence.request(payload); evidence.commit(ignored, Buffer.from(JSON.stringify(copilotResponse.responses))); expect(evidence.servedModel).toBeNull();
  const failed = evidence.request(payload, { interactionType: "conversation-agent" }); evidence.commit(failed, Buffer.from('{"error":"failed"}')); expect(evidence.servedModel).toBeNull();
  const conflicting = evidence.request(Buffer.from('{"messages":[]}'), { interactionType: "conversation-agent" });
  evidence.commit(conflicting, Buffer.from(copilotSse([copilotFrames.chat[0], { ...copilotFrames.chat[0] as object, model: "different" }, "[DONE]"])));
  expect(evidence.servedModel).toBeNull();
});

test("Copilot rejects malformed model IDs and conflicting completed main requests", () => {
  const payload = Buffer.from('{"messages":[]}'), context = { interactionType: "conversation-agent" };
  for (const model of ["", " actual", "actual ", "actual\n", "actual\u0000", "x".repeat(257), null, 17]) {
    const evidence = new CopilotModelEvidence();
    evidence.commit(evidence.request(payload, context), Buffer.from(JSON.stringify({ ...copilotResponse.chat, model })));
    expect(evidence.servedModel).toBeNull();
  }
  const evidence = new CopilotModelEvidence();
  evidence.commit(evidence.request(payload, context), Buffer.from(JSON.stringify(copilotResponse.chat)));
  evidence.commit(evidence.request(payload, context), Buffer.from(JSON.stringify({ ...copilotResponse.chat, model: "different-main-model" })));
  expect(evidence.servedModel).toBeNull();
  evidence.commit(evidence.request(payload, context), Buffer.from(JSON.stringify(copilotResponse.chat)));
  expect(evidence.servedModel).toBeNull();
});
