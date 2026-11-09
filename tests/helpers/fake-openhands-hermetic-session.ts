// Synthetic openhands 1.16.0 peer for hermetic session tests. It reads only
// the directories its launch names: the private HOME, the persistence and
// conversation dirs, the task file, and the working directory.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1];
const state = process.env.FAKE_STATE_DIR!;
const home = process.env.HOME!;
const persistence = process.env.OPENHANDS_PERSISTENCE_DIR!;
const conversations = process.env.OPENHANDS_CONVERSATIONS_DIR!;
if (!state || !home || !persistence || !conversations || !args.includes("--headless") ||
    !args.includes("--json") || !args.includes("--override-with-envs")) throw new Error("missing fixture launch configuration");
const readOrNull = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
const resumed = args.includes("--resume");
const id = resumed ? flag("--resume")! : randomUUID();
mkdirSync(conversations, { recursive: true });
const transcript = join(conversations, `${id}.json`);
if (resumed && !existsSync(transcript)) throw new Error("fixture resume did not find its conversation");
const turns = resumed ? JSON.parse(readFileSync(transcript, "utf8")).turns + 1 : 1;
const task = flag("--file")!;
appendFileSync(join(state, "observations.jsonl"), JSON.stringify({
  home, persistence, conversations, args, task, prompt: readFileSync(task, "utf8"),
  homeMode: statSync(home).mode & 0o777,
  homeHooks: readOrNull(join(home, ".openhands", "hooks.json")),
  cwdHooks: readOrNull(join(process.cwd(), ".openhands", "hooks.json")),
  auth: typeof process.env.LLM_API_KEY === "string", id, turns,
}) + "\n");
writeFileSync(transcript, JSON.stringify({ id, turns }));
process.stdout.write(JSON.stringify({ kind: "MessageEvent", source: "agent",
  llm_message: { role: "assistant", content: [{ type: "text", text: `done ${turns}` }] } }) + "\n");
process.stdout.write(`Conversation ID: ${id.replaceAll("-", "")}\n`);
