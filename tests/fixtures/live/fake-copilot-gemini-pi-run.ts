import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [agent, ...args] = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
const providerFile = process.env.COPILOT_PROVIDERS_CONFIG;
// A copilot --result-json run is the observed RPC session (launch.ts
// prepareCopilotModelRun): stdin is the framed protocol, and the prompt
// arrives in session.send, which this observation records as its stdin.
if (agent === "copilot" && args.includes("--headless") && args.includes("--stdio")) {
  const { runFakeCopilotRpc } = await import("./fake-copilot-session-parts/rpc.js");
  const state = mkdtempSync(join(tmpdir(), "w3-copilot-rpc-"));
  let session: unknown = null;
  const observe = (prompt: string) => writeFileSync(process.env.W3_OBSERVATION!, JSON.stringify({ args, stdin: prompt, policy: null,
    settings: null, session, provider: providerFile === undefined ? null : JSON.parse(readFileSync(providerFile, "utf8")) }));
  observe("");
  await runFakeCopilotRpc(state, (name, packet) => {
    const frame = packet as { method?: string; params?: { prompt?: unknown } };
    if (name === "rpc.jsonl" && frame.method === "session.create") session = frame.params;
    if (name === "rpc.jsonl" && frame.method === "session.send") observe(String(frame.params?.prompt));
  });
  process.exit(0);
}
const stdin = readFileSync(0, "utf8");
const geminiHome = process.env.GEMINI_CLI_HOME;
const policy = args.includes("--policy") ? readFileSync(value("--policy")!, "utf8") : null;
const settings = geminiHome === undefined ? null
  : JSON.parse(readFileSync(join(geminiHome, ".gemini", "settings.json"), "utf8"));
writeFileSync(process.env.W3_OBSERVATION!, JSON.stringify({
  args, stdin, policy, settings,
  provider: providerFile === undefined ? null : JSON.parse(readFileSync(providerFile, "utf8")),
  endpoint: process.env.COPILOT_PROVIDER_BASE_URL ?? process.env.GOOGLE_GEMINI_BASE_URL,
}));
const usage = { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 };
if (agent === "copilot") {
  if (args.includes("--usage-output-file")) {
    writeFileSync(value("--usage-output-file")!, JSON.stringify({ modelMetrics: { served: { usage } } }));
  }
  console.log(JSON.stringify({ type: "assistant.message", data: { content: "OK", model: "served" } }));
  console.log(JSON.stringify({ type: "result", exitCode: 0, sessionId: "synthetic-session" }));
} else if (agent === "gemini") {
  console.log(JSON.stringify({ response: "OK", stats: {
    input_tokens: 13, output_tokens: 2, cached: 3, total_tokens: 15,
  } }));
} else if (agent === "pi") {
  const message = { role: "assistant", model: "served",
    stopReason: "stop", content: [{ type: "text", text: "OK" }],
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  };
  if (args.includes("--extension")) {
    const context = { model: { id: "served", provider: "synthetic", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      abort() { budgetAborted = true; } };
    let budgetAborted = false;
    const handlers = new Map<string, (event: Record<string, unknown>, ctx: typeof context) => unknown>();
    const extension = await import(pathToFileURL(value("--extension")!).href);
    extension.default({ on: (name: string, handler: (event: Record<string, unknown>, ctx: typeof context) => unknown) => handlers.set(name, handler) });
    for (const event of ["before_agent_start", "before_provider_request"]) await handlers.get(event)!({}, context);
    await handlers.get("message_end")!({ message }, context);
    await handlers.get("agent_settled")!({}, context);
    const observed = JSON.parse(readFileSync(process.env.W3_OBSERVATION!, "utf8"));
    writeFileSync(process.env.W3_OBSERVATION!, JSON.stringify({ ...observed, budgetAborted }));
  }
  console.log(JSON.stringify({ type: "message_end", message }));
} else throw new Error("unexpected synthetic agent");
