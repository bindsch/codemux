import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [observation, mode, ...args] = process.argv.slice(2);
if (!observation || !mode) throw new Error("synthetic observation and mode are required");
const state = process.env.XDG_STATE_HOME!;
const modelPath = join(state, "opencode/model.json");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
let timestamp = 0;
const isRun = args.includes("run");
const stdin = isRun ? await Bun.stdin.text() : "";
appendFileSync(observation, JSON.stringify({ args, stdin, cwd: process.cwd(), home: process.env.HOME,
  state, variant: existsSync(modelPath) ? JSON.parse(readFileSync(modelPath, "utf8")) : null,
  config, projectDisabled: process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1",
  pure: process.env.OPENCODE_PURE ?? null, nativeLlm: process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM ?? null }) + "\n");
if (!isRun) process.exit(mode === "failure" ? 7 : 0);
if (mode === "missing-evidence") {
  emit("text", { text: "retained reply" });
  emit("step_finish", { reason: "stop", cost: 0, tokens: { input: 3, output: 2 } });
  process.exit(0);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).startsWith("https://provider.invalid/")) {
    return new Response(JSON.stringify({ object: "chat.completion", model: "synthetic-served-model", choices: [] }),
      { headers: { "Content-Type": "application/json" } });
  }
  return originalFetch(input, init);
}) as typeof fetch;
const plugin = await import(config.plugin[0]);
const hooks = await plugin.default();
const relay = config.mcp.experiment;
let rpcId = 0;
async function rpc(method: string, params?: object) {
  const response = await fetch(relay.url, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${process.env.CODEMUX_OPENCODE_EXPERIMENT_TOKEN}`,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const data = await response.json() as Record<string, any>;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}
const sessionID = "ses_0123456789abcdef";
function emit(type: string, part: object) {
  process.stdout.write(JSON.stringify({ type, timestamp: timestamp += 1000, sessionID: "ses_0123456789abcdef",
    part: { messageID: "msg1", ...part } }) + "\n");
}
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  const inventory = await rpc("tools/list");
  const tools = inventory.tools.map((tool: Record<string, any>) => ({ type: "function", function: {
    name: `experiment_${tool.name}`, description: tool.description,
    parameters: { ...tool.inputSchema, additionalProperties: false },
  } }));
  const instruction = join(process.cwd(), "AGENTS.md");
  const marker = existsSync(instruction) ? readFileSync(instruction, "utf8").match(/CODEMUX-CANARY-[A-Z0-9]+/)?.[0] : undefined;
  const useMarker = marker && (!process.env.OPENCODE_DISABLE_PROJECT_CONFIG || mode === "leak-payload");
  const messages: Record<string, any>[] = [{ role: "user", content: useMarker ? marker : stdin }];
  const send = async () => {
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID }, output);
    const response = await fetch("https://provider.invalid/v1/chat/completions", {
      method: "POST", headers: output.headers, body: JSON.stringify({ model: "requested-model", tools, messages }),
    });
    await response.text();
  };
  await send();
  if (!mode.startsWith("canary") && mode !== "leak-payload") {
    const input = { command: "synthetic" };
    await hooks["tool.execute.before"]({ sessionID, callID: "call-1", tool: "experiment_bash" }, { args: input });
    const result = await rpc("tools/call", { name: "bash", arguments: input });
    const text = result.content.map((part: { text: string }) => part.text).join("\n\n");
    emit("tool_use", { id: "part-1", callID: "call-1", tool: "experiment_bash", state: { status: "completed", input, output: text } });
    emit("step_finish", { reason: "tool-calls", cost: 0, tokens: { input: 3, output: 2 } });
    messages.push({ role: "assistant", tool_calls: [{ id: "call-1", type: "function",
      function: { name: "experiment_bash", arguments: JSON.stringify(input) } }] },
    { role: "tool", tool_call_id: "call-1", content: mode === "changed-result" ? "rewritten" : text });
    await send();
  }
  emit("text", { text: mode === "canary" && useMarker ? marker! : "OK" });
  emit("step_finish", { reason: "stop", cost: 0, tokens: { input: 4, output: 1 } });
} finally { await hooks.dispose(); globalThis.fetch = originalFetch; }
if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 30_000));
