/**
 * A scenario-driven fake of headless copilot (the per-turn process behind
 * a copilot session driver), built from the wire the session module pins
 * (src/session/copilot-session.ts and src/result-envelope/copilot.ts,
 * copilot 1.0.103): the turn is `copilot --no-auto-update --no-bash-env
 * --no-remote --no-remote-export --no-custom-instructions
 * --no-experimental [--disable-builtin-mcps] [--model <m>] <autonomy
 * flags> (--session-id <id> | --resume <id>) --output-format json
 * --silent`, with the prompt on stdin, and stdout is JSONL —
 * `{type:"assistant.message", data:{content}}` events and a closing
 * `{type:"result", sessionId, exitCode}` line; `session.error` events
 * carry `data.message`. This fixture renders the wire itself and imports
 * nothing from src/ — the fixture models the harness, so the codemux
 * parser and this file are two independent renderings of the same
 * pinned source.
 *
 * The session identity: codemux mints the id, the first turn's argv
 * carries `--session-id <minted>`, later turns `--resume <minted>`, and
 * the result line must name that same id back.
 *
 * The scenario is the prompt's `scenario:<name>` prefix.
 * Everything received is recorded as JSONL under
 * $FAKE_STATE_DIR. An argv that breaks the launch contract (no json
 * output format, or an empty stdin prompt) prints nothing and exits 2 — the fake
 * fails closed rather than imitating a wire it was not given.
 *
 *   basic (default) — one assistant.message, a result line naming the
 *                     argv id with exitCode 0, exit 0
 *   errorturn       — a session.error event, a result line with
 *                     exitCode 1, exit 1
 *   nowire          — one plain-text line, no JSON at all, exit 1: the
 *                     driver's tier-3 fatal
 *   wrongid         — the result line names an id OTHER than the one the
 *                     argv carried (the wrong-session rule), exit 0
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runFakeCopilotRpc } from "./fake-copilot-session-parts/rpc.js";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-copilot-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });
if (args.includes("--headless") && args.includes("--stdio")) {
  await runFakeCopilotRpc(stateDir, record);
  process.exit(0);
}

/** The --session-id or --resume value in the spellings commander accepts. */
const flagValue = (
  args: readonly string[],
  names: readonly string[]
): string | undefined => {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
    const eq = `${name}=`;
    const hit = args.find((arg) => arg.startsWith(eq));
    if (hit !== undefined) return hit.slice(eq.length);
  }
  return undefined;
};

const prompt = await Bun.stdin.text();
record("stdin.jsonl", { prompt, bytes: Buffer.byteLength(prompt, "utf8"), eof: true });

const MINTED_ID = "0fakeid0-1111-4222-8333-444444444444";
const OTHER_ID = "0otherid0-9999-4888-8777-666666666666";

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const contractHolds = args.includes("json") && prompt.length > 0 &&
  !args.some((arg) => arg.startsWith("--prompt="));
const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
const namedId = () => {
  if (scenario === "wrongid") return OTHER_ID;
  return flagValue(args, ["--session-id", "--resume"]) ?? MINTED_ID;
};

if (!contractHolds) {
  // The launch broke the wire contract this fake exists to check: no
  // output that could be mistaken for a JSONL event.
  process.stderr.write("fake copilot: no json output format or no stdin prompt\n");
  process.exit(2);
}

switch (scenario) {
  case "errorturn":
    emit({ type: "session.error", timestamp: "now", data: { message: "the model call failed" } });
    emit({ type: "result", timestamp: "now", sessionId: namedId(), exitCode: 1 });
    process.exit(1);
  case "nowire":
    process.stdout.write("fake copilot: dying before the JSONL writer ran\n");
    process.exit(1);
  case "wrongid":
  case "basic":
  default:
    emit({
      type: "assistant.message",
      timestamp: "now",
      data: { content: `Done: ${prompt}`, model: "copilot-fixture-model" },
    });
    emit({ type: "result", timestamp: "now", sessionId: namedId(), exitCode: 0 });
    process.exit(0);
}
