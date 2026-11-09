import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Independent synthetic CLI peer. It reads only the supplied fixture roots.
const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1];
const state = process.env.FAKE_STATE_DIR!;
const home = process.env.HOME!;
const persistence = process.env.OPENHANDS_PERSISTENCE_DIR!;
const conversations = process.env.OPENHANDS_CONVERSATIONS_DIR!;
if (!state || !home || !persistence || !conversations || !args.includes("--headless") ||
    !args.includes("--json") || !args.includes("--override-with-envs")) throw new Error("missing fixture launch configuration");
const resumed = args.includes("--resume");
const id = resumed ? flag("--resume")! : randomUUID();
mkdirSync(conversations, { recursive: true });
const transcript = join(conversations, `${id}.json`);
if (resumed && !existsSync(transcript)) throw new Error("fixture resume did not find its caller conversation");
const turns = resumed ? JSON.parse(readFileSync(transcript, "utf8")).turns + 1 : 1;
const task = flag("--file")!;
const prompt = readFileSync(task, "utf8");
const settings = readFileSync(join(persistence, "agent_settings.json"), "utf8");
appendFileSync(join(state, "observations.jsonl"), JSON.stringify({
  home, persistence, conversations, secondary: process.env.PERSISTENCE_DIR, args, task, prompt, settings,
  auth: typeof process.env.LLM_API_KEY === "string", id, turns,
}) + "\n");
writeFileSync(transcript, JSON.stringify({ id, turns }));
process.stdout.write(JSON.stringify({ kind: "MessageEvent", source: "agent",
  llm_message: { role: "assistant", content: [{ type: "text", text: `done ${turns}` }] } }) + "\n");
process.stdout.write(`Conversation ID: ${id.replaceAll("-", "")}\n`);
