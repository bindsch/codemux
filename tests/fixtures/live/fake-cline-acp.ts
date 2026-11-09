// Synthetic Cline cli-v3.0.74 ACP and history wire for codemux session tests.
// No provider or network access. Every invocation appends its argv and the
// storage variables to $FAKE_STATE_DIR/calls.jsonl; history reads the
// cumulative usage file the ACP arm writes after each prompt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const state = process.env.FAKE_STATE_DIR ?? process.exit(41);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  name === "HOME" || name.startsWith("CLINE_")));
appendFileSync(join(state, "calls.jsonl"), JSON.stringify({ argv, env, cwd: process.cwd() }) + "\n");
const usageFile = join(state, "usage.json");
const sessionsFile = join(state, "sessions.json");
const cumulative = (): { sessionId: string; cwd: string; turns: number }[] =>
  existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : [];

if (argv.includes("history")) {
  const rows = cumulative().map((row) => ({ sessionId: row.sessionId, cwd: row.cwd, metadata: { aggregateUsage: {
    inputTokens: 13 * row.turns, outputTokens: 2 * row.turns, cacheReadTokens: 3 * row.turns, cacheWriteTokens: 0,
    totalCost: 0.25 * row.turns } } }));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (!argv.includes("--acp")) process.exit(42);
writeFileSync(usageFile, "");

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let sessionId = "";
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.trim() === "") continue;
    const frame = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, any> };
    appendFileSync(join(state, "frames.jsonl"), line + "\n");
    if (frame.method === "initialize") send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } });
    else if (frame.method === "session/new") {
      sessionId = `${Date.now()}_Fx-01_cli`;
      writeFileSync(sessionsFile, JSON.stringify([...cumulative(), { sessionId, cwd: frame.params?.cwd, turns: 0 }]));
      send({ jsonrpc: "2.0", id: frame.id, result: { sessionId } });
    } else if (frame.method === "session/load") {
      sessionId = String(frame.params?.sessionId);
      if (!cumulative().some((row) => row.sessionId === sessionId)) {
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "unknown session" } });
      } else send({ jsonrpc: "2.0", id: frame.id, result: {} });
    } else if (frame.method === "session/set_config_option" || frame.method === "session/set_mode") {
      send({ jsonrpc: "2.0", id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      const text = (frame.params?.prompt as { text: string }[])[0]!.text;
      writeFileSync(sessionsFile, JSON.stringify(cumulative().map((row) =>
        row.sessionId === sessionId ? { ...row, turns: row.turns + 1 } : row)));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } } } });
      send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
    }
  }
}
