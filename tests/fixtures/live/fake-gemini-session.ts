/**
 * A scenario-driven fake of headless gemini (the per-turn process behind
 * a gemini session driver), built from the wire the session module pins
 * (src/session/gemini-session.ts, gemini 0.60.0): the turn is `gemini
 * --sandbox=false [-m <model>] --approval-mode <mode> --output-format
 * stream-json (--session-id <id> | --resume <id>) -p <prompt>`, and
 * stdout is the stream-json event sequence — `{type:"init", session_id,
 * model}` first, `{type:"message", role:"assistant", content, delta?}`
 * chunks (delta true while streaming, the complete message last), and
 * `{type:"result", status, stats}` closing. This fixture renders the
 * wire itself and imports nothing from src/ — the fixture models the
 * harness, so the codemux parser and this file are two independent
 * renderings of the same pinned source.
 *
 * The session identity: codemux mints the id, the first turn's argv
 * carries `--session-id <minted>`, later turns `--resume <minted>`, and
 * the init event must echo that same id back — anything else is the
 * wrong-session defect.
 *
 * The scenario is the prompt's `scenario:<name>` prefix. Everything
 * received (argv, stdin bytes) is recorded as JSONL under
 * $FAKE_STATE_DIR. An argv that breaks the launch contract (no
 * stream-json output format, or no prompt) prints nothing and exits 2 —
 * the fake fails closed rather than imitating a wire it was not given.
 *
 *   basic (default) — init echo, two delta chunks, the complete message,
 *                     a success result with stats, exit 0
 *   errorturn       — init echo, an error-severity event, an error
 *                     result with {type, message}, exit 1
 *   nowire          — one plain-text line, no JSON at all, exit 1: the
 *                     driver's tier-3 fatal
 *   wrongid         — the init event names an id OTHER than the one the
 *                     argv carried (the wrong-session rule), exit 0
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-gemini-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

if (args.includes("--acp")) {
  const { runGeminiAcpFixture } = await import("./fake-gemini-session-parts/acp.js");
  await runGeminiAcpFixture(stateDir);
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

// Headless stdin is prepended to the optional -p text by Gemini 0.60.0.
const input = await new Response(Bun.stdin.stream()).text();
const suffix = flagValue(args, ["-p", "--prompt"]) ?? "";
const prompt = input && suffix ? `${input}\n\n${suffix}` : input || suffix;
record("stdin.jsonl", { prompt, bytes: Buffer.byteLength(prompt, "utf8"), eof: true });

const MINTED_ID = "0fakeid0-1111-4222-8333-444444444444";
const OTHER_ID = "0otherid0-9999-4888-8777-666666666666";

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const contractHolds =
  args.includes("stream-json") &&
  (args.includes("-p") || args.some((arg) => arg.startsWith("--prompt")));
const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
const namedId = () => {
  if (scenario === "wrongid") return OTHER_ID;
  return flagValue(args, ["--session-id", "--resume"]) ?? MINTED_ID;
};

if (!contractHolds) {
  // The launch broke the wire contract this fake exists to check: no
  // output that could be mistaken for a stream event.
  process.stderr.write("fake gemini: no stream-json output format or no prompt\n");
  process.exit(2);
}

switch (scenario) {
  case "errorturn":
    emit({ type: "init", timestamp: "now", session_id: namedId(), model: "gemini-2.6-pro" });
    emit({ type: "error", timestamp: "now", severity: "error", message: "the model call failed" });
    emit({
      type: "result",
      timestamp: "now",
      status: "error",
      error: { type: "error", message: "the model call failed" },
      stats: { input_tokens: 3, output_tokens: 1 },
    });
    process.exit(1);
  case "nowire":
    process.stdout.write("fake gemini: dying before the stream writer ran\n");
    process.exit(1);
  case "wrongid":
  case "basic":
  default:
    emit({ type: "init", timestamp: "now", session_id: namedId(), model: "gemini-2.6-pro" });
    emit({ type: "message", timestamp: "now", role: "assistant", content: "Do", delta: true });
    emit({ type: "message", timestamp: "now", role: "assistant", content: "ne", delta: true });
    emit({ type: "message", timestamp: "now", role: "assistant", content: `Done: ${prompt}` });
    emit({
      type: "result",
      timestamp: "now",
      status: "success",
      stats: {
        input_tokens: 100,
        output_tokens: 20,
        cached: 10,
        thoughts_tokens: 5,
        total_tokens: 130,
      },
    });
    process.exit(0);
}
