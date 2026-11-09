/** Independent model of the installed Copilot 1.0.85 SDK's framed RPC.
 * No src imports and no provider calls. Persistent counters belong only
 * to FAKE_STATE_DIR and the supplied synthetic session id. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runFakeCopilotRpc(stateDir: string, record: (name: string, value: unknown) => void): Promise<void> {
  let buffer: Buffer = Buffer.alloc(0);
  let length: number | null = null;
  let sessionId = "";
  let tokens = 0;
  let waiting = false;
  let observedPrompt = "";
  let modelServer: ReturnType<typeof Bun.serve> | undefined;
  const emit = (value: unknown) => {
    const body = JSON.stringify(value);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const event = (type: string, data: unknown = {}) => emit({ jsonrpc: "2.0", method: "session.event",
    params: { sessionId, event: { type, data } } });
  const metrics = () => ({ modelMetrics: { "copilot-fixture-model": { usage: {
    inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0,
  } } } });
  const complete = (content: string) => {
    tokens += 5;
    waiting = false;
    event("assistant.message", { content, model: "copilot-fixture-model" });
    event("session.idle");
  };
  const dispatch = (packet: { id: unknown; method: string; params: Record<string, unknown> }) => {
    record("rpc.jsonl", packet);
    if (typeof packet.method !== "string") return;
    const reply = (result: unknown) => emit({ jsonrpc: "2.0", id: packet.id, result });
    const params = packet.params;
    switch (packet.method) {
      case "llmInference.setProvider":
        modelServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
          record("provider.jsonl", await request.json());
          return Response.json({ id: "fake-provider-response", model: "copilot-provider-model",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer" } }] });
        } });
        reply({ success: true }); return;
      case "llmInference.httpResponseStart":
        reply({ accepted: true }); return;
      case "llmInference.httpResponseChunk":
        reply({ accepted: true });
        if (params.end === true) complete(`Done: ${observedPrompt}`);
        return;
      case "session.create":
      case "session.resume": {
        if (typeof params.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(params.sessionId)) throw new Error("invalid fake id");
        sessionId = params.sessionId;
        const state = join(stateDir, `rpc-${sessionId}.json`);
        tokens = packet.method === "session.resume" && existsSync(state) ? Number(readFileSync(state, "utf8")) : 0;
        reply({ sessionId });
        return;
      }
      case "session.permissions.configure":
        reply({ success: true }); return;
      case "session.mode.set":
        reply({ status: "success", modeApplied: true }); return;
      case "session.send": {
        const prompt = String(params.prompt);
        record("stdin.jsonl", { prompt, bytes: Buffer.byteLength(prompt), rpc: true });
        reply({ messageId: "fake-message" });
        if (modelServer) {
          observedPrompt = prompt;
          emit({ jsonrpc: "2.0", id: "provider-start", method: "llmInference.httpRequestStart", params: {
            requestId: "provider", sessionId, interactionType: "conversation-agent", method: "POST",
            url: `http://127.0.0.1:${modelServer.port}/chat/completions`, headers: {},
          } });
          emit({ jsonrpc: "2.0", id: "provider-body", method: "llmInference.httpRequestChunk", params: {
            requestId: "provider", data: JSON.stringify({ model: "requested-fixture-model", messages: [{ role: "user", content: prompt }] }), end: true,
          } });
          return;
        }
        if (prompt.startsWith("scenario:nowire")) { process.stdout.write("invalid wire"); process.exit(1); }
        if (prompt.startsWith("scenario:wait")) { waiting = true; return; }
        if (prompt.startsWith("scenario:permission")) {
          waiting = true; event("permission.requested", { requestId: "fake-permission", permissionRequest: { kind: "write" } }); return;
        }
        if (prompt.startsWith("scenario:errorturn")) event("session.error", { message: "the model call failed" });
        if (prompt.startsWith("scenario:wrongid")) sessionId = "22222222-2222-4222-8222-222222222222";
        complete(`Done: ${prompt}`); return;
      }
      case "session.abort":
        reply({ success: true });
        if (waiting) { event("abort", { reason: "user_initiated" }); complete("interrupted"); }
        return;
      case "session.permissions.handlePendingPermissionRequest":
        reply({ success: true });
        if ((params.result as { kind?: unknown })?.kind !== "reject") throw new Error("fake permission was granted");
        complete("permission denied"); return;
      case "session.usage.getMetrics":
        reply(metrics()); return;
      case "session.detach":
        writeFileSync(join(stateDir, `rpc-${sessionId}.json`), String(tokens));
        reply({ success: true }); return;
      default:
        emit({ jsonrpc: "2.0", id: packet.id, error: { code: -32601, message: "unknown fake method" } });
    }
  };
  try { for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    for (;;) {
      if (length === null) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) break;
        const match = /^Content-Length: ([0-9]+)$/.exec(buffer.subarray(0, end).toString("ascii"));
        if (match === null) throw new Error("invalid fake RPC header");
        length = Number(match[1]);
        if (length <= 0 || length > 16 * 1024 * 1024) throw new Error("invalid fake RPC size");
        buffer = buffer.subarray(end + 4);
      }
      if (buffer.length < length) break;
      dispatch(JSON.parse(buffer.subarray(0, length).toString("utf8")));
      buffer = buffer.subarray(length);
      length = null;
    }
  }
  if (buffer.length !== 0 || length !== null) throw new Error("truncated fake RPC input");
  } finally { await modelServer?.stop(true); }
}
