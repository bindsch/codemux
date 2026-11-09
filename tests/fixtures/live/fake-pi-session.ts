/**
 * A scenario-driven fake of headless pi (the per-turn process behind a
 * pi session driver), built from the shapes the bundle pins
 * (chunk-JVUZSMYM.js, 0.85.1): the prompt arrives on STDIN (piped stdin
 * becomes the turn's initial message; argv carries no prompt), stdout in
 * `--mode json` is the newline event wire — a `{type:"session",version,
 * id,timestamp,cwd}` header line FIRST (runPrintMode writes
 * getHeader() ahead of every event), then one JSON line per event — and
 * message ends are `{type:"message_end",message}` with the answer on the
 * assistant message's `content` text blocks, `usage` in camelCase
 * ({input, output, cacheRead, cacheWrite, cost:{total}}), `model`, and
 * `stopReason`. Json mode never raises the process exit code for a
 * failed stopReason (only the text branch does), so the errorturn
 * scenario exits 0 with the failure on the wire — the shape the turn
 * parse must read. The wire renders below are this fixture's OWN copy of
 * the bundle's shapes, deliberately NOT an import of codemux's parsers:
 * the fixture models the harness, so the module and this file are two
 * independent renderings of the same pinned source.
 *
 * The scenario is the prompt's `scenario:<name>` prefix; everything
 * received (argv, stdin bytes) is recorded as JSONL under
 * $FAKE_STATE_DIR, plus one session.jsonl line per turn naming the
 * header id the fake printed.
 *
 *   basic (default) — the header echoes the argv --session-id, the user
 *                     and assistant message_end events follow, the
 *                     assistant carries text, usage, and a model, exit 0
 *   errorturn       — the assistant message_end carries
 *                     stopReason "error" and an errorMessage, exit 0
 *                     (json mode's pinned behavior: the structured
 *                     report, not the exit code, carries the failure)
 *   nowire          — nothing on stdout, one stderr line, exit 1 (the
 *                     caught-exception shape: an error message and no
 *                     event wire at all)
 *   newid           — the header names a session id OTHER than the argv
 *                     --session-id value (a harness that resolved the
 *                     flag to a foreign session): otherwise like basic,
 *                     so the turn parse's wrongSession check is live
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-pi-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};

const sessionId = flagValue("--session-id");
const mode = flagValue("--mode");
// The id a `newid` turn wrongly names instead: a well-shaped UUID no
// codemux turn would have minted for this session.
const FOREIGN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MODEL = "fake-pi-model";

const wire = (line: unknown): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/** newSession's header entry, the wire's opening line (the runPrintMode
 * write is `JSON.stringify(header) + "\n"` before any event). */
const headerLine = (id: string): void => {
  wire({
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
};

/** The bus spells a message turn as a message_start/message_end pair
 * over the same message object. */
const messageEvents = (message: Record<string, unknown>): void => {
  wire({ type: "message_start", message });
  wire({ type: "message_end", message });
};

const usage = (input: number, output: number, cacheRead: number): Record<string, unknown> => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { total: 0.01 },
});

/** Runs one scenario; every scenario but nowire prints a wire. */
const runTurn = (scenario: string, prompt: string): void => {
  const headerId =
    scenario === "newid" ? FOREIGN_ID : sessionId ?? "00000000-0000-4000-8000-000000000000";
  switch (scenario) {
    case "nowire":
      // The thrown-error shape: a stderr message, an empty stdout, and
      // exit 1 — the no-wire fatal a turn parse must report.
      process.stderr.write("Error: no provider configured\n");
      record("session.jsonl", { scenario, argvSessionId: sessionId ?? null, headerId: null });
      process.exit(1);
    case "errorturn":
      headerLine(headerId);
      messageEvents({ role: "user", content: [{ type: "text", text: prompt }] });
      messageEvents({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "the model refused the turn",
        usage: usage(120, 0, 0),
        model: MODEL,
      });
      record("session.jsonl", { scenario, argvSessionId: sessionId ?? null, headerId, mode });
      process.exit(0);
    case "newid":
    case "basic":
    default:
      headerLine(headerId);
      messageEvents({ role: "user", content: [{ type: "text", text: prompt }] });
      messageEvents({
        role: "assistant",
        content: [{ type: "text", text: `Done: ${prompt}` }],
        stopReason: "stop",
        usage: usage(120, 30, 10),
        model: MODEL,
      });
      record("session.jsonl", { scenario, argvSessionId: sessionId ?? null, headerId, mode });
      process.exit(0);
  }
};

// The prompt is the whole stdin stream (pi's readPipedStdin): the turn
// runs once stdin reaches EOF, so the driver's feeder pipe closes and
// the fake never answers before the full prompt landed.
let prompt = "";
let stdinBytes = 0;
let sawEof = false;
let rpcPrompt = "";
let rpcBuffer = "";
const rpcComplete = (aborted: boolean): void => {
  messageEvents({ role: "assistant", content: [{ type: "text", text: `Done: ${rpcPrompt}` }],
    stopReason: aborted ? "aborted" : "stop", usage: usage(120, 30, 10), model: MODEL });
  wire({ type: "agent_end" });
  wire({ type: "agent_settled" });
  record("session.jsonl", { scenario: aborted ? "aborted" : "basic", argvSessionId: sessionId ?? null, headerId: sessionId, mode });
};
const rpcCommand = (line: string): void => {
  const request = JSON.parse(line);
  record("rpc.jsonl", request);
  if (request.type === "get_state") {
    wire({ type: "response", command: "get_state", id: request.id, success: true, data: { sessionId } });
  } else if (request.type === "prompt") {
    rpcPrompt = request.message;
    wire({ type: "response", command: "prompt", id: request.id, success: true });
    messageEvents({ role: "user", content: [{ type: "text", text: rpcPrompt }] });
    if (rpcPrompt.startsWith("scenario:retry")) {
      messageEvents({ role: "assistant", content: [], stopReason: "error", errorMessage: "retryable",
        usage: usage(0, 0, 0), model: MODEL });
      wire({ type: "agent_end", willRetry: true });
      setTimeout(() => rpcComplete(false), 25);
    } else if (!rpcPrompt.startsWith("scenario:hold")) rpcComplete(false);
  } else if (request.type === "abort") {
    rpcComplete(true);
    wire({ type: "response", command: "abort", id: request.id, success: true });
  } else {
    wire({ type: "response", command: request.type, id: request.id, success: false, error: "unknown RPC command" });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  prompt += chunk;
  stdinBytes += Buffer.byteLength(chunk);
  if (mode === "rpc") {
    rpcBuffer += chunk;
    let end: number;
    while ((end = rpcBuffer.indexOf("\n")) >= 0) {
      rpcCommand(rpcBuffer.slice(0, end));
      rpcBuffer = rpcBuffer.slice(end + 1);
    }
  }
});
process.stdin.on("end", () => {
  sawEof = true;
  record("stdin.jsonl", { bytes: stdinBytes, eof: sawEof });
  if (mode === "rpc") process.exit(rpcBuffer.length === 0 ? 0 : 1);
  const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
  runTurn(scenario, prompt);
});
// A stdin that never ends would hang the turn forever; stay alive only
// for the stream itself (no timers), so an EOF-less spawn dies with the
// driver's teardown instead of lingering.
