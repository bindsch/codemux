/**
 * A scenario-driven fake of headless droid (the per-turn process behind
 * a droid session driver), built from the wire the session module pins
 * (src/session/droid-session.ts, droid 0.221.0): the turn is `droid
 * exec --output-format json [-m <id>] [--auto <level>]
 * [--reasoning-effort <v>] [-s <id>]` with the prompt on STDIN (the run
 * adapter's carrier, never argv), and stdout is exactly one result
 * object — the exec output writer builds
 * `{type:"result",subtype:isError?"failure":"success",is_error,
 * duration_ms,num_turns,result,session_id,usage}` and hands it to
 * process.stdout.write(JSON.stringify(e)+"\n") and nothing else (the
 * binary's ae builder at byte offset 153812787, the de early-failure
 * builder at 153812970, read 2026-11-09). The usage object is the
 * claude-family shape with droid-only extras (factory_credits,
 * thinking_tokens, ttft_ms). This fixture renders the wire itself and
 * imports nothing from src/ — the fixture models the harness, so the
 * codemux parser and this file are two independent renderings of the
 * same pinned source.
 *
 * The session identity: a resumed turn's argv carries `-s <id>` and its
 * result object must name that same id (the binary runs the turn under
 * exactly the resumed id); a fresh turn's argv carries no session flag
 * and the result object names the id the harness minted.
 *
 * The scenario is the prompt's `scenario:<name>` prefix. Everything
 * received (argv, stdin bytes) is recorded as JSONL under
 * $FAKE_STATE_DIR. An argv that breaks the launch contract (no exec
 * subcommand, or no --output-format json) prints nothing and exits 2 —
 * the fake fails closed rather than imitating a wire it was not given.
 *
 *   basic (default) — a success result object naming the resumed id
 *                     (or the minted id on a fresh turn), exit 0
 *   errorturn       — a failure result object (subtype "failure",
 *                     is_error true) naming the session id, exit 1
 *   nowire          — no result object at all, one stderr line,
 *                     exit 1: the driver's tier-3 fatal
 *   newid           — a success result object naming an id OTHER than
 *                     the resumed one (the wrong-session rule; on a
 *                     fresh turn it just names the other id), exit 0
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-droid-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

/** The -s value in every spelling commander accepts: `-s <id>`,
 * `--session-id <id>`, and the `=` forms. */
const flagValue = (args: readonly string[], names: readonly string[]): string | undefined => {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
    const eq = `${name}=`;
    const hit = args.find((arg) => arg.startsWith(eq));
    if (hit !== undefined) return hit.slice(eq.length);
  }
  return undefined;
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const prompt = await readStdin();
record("stdin.jsonl", { prompt, bytes: Buffer.byteLength(prompt, "utf8"), eof: true });

// The id this fake mints for a fresh session (the binary mints a v4
// UUID; any whitespace-free token exercises the same contract).
const MINTED_ID = "0fakeid0-1111-4222-8333-444444444444";
const OTHER_ID = "0otherid0-9999-4888-8777-666666666666";

const usage = () => ({
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 5,
  factory_credits: 1,
  thinking_tokens: 7,
  ttft_ms: 250,
});

const resultObject = (
  isError: boolean,
  sessionId: string,
  text: string
): string =>
  `${JSON.stringify({
    type: "result",
    subtype: isError ? "failure" : "success",
    is_error: isError,
    duration_ms: 1200,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    usage: usage(),
  })}\n`;

const contractHolds = args.includes("exec") && args.includes("json");
const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
const resumedId = flagValue(args, ["-s", "--session-id"]);
const sessionId = () => {
  if (scenario === "newid") return OTHER_ID;
  return resumedId ?? MINTED_ID;
};

if (!contractHolds) {
  // The launch broke the wire contract this fake exists to check: no
  // output that could be mistaken for a result object.
  process.stderr.write("fake droid: no exec subcommand or no --output-format json\n");
  process.exit(2);
}

switch (scenario) {
  case "errorturn":
    process.stdout.write(resultObject(true, sessionId(), "the model refused the turn"));
    process.exit(1);
  case "nowire":
    process.stderr.write("fake droid: dying before the result writer ran\n");
    process.exit(1);
  case "newid":
  case "basic":
  default:
    process.stdout.write(resultObject(false, sessionId(), `Done: ${prompt}`));
    process.exit(0);
  }
