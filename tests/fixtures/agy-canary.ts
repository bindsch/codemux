// Synthetic CLI only: never starts a harness or contacts a model provider.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.3.3"); process.exit(0); }
if (readdirSync(process.cwd()).some((name) => name !== ".git")) throw new Error("canary cwd is not empty");
const emit = (event: string, value: object) => console.log(JSON.stringify({ event, [event]: value }));
const home = process.env.HOME!;
const settingsPath = join(home, ".gemini/antigravity-cli/settings.json");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
emit("init", { tools: ["command"], mcp_servers: Object.keys(settings.mcpServers ?? {}) });
const prompt = args.find((arg) => arg.startsWith("--print="))!;
let response = "OK";
if (prompt.includes("Run this shell command")) {
  if (settings.permissions?.deny.includes("command(*)")) {
    if (!args.includes("--mode=plan")) throw new Error("missing plan mode");
    emit("result", { status: "ERROR", response: "", denied_actions: [{ action: "command" }] });
    process.exit(1);
  }
  if (!args.includes("--dangerously-skip-permissions")) throw new Error("control cannot execute");
  response = [...prompt.match(/printf '%s' '([^']+)'/)![1]!].reverse().join("");
  emit("step_update", { step_type: "tool", tool_name: "run_command", state: "DONE",
    tool_info: { name: "run_command", output: response } });
} else {
  const instructions = join(home, ".gemini/GEMINI.md");
  if (existsSync(instructions)) response = readFileSync(instructions, "utf8").match(/CODEMUX-AGY-CANARY-[\w-]+/)![0];
}
emit("result", { status: "SUCCESS", response });
