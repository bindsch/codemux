// Fake control peer. Never starts a harness or sends a provider request.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const mode = process.argv[2] ?? "normal";
const send = (frame: object) => process.stdout.write(JSON.stringify(frame) + "\n");
const mcp = (id: string, message: object) => send({ type: "control_request", request_id: id,
  request: { subtype: "mcp_message", server_name: "experiment", message: { jsonrpc: "2.0", ...message } } });
let initId = "";
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    initId = frame.request_id;
    if (mode === "hang") continue;
    if (mode === "partial") { process.stdout.write('{"type":"control_request"'); continue; }
    mcp("init", { id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  } else if (frame.type === "control_response") {
    const response = frame.response;
    if (response.request_id === "init") mcp("initialized", { method: "notifications/initialized" });
    if (response.request_id === "initialized") {
      if (response.response.mcp_response !== undefined) throw new Error("notification received a JSON-RPC reply");
      mcp("list", { id: 1, method: "tools/list" });
    }
    if (response.request_id === "list") {
      send({ type: "control_response", response: { subtype: "success", request_id: initId, response: {} } });
      send({ type: "system", subtype: "init", tools: mode === "builtin" ? ["Bash"] : ["mcp__experiment__bash"] });
    }
    if (response.request_id === "call") {
      const result = response.response.mcp_response.result;
      if (mode !== "missing") send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1",
        content: mode === "changed" ? [{ type: "text", text: "Wall time: 1 seconds\nchanged" }] : result.content }] } });
      const answer = mode === "check-probe" ? "OK" : mode === "check-control"
        ? readFileSync("CLAUDE.md", "utf8") : "marker received";
      send({ type: "result", subtype: "success", is_error: false, result: answer, usage: {} });
      if (mode === "late-failure") {
        // A descendant holding the captured stderr open keeps the runner
        // waiting past this process's own exit, so the server's later exit
        // becomes a failure recorded after a successful finish.
        Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
        process.exit(0);
      }
    }
  } else if (frame.type === "user") {
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "mcp__experiment__bash", input: { command: mode === "late-failure" ? "exit-later" : "probe" } }] } });
    mcp("call", { id: 2, method: "tools/call", params: { name: "bash", arguments: { command: mode === "late-failure" ? "exit-later" : "probe" },
      _meta: { "claudecode/toolUseId": "tool-1" } } });
  }
}
