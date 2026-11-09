/**
 * A scenario-driven fake of headless qwen (the per-turn process behind a
 * qwen session driver), built from the shapes the module pins
 * (src/session/qwen-session.ts; @qwen-code/qwen-code 0.24.0 bundle,
 * /opt/homebrew/lib/node_modules/@qwen-code/qwen-code/chunks/, read
 * 2026-11-09):
 *
 * - The launch is the run adapter's shape plus the session carrier:
 *   `qwen --safe-mode [--model M] --output-format json --approval-mode
 *   plan|default|auto|yolo (--session-id <minted> | --resume <minted>)`,
 *   and the PROMPT RIDES STDIN, never argv (the run adapter's
 *   getStdinInput).
 * - The binary's own refusals the fake reproduces byte for byte: "Cannot
 *   use both --continue and --resume together. Use --continue to resume
 *   the latest session, or --resume <sessionId> to resume a specific
 *   session." (chunk-HWKWZSZY.js byte 2063354), "Cannot use --session-id
 *   with --continue or --resume. Use --session-id to start a new session
 *   with a specific ID, or use --continue/--resume to resume an existing
 *   session." (byte 2063646), and `Invalid --session-id: "${...}". Must
 *   be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`
 *   (byte 2064276, the class at chunk-ZEZKIS2K.js byte 229).
 * - The output is ONE stdout line, JSON.stringify of the whole message
 *   array, with the result message pushed last (chunk-ZJBYZN5D.js byte
 *   3169); the result message's session_id comes from the session the
 *   flags selected (the chain src/session/qwen-session.ts traces through
 *   chunk-HWKWZSZY.js byte 2091593 and chunk-SNPYTKXI.js byte 6107940).
 *   The fake renders the wire itself — deliberately NOT an import of the
 *   codemux parser, so the builder and this file are two independent
 *   renderings of the same pinned source.
 *
 * The scenario is the prompt's `scenario:<name>` prefix. Everything
 * received (argv, stdin bytes) is recorded as JSONL under
 * $FAKE_STATE_DIR.
 *
 *   basic (default) — the message array with a success result message
 *                     naming the session id the flags selected, exit 0
 *   errorturn       — an error_during_execution result message with
 *                     error.message, exit 0: the wire itself reports the
 *                     failure, so the process code stays clean
 *   nowire          — plain text on stdout, exit 1: no array at all
 *                     (the driver's no-wire fatal)
 *   newid           — a success result message naming a DIFFERENT id
 *                     than the flags selected (the wrong-session
 *                     defect)
 *
 * Unknown scenarios fail closed: stderr note, exit 2, no wire.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-qwen-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });

const exitWith = (code: number, stderr: string): never => {
  process.stderr.write(stderr);
  record("turn.jsonl", { exit: code, scenario: null, stderr });
  process.exit(code);
};

// The binary's own argv rules (chunk-HWKWZSZY.js, quoted above). The fake
// models the codemux launch, so a command that breaks them is a fixture
// misuse and fails closed rather than guessing.
if (args.includes("--continue")) {
  if (args.includes("--resume")) {
    exitWith(
      1,
      "Cannot use both --continue and --resume together. Use --continue to resume the latest session, or --resume <sessionId> to resume a specific session."
    );
  }
  if (args.includes("--session-id")) {
    exitWith(
      1,
      "Cannot use --session-id with --continue or --resume. Use --session-id to start a new session with a specific ID, or use --continue/--resume to resume an existing session."
    );
  }
}
const outputIndex = args.indexOf("--output-format");
if (outputIndex === -1 || args[outputIndex + 1] !== "json") {
  exitWith(2, "fake-qwen-session: the session launch must pass --output-format json");
}
const sessionIdIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
if (sessionIdIndex !== -1 && resumeIndex !== -1) {
  exitWith(
    1,
    "Cannot use --session-id with --continue or --resume. Use --session-id to start a new session with a specific ID, or use --continue/--resume to resume an existing session."
  );
}
const flagIndex = sessionIdIndex !== -1 ? sessionIdIndex : resumeIndex;
if (flagIndex === -1) {
  exitWith(2, "fake-qwen-session: the session launch must pass --session-id or --resume");
}
const sessionFlag = sessionIdIndex !== -1 ? "--session-id" : "--resume";
const sessionId = args[flagIndex + 1] ?? "";
// The binary validates only the --session-id shape (isValidSessionId's
// class, case-insensitive); --resume takes any id and fails later on the
// ledger lookup instead.
const QWEN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (sessionFlag === "--session-id" && !QWEN_SESSION_ID.test(sessionId)) {
  exitWith(
    1,
    `Invalid --session-id: "${sessionId}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`
  );
}

// The prompt is the whole stdin stream; the turn starts once EOF lands.
const prompt = await Bun.stdin.text();
record("stdin.jsonl", { bytes: Buffer.byteLength(prompt), eof: true });

const scenario = /^scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";

/** One message array line with `result` as the result message (the
 * emission at chunk-ZJBYZN5D.js byte 3169). */
const wire = (result: Record<string, unknown>): string =>
  `${JSON.stringify([
    {
      // Every message names the session the flags selected; only the
      // result override (the newid defect) can drift.
      type: "user",
      uuid: "f-00000000-0000-4000-8000-000000000001",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: prompt },
    },
    {
      type: "result",
      subtype: "success",
      uuid: "f-00000000-0000-4000-8000-000000000002",
      session_id: sessionId,
      is_error: false,
      duration_ms: 42,
      duration_api_ms: 20,
      num_turns: 1,
      result: `Done: ${scenario}`,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 7 },
      permission_denials: [],
      ...result,
    },
  ])}\n`;

// A same-shape id that differs in the first nibble (the newid defect).
const otherId = sessionId.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));

const run = (name: string): { out: string; code: number } => {
  switch (name) {
    case "basic":
      return { out: wire({}), code: 0 };
    case "errorturn":
      // The failure rides the wire (is_error + error.message), so the
      // process itself still exits clean.
      return {
        out: wire({
          subtype: "error_during_execution",
          is_error: true,
          result: undefined,
          error: { message: "the model call failed" },
        }),
        code: 0,
      };
    case "nowire":
      return { out: "qwen: something failed before any turn\n", code: 1 };
    case "newid":
      return { out: wire({ session_id: otherId }), code: 0 };
    default:
      return { out: "", code: -1 };
  }
};

const turn = run(scenario);
if (turn.code === -1) {
  exitWith(2, `fake-qwen-session: unknown scenario ${scenario}\n`);
}
process.stdout.write(turn.out);
record("turn.jsonl", {
  exit: turn.code,
  scenario,
  sessionFlag,
  sessionId,
  stdoutBytes: Buffer.byteLength(turn.out),
});
process.exit(turn.code);
