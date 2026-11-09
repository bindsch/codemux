/** Synthetic Gemini ACP peer. It imports no codemux source and models the
 * installed native JSON-RPC and transcript shapes independently. */
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function runGeminiAcpFixture(stateDir: string): Promise<void> {
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const record = (name: string, value: unknown) => appendFileSync(join(stateDir, name), JSON.stringify(value) + "\n");
  let sessionId: string | null = null;
  let transcript: string | null = null;
  let pending: number | null = null;
  const finish = (reason: string, tokens = true) => {
    if (pending === null) throw new Error("no fixture prompt");
    if (tokens) appendFileSync(transcript!, JSON.stringify({ id: randomUUID(), type: "gemini", tokens: { input: 100, output: 20, cached: 10 } }) + "\n");
    emit({ jsonrpc: "2.0", id: pending, result: { stopReason: reason,
      ...(tokens ? { _meta: { quota: { token_count: { input_tokens: 100, output_tokens: 20 } } } } : {}) } });
    pending = null;
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const frame = JSON.parse(line);
    record("acp.jsonl", frame);
    if (frame.method === "initialize") {
      emit({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (frame.method === "session/new" || frame.method === "session/load") {
      sessionId = frame.params.sessionId ?? randomUUID();
      const cwd = frame.params.cwd;
      const brand = join(process.env.GEMINI_CLI_HOME ?? process.env.HOME!, ".gemini");
      const chats = join(brand, "tmp", "fixture-project", "chats"); mkdirSync(chats, { recursive: true });
      writeFileSync(join(brand, "projects.json"), JSON.stringify({ projects: { [cwd]: "fixture-project" } }));
      transcript = join(chats, `session-2026-11-09T12-30-${sessionId!.slice(0, 8)}.jsonl`);
      if (!existsSync(transcript)) writeFileSync(transcript, JSON.stringify({ sessionId,
        projectHash: createHash("sha256").update(cwd).digest("hex") }) + "\n");
      emit({ jsonrpc: "2.0", id: frame.id, result: frame.method === "session/new" ? { sessionId } : {} });
    } else if (frame.method === "session/prompt") {
      if (frame.params.sessionId !== sessionId || pending !== null) throw new Error("fixture prompt identity or overlap");
      pending = frame.id;
      const prompt = frame.params.prompt.map((part: { text: string }) => part.text).join("");
      record("stdin.jsonl", { prompt, bytes: Buffer.byteLength(prompt), eof: false });
      const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
      if (scenario === "interrupt") continue;
      if (scenario === "permission") {
        emit({ jsonrpc: "2.0", id: "fixture-permission", method: "session/request_permission", params: {
          sessionId, toolCall: { toolCallId: "tool", kind: "execute" },
          options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
        } }); continue;
      }
      emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Done: ${prompt}` } } } });
      finish("end_turn");
    } else if (frame.method === "session/cancel") {
      if (frame.params.sessionId !== sessionId) throw new Error("fixture cancel identity");
      finish("cancelled", false); // allow-british: native ACP enum
    } else if (frame.id === "fixture-permission") {
      record("permission.jsonl", frame.result); finish("end_turn");
    } else throw new Error("unsupported fixture request");
  }
}
