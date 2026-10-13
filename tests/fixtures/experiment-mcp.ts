// A protocol fixture only: bash returns a constant and executes no command.
import { createInterface } from "node:readline";

export const MARKER = "CODEMUX-MCP-RESULT-8B73E209";

export function respond(message: { id?: unknown; method?: string; params?: { name?: string } }): object | null {
  if (message.id === undefined) return null;
  let result: unknown;
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "codemux-experiment-fixture", version: "1.0.0" } };
      break;
    case "tools/list":
      result = { tools: [{ name: "bash", description: "Return the fixed experiment marker. No command is executed.",
        inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
      break;
    case "tools/call":
      if (message.params?.name !== "bash") return { jsonrpc: "2.0", id: message.id,
        error: { code: -32602, message: "Unknown tool" } };
      result = { content: [{ type: "text", text: MARKER }] };
      break;
    case "ping": result = {}; break;
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
  return { jsonrpc: "2.0", id: message.id, result };
}

if (import.meta.main) {
  if (process.argv.includes("--inspect")) process.stderr.write(JSON.stringify({ cwd: process.cwd(), env_names: Object.keys(process.env) }) + "\n");
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    const result = respond(message);
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
    // The late-failure regression: answer normally, then exit after a beat,
    // so the failure lands after Claude's successful finish.
    if (message?.params?.arguments?.command === "exit-later") {
      setTimeout(() => process.exit(0), 200);
    }
  }
}
