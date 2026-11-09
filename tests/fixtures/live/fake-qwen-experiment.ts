// Synthetic Qwen wire only. This process contacts its authenticated loopback relay.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../../../src/experiment-server.js";
import type { ExperimentRelayCall } from "../../../src/experiment-relay.js";

export const session = "507e1e7c-a25c-4d53-8d5d-f0b929f24a8d";
export const prompt = "literal synthetic prompt\nincluding a second line";
export const definition = { name: "echo", description: "Exact echo", inputSchema: {
  type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
} };
export const input = { text: " exact\nbytes \t" };
export const content = [{ type: "text", text: input.text }];
export function nativeEvents(name = "echo", args: JsonObject = input, id = "native-call-42"): JsonObject[] {
  return [
    { type: "assistant", model: "qwen-fixture-model", session_id: session, parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "tool_use", id, name: `mcp__test__${name}`, input: args }] } },
    { type: "user", session_id: session, parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "native display only" }] } },
    { type: "result", session_id: session, subtype: "success", is_error: false, permission_denials: [],
      result: "complete", usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 2 } },
  ];
}
export function stdout(events = nativeEvents()): string {
  return events.map((event) => JSON.stringify(event) + "\n").join("");
}
export function evidence(tool: JsonObject = definition, args: JsonObject = input,
  result: JsonObject = { content }, id = "native-call-42"): JsonObject[] {
  const tools = [{ type: "function", function: { name: `mcp__test__${tool.name}`,
    description: tool.description, parameters: tool.inputSchema } }];
  const call = { id, type: "function", function: { name: tools[0]!.function.name, arguments: JSON.stringify(args) } };
  const user = { role: "user", content: prompt };
  const assistant = { role: "assistant", content: null, tool_calls: [call] };
  const log = (responseId: string, messages: JsonObject[], message: JsonObject, finish: string): JsonObject => ({
    timestamp: "2026-11-09T12:00:00.000Z", error: null, context: { sessionId: session, promptId: `${session}########0` },
    request: { model: "qwen-fixture-model", stream: true, tools, messages },
    response: { id: responseId, object: "chat.completion", model: "qwen-fixture-model",
      choices: [{ index: 0, message, finish_reason: finish }] },
    system: { hostname: "must-not-retain-hostname", authorization: "must-not-retain-native-metadata" },
  });
  return structuredClone([
    log("response-1", [user], assistant, "tool_calls"),
    log("response-2", [user, assistant, { role: "tool", tool_call_id: id, content: result.content }],
      { role: "assistant", content: "complete" }, "stop"),
  ]);
}
export function source() {
  const records: JsonObject[] = [];
  const calls: ExperimentRelayCall[] = [{ relay_index: 1, call_id: "native-call-42", name: "echo",
    input: structuredClone(input), result: { content: structuredClone(content) } }];
  return { calls, toolDefinitions: structuredClone([definition]), records,
    record: (kind: string, fields: JsonObject) => { records.push({ kind, fields }); } };
}
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`synthetic Qwen: ${message}`);
}
async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
  requireValue(argv.includes("--safe-mode") && argv.includes("--openai-logging"), "missing safe mode or provider capture");
  requireValue(flag("--output-format") === "stream-json" && flag("--auth-type") === "openai", "wrong native wire or auth");
  requireValue(flag("--approval-mode") === "plan", "read-only approval mode missing");
  const excluded = new Set(flag("--exclude-tools")?.split(","));
  for (const name of ["run_shell_command", "read_file", "write_file", "web_fetch", "web_search", "agent", "skill",
    "tool_search", "get_goal", "update_goal", "enter_worktree", "exit_worktree", "report_findings"]) {
    requireValue(excluded.has(name), `builtin ${name} was not excluded`);
  }
  const home = process.env.QWEN_HOME;
  requireValue(home && home === process.env.HOME, "private homes differ");
  requireValue(process.env.QWEN_RUNTIME_DIR === home && process.env.QWEN_CODE_TRUSTED_FOLDERS_PATH === join(home, "trusted-folders.json")
    && process.env.QWEN_CODE_MCP_APPROVALS_PATH === join(home, "mcp-approvals.json"), "private state paths differ");
  requireValue(!process.env.QWEN_SYSTEM_MD && !process.env.QWEN_SYSTEM_IDENTITY_MD && !process.env.QWEN_WRITE_SYSTEM_MD,
    "operator instruction environment leaked");
  const configPath = flag("--mcp-config"), logs = flag("--openai-logging-dir");
  requireValue(configPath === join(home, "mcp.json") && logs === join(home, "provider-logs"), "private paths missing");
  requireValue((statSync(home).mode & 0o777) === 0o700 && (statSync(configPath).mode & 0o777) === 0o600, "private modes differ");
  const settings = JSON.parse(readFileSync(process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, "utf8"));
  requireValue(settings.tools.toolSearch.enabled === false && !settings.mcpServers, "settings leaked an MCP server or discovery");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  requireValue(Object.keys(config.mcpServers).join() === "test", "unexpected MCP server");
  const server = config.mcpServers.test;
  requireValue(new URL(server.httpUrl).hostname === "127.0.0.1", "non-loopback relay");
  requireValue(server.trust === true && server.alwaysLoadTools === true && server.timeout === 120000, "server policy differs");
  const received = await Bun.stdin.text();
  requireValue(received === prompt, "literal stdin changed");
  const rpc = async (id: number, method: string, params?: JsonObject): Promise<JsonObject> => {
    const response = await fetch(server.httpUrl, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    requireValue(response.ok, `HTTP ${response.status}`);
    const reply = await response.json() as JsonObject;
    requireValue(!reply.error, `RPC error: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "synthetic-qwen", version: "0" } });
  const catalog = await rpc(2, "tools/list");
  requireValue(catalog.tools.length === 1 && catalog.tools[0].name === "bash", "unexpected server inventory");
  const args = { command: "constant" }, events = nativeEvents("bash", args);
  process.stdout.write(stdout(events.slice(0, 1)));
  const result = await rpc(3, "tools/call", { name: "bash", arguments: args });
  for (const [index, log] of evidence(catalog.tools[0], args, result).entries()) {
    writeFileSync(join(logs, `openai-${index}.json`), JSON.stringify(log));
  }
  writeFileSync(process.env.FAKE_QWEN_OBSERVED!, JSON.stringify({ argv, prompt: received, home, settings, names: catalog.tools.map((t: JsonObject) => t.name) }));
  process.stdout.write(stdout(events.slice(1)));
}
if (import.meta.main) await run();
