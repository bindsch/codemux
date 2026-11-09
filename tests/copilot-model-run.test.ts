import { expect, test } from "bun:test";
import { CopilotModelRun } from "../src/copilot-model-run.js";
import { CopilotRpcFramer, encodeCopilotRpc } from "../src/session/copilot-rpc-framing.js";
import type { JsonObject } from "../src/experiment-server.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import type { CopilotRunContext } from "../src/copilot-usage.js";

test.each([true, false])("Copilot ordinary RPC run reports observed provider identity (model supplied=%p)", async (withModel) => {
  const run = new CopilotModelRun("prompt", { workingDirectory: "/synthetic", availableTools: ["builtin:*"] }, "medium", async () =>
    new Response(JSON.stringify({ id: "response", model: withModel ? "actual-provider-model" : undefined,
      choices: [{ index: 0, message: { content: "answer" }, finish_reason: "stop" }] })));
  let ended = false, aborted = false, id = 100, work: Promise<void> | undefined;
  const pending = new Map<number, (value: unknown) => void>(), writes: JsonObject[] = [];
  const feed = (message: JsonObject) => run.push(Buffer.from(encodeCopilotRpc({ jsonrpc: "2.0", ...message })).toString("utf8"));
  const native = (method: string, params: JsonObject) => new Promise((resolve) => { const next = id++; pending.set(next, resolve); feed({ id: next, method, params }); });
  run.start((text) => {
    const message = new CopilotRpcFramer().push(Buffer.from(text))[0] as JsonObject; writes.push(message);
    if (!message.method) { pending.get(message.id)!(message.result); pending.delete(message.id); return; }
    const result = message.method === "session.create" ? { sessionId: run.sessionId } : message.method === "session.usage.getMetrics"
      ? { modelMetrics: { model: { usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } } } }
      : message.method.startsWith("llmInference.httpResponse") ? { accepted: true } : { success: true };
    queueMicrotask(() => feed({ id: message.id, result }));
    if (message.method === "session.send") work = (async () => {
      await native("llmInference.httpRequestStart", { requestId: "model", sessionId: run.sessionId, interactionType: "conversation-agent",
        method: "POST", url: "https://synthetic.invalid/chat/completions", headers: {} });
      await native("llmInference.httpRequestChunk", { requestId: "model", data: '{"model":"requested-model","messages":[]}', end: true });
    })();
    if (message.method === "llmInference.httpResponseChunk" && message.params.end) queueMicrotask(() => {
      for (const event of [{ type: "assistant.message", data: { content: "answer", model: "unproven-transcript-model" } }, { type: "session.idle", data: {} }]) {
        feed({ method: "session.event", params: { sessionId: run.sessionId, event } });
      }
    });
  }, () => { ended = true; }, () => { aborted = true; });
  for (let count = 0; count < 100 && !ended && !aborted; count++) await Bun.sleep(1);
  await work; expect([ended, aborted]).toEqual([true, false]);
  expect(writes.find((message) => message.method === "session.create")?.params.availableTools).toEqual(["builtin:*"]);
  if (withModel) await run.complete(); else await expect(run.complete()).rejects.toThrow("model identity");
  const adapter = new CopilotAdapter({}), context: CopilotRunContext = { copilotModelRun: run };
  const result = adapter.processRunResult({ stdout: run.finish(), stderr: "", exitCode: 0, success: true }, { agent: "copilot", prompt: "prompt", model: "requested-model", resultJson: true }, context);
  expect(JSON.parse(result.stdout).codemux.served_model).toBe(withModel ? "actual-provider-model" : null);
  expect(run.keptBytes()).toBeGreaterThan(0); adapter.cleanupRunSync(context);
});

test("Copilot model launch stays inactive until shared activation and fails incomplete transports", async () => {
  const adapter = new CopilotAdapter({}), request = { agent: "copilot" as const, prompt: "secret", resultJson: true }, context: CopilotRunContext = {};
  expect(() => adapter.prepareCopilotModelRun({ ...request, sandboxNoNet: true }, {})).toThrow("network denial");
  adapter.prepareCopilotModelRun(request, context);
  expect(adapter.buildRunCommand(request, context)).toContain("--headless");
  expect(adapter.buildRunCommand(request, context).join(" ")).not.toContain(request.prompt);
  await expect(context.copilotModelRun!.complete()).rejects.toThrow("terminal turn");
  let aborted = false;
  context.copilotModelRun!.start(() => {}, () => {}, () => { aborted = true; });
  context.copilotModelRun!.push("bad framing\r\n\r\n"); expect(aborted).toBe(true);
  context.copilotModelRun!.terminateProtocol(); context.copilotModelRun!.finish({ timedOut: true });
  await expect(context.copilotModelRun!.complete()).rejects.toThrow(); adapter.cleanupRunSync(context);
});
