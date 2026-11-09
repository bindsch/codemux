/**
 * A scenario-driven fake of headless cursor-agent (the per-turn process
 * behind a future cursor session driver), built from the shapes the
 * session module pins (src/session/cursor-session.ts, 2026.11.05): the
 * prompt rides STDIN (never argv), the session identity rides argv as
 * `--new-session-id <uuid>` (the fresh turn's claim) or `--resume <uuid>`
 * (every later turn), and a `--print --output-format json` process prints
 * exactly ONE result line on stdout —
 * `{type:"result",subtype:"success",is_error:false,duration_ms,
 * duration_api_ms,result:<string>,session_id,request_id,usage?}` — with
 * a failed run printing NO result line (the error goes to stderr, exit
 * 1). The usage object is the claude-family shape and the key is absent
 * when the run reported none. No session driver has landed yet, so no
 * e2e test drives this script (README.md marks it manual-only); the
 * unit tests of src/session/cursor-session.ts pin the same wire, and
 * this fixture drives the driver when it lands.
 * The wire writes below are the fixture's own rendering of the bundle's
 * result writer (1706.index.js, read 2026-11-09), deliberately NOT an
 * import of parseCursorSessionTurn: the fixture models the harness, so
 * codemux's parser and this file are two independent renderings of the
 * same pinned source (the fake-aider-run.ts convention, review D1).
 *
 * The scenario is the prompt's `scenario:<name>` prefix; everything
 * received (argv, stdin bytes) is recorded as JSONL under
 * $FAKE_STATE_DIR.
 *
 *   basic (default) — one result line naming the argv session id, exit 0
 *   errorturn       — an is_error result line (subtype
 *                     error_during_execution), exit 1: the turn fails on
 *                     the structured report, not just the exit code
 *   nowire          — no result line, garbage stdout and the error on
 *                     stderr, exit 1: the driver's no-wire fatal
 *   newid           — a result line naming a DIFFERENT well-shaped id
 *                     than the argv one (a fresh claim answered under
 *                     another session): the driver's wrong-session rule
 *
 * FAKE_SIGTERM_PERSIST=hold traps SIGTERM and never exits on it — only
 * the tree SIGKILL of a second signal ends the process (the fake-aider
 * escalation convention). Without the env the default SIGTERM disposition
 * applies.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-cursor-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

// The handler is installed BEFORE the argv record below is written (the
// fake-aider rule), so "the turn child spawned" (the record the tests
// wait on) already implies "it can survive SIGTERM"; no boot race is
// left open.
if (process.env.FAKE_SIGTERM_PERSIST === "hold") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

/** The session identity the builder's argv carries: `--new-session-id
 * <id>` (fresh claim), `--resume <id>`, or either flag's `=` spelling.
 * Null when the argv named none (a malformed command). */
const sessionIdFromArgv = (argv: readonly string[]): string | null => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--new-session-id" || arg === "--resume") {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) return value;
      continue;
    }
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length);
    if (arg.startsWith("--new-session-id=")) {
      return arg.slice("--new-session-id=".length);
    }
  }
  return null;
};

// A second, well-shaped UUIDv4 mint (version nibble 4, variant 9) the
// newid scenario answers under, and the fallback id a malformed argv
// still gets: the real harness always runs inside SOME session.
const OTHER_SESSION_ID = "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d";
const FALLBACK_SESSION_ID = "0e1f2a3b-4c5d-4a7b-8c9d-1a2b3c4d5e6f";

/** The result writer's own line (1706.index.js): one JSON object, the
 * field set the bundle writes, a trailing newline. */
const writeResultLine = (fields: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 12,
      duration_api_ms: 10,
      result: "",
      session_id: FALLBACK_SESSION_ID,
      request_id: "req-fake-1",
      ...fields,
    })}\n`
  );
};

// The prompt is the whole stdin stream; the turn runs once it ends.
let prompt = "";
let stdinBytes = 0;
let sawEof = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  stdinBytes += Buffer.byteLength(chunk);
  prompt += chunk;
});
process.stdin.on("end", () => {
  sawEof = true;
  const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
  const sessionId = sessionIdFromArgv(args) ?? FALLBACK_SESSION_ID;
  const usage = {
    input_tokens: 11,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  switch (scenario) {
    case "errorturn":
      writeResultLine({
        subtype: "error_during_execution",
        is_error: true,
        result: "the model refused the turn",
        session_id: sessionId,
        usage,
      });
      process.exit(1);
      break;
    case "nowire":
      // A failed run prints no result line: noise on stdout, the error
      // on stderr, exit 1.
      process.stdout.write("not json at all\nstill not json\n");
      process.stderr.write("Error: the request failed\n");
      process.exit(1);
      break;
    case "newid":
      writeResultLine({
        result: `Done: ${prompt}`,
        session_id: OTHER_SESSION_ID,
        usage,
      });
      process.exit(0);
      break;
    case "basic":
    default:
      writeResultLine({ result: `Done: ${prompt}`, session_id: sessionId, usage });
      process.exit(0);
  }
});
process.on("exit", () => {
  record("stdin.jsonl", { prompt, bytes: stdinBytes, eof: sawEof });
});
