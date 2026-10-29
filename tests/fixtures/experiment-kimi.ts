// Synthetic Kimi transport. It makes no provider request.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { MARKER, respond } from "./experiment-mcp.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./kimi-stream.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith("--server-"))) {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    const reply: any = respond(message);
    if (message.method === "tools/call" && reply?.result) {
      if (args.includes("--server-structured")) reply.result.structuredContent = { text: MARKER };
      if (args.includes("--server-error")) reply.result.isError = true;
      if (args.includes("--server-empty")) reply.result.content = [];
    }
    if (reply) console.log(JSON.stringify(reply));
  }
} else if (args.includes("--version")) {
  console.log(args.includes("old-version") ? "2.3.1" : "2.3.2");
} else {
  const scenario = args[args.indexOf("--scenario") + 1] ?? "clean";
  const brand = process.env.KIMI_CODE_HOME!;
  const config = JSON.parse(readFileSync(join(brand, "mcp.json"), "utf8"));
  const server = config.mcpServers.experiment;
  const agent = readFileSync(args[args.indexOf("--agent-file") + 1]!, "utf8");
  if (!agent.includes("mcp__experiment__*") || agent.includes("tools: []")) process.exit(12);
  if (!args.includes("--output-format") || args[args.indexOf("--output-format") + 1] !== "stream-json") process.exit(13);
  const path = join(brand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl");
  const write = (record: object) => {
    if (scenario === "missing-log") return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  };
  const loop = (event: object, time: number) => write({ type: "context.append_loop_event", agentId: "main", event, time });
  const usage = { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 0, output: 5 };
  const name = scenario === "unknown-tool" ? "Bash" : "mcp__experiment__bash";
  const call = { type: "function", id: "native-call-1", name, arguments: '{"command":"marker"}' };
  const post = async (id: number, method: string, params?: object) => {
    const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
    if (response.status !== 200) process.exit(14);
    return response.json() as Promise<any>;
  };
  await post(1, "initialize", {});
  const listed = await post(2, "tools/list");
  if (scenario !== "missing-snapshot") write({ type: "llm.tools_snapshot", tools: listed.result.tools.map((tool: any) =>
    ({ name: "mcp__experiment__" + tool.name, description: tool.description ?? "", parameters: tool.inputSchema })), time: 1000 });
  loop({ type: "tool.call", uuid: "tool-uuid", turnId: "0", step: 1, stepUuid: "step-1", toolCallId: call.id,
    name, args: { command: "marker" } }, 1100);
  // Missing logs cannot resolve a native call. Leave that refusal to completion.
  const reply = scenario === "missing-log" ? undefined : await post(3, "tools/call", { name: "bash", arguments: { command: "marker" } });
  const rawContent = reply?.result?.content ?? [{ type: "text", text: MARKER }];
  const output = rawContent.length === 1 && rawContent[0]?.type === "text" ? rawContent[0].text : rawContent;
  const content = scenario === "changed-result" ? "[...truncated]" : output;
  loop({ type: "tool.result", parentUuid: "tool-uuid", toolCallId: call.id,
    result: { output: content, isError: reply?.result?.isError, durationMs: 1 } }, 1200);
  loop({ type: "step.end", uuid: "step-1", turnId: "0", step: 1, messageId: "message-1", finishReason: "tool_use", usage }, 1300);
  const marker = existsSync(join(brand, "AGENTS.md"))
    ? readFileSync(join(brand, "AGENTS.md"), "utf8").match(/CODEMUX-CANARY-[A-Z0-9]+/)?.[0] : undefined;
  const answer = scenario === "empty-reply" ? "" : marker ?? "OK";
  loop({ type: "content.part", uuid: "part-2", turnId: "0", step: 2, stepUuid: "step-2", part: { type: "text", text: answer } }, 1400);
  loop({ type: "step.end", uuid: "step-2", turnId: "0", step: 2, messageId: "message-2", finishReason: "completed", usage }, 1500);
  write({ type: "agent.message.appended", message: { message: { role: "assistant", content: [], toolCalls: [call] },
    meta: { source: "llm", messageId: "message-1", usage } }, time: 1600 });
  write({ type: "agent.message.appended", message: { message: { role: "tool",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content, toolCallId: call.id },
    meta: { source: "tool" } }, time: 1600 });
  write({ type: "agent.message.appended", message: { message: { role: "assistant", content: [{ type: "text", text: answer }], toolCalls: [] },
    meta: { source: "llm", messageId: "message-2", usage } }, time: 1600 });
  write({ type: "usage.record", usageScope: "turn", usage, time: 1600 });
  console.log(JSON.stringify({ role: "assistant", tool_calls: [{ type: "function", id: call.id,
    function: { name, arguments: call.arguments } }] }));
  console.log(JSON.stringify({ role: "tool", tool_call_id: call.id, content: typeof content === "string" ? content : JSON.stringify(content) }));
  console.log(JSON.stringify({ role: "assistant", content: answer }));
  if (scenario !== "missing-hint") console.log(JSON.stringify(kimiResumeHint()));
}
