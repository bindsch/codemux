/**
 * A scenario-driven fake of the agy stream-json harness, built from the
 * shapes pinned by the step-0 fixture (agy-session.ndjson) and the 1.2.14
 * help text. The e2e tests drive the real driver against this script
 * instead of a recorded transcript, so every round-trip is live.
 *
 * Protocol: claude-style NDJSON user frames on stdin (the input line the
 * fixture recorded), `event`-keyed result frames on stream-json stdout.
 * There is no init frame — a fresh agy session names its conversation
 * only in the first result envelope, which is the identity model the
 * driver implements. The scenario for a turn is selected by the user
 * text's `scenario:<name>` prefix:
 *
 *   basic    — a successful result naming the conversation
 *   errorturn — a result with the right conversation but status ERROR
 *               (the turn fails, the session continues)
 *   authfail — the fixture's auth-failure frame verbatim: an empty
 *              conversation_id, status ERROR, then exit 1
 *   wait     — no result until the stdin close, which finishes the
 *              turn (unless FAKE_IGNORE_EOF=1 or FAKE_SIGTERM_PERSIST)
 *   crash    — exit 1 with no result
 *   garbage  — a non-JSON line, then nothing (tier-3 fatal)
 *   wrongid  — a successful result naming a DIFFERENT conversation
 *              (tier-2 once an id is adopted: on a resumed session from
 *              the first result, on a fresh one from the second, since
 *              the first result's id is the one a fresh session adopts)
 *   noevent  — a JSON object with no `event` key (tier-2)
 *   badresult — a result frame whose envelope carries no status (tier-2)
 *
 * The conversation named by results is the `--conversation=<id>` value
 * when one was passed (resume), else $FAKE_CONV_ID (default
 * conv-fake-1). Everything received (argv, user texts) is recorded as
 * JSONL under $FAKE_STATE_DIR for the assertions. Mid-turn user lines
 * queue harness-side — codemux never sends one (user_during_turn is
 * false), so this path is unobservable through the driver; it models
 * the help text's "runs a turn for each" reading.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-agy-session";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_VERSION ?? "1.2.14"}\n`);
  process.exit(0);
}

record("argv.jsonl", { args, pid: process.pid });

const resumeArg = args.find((arg) => arg.startsWith("--conversation="));
const conversationId = resumeArg?.slice("--conversation=".length) ??
  process.env.FAKE_CONV_ID ??
  "conv-fake-1";

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const result = (fields: Record<string, unknown>): void => {
  write({ event: "result", result: fields });
};

const successResult = (text: string): void => {
  // No `error` field: the shipped envelope parser treats any present
  // error string (empty included) as a failure, and the documented
  // shape carries `error` on failing envelopes only.
  result({
    conversation_id: conversationId,
    status: "SUCCESS",
    response: `Done: ${text}`,
    duration_seconds: 1,
    num_turns: 1,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      thinking_tokens: 5,
      cache_read_tokens: 40,
      total_tokens: 120,
    },
  });
};

/** Runs one scenario; true when it answered with a frame and the turn
 * closed, false when the turn stays open (wait/crash/garbage and the
 * tier-2 shapes — the process never recovers those). */
const runTurn = (scenario: string, text: string): boolean => {
  switch (scenario) {
    case "basic":
      successResult(text);
      return true;
    case "errorturn":
      result({
        conversation_id: conversationId,
        status: "ERROR",
        response: "",
        error: "the model refused the turn",
        duration_seconds: 1,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 10,
        },
      });
      return true;
    case "authfail":
      // The frame the fixture recorded, verbatim in every field.
      result({
        conversation_id: "",
        status: "ERROR",
        response: "",
        error: "authentication failed or timed out",
        duration_seconds: 0,
        num_turns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      });
      setTimeout(() => {
        process.stderr.write(
          "Error: authentication required. Run 'agy' to log in, then retry.\n"
        );
        process.exit(1);
      }, 100);
      return false;
    case "wait":
      return false;
    case "crash":
      setTimeout(() => process.exit(1), 100);
      return false;
    case "garbage":
      process.stdout.write("this is not json\n");
      return false;
    case "wrongid":
      result({
        conversation_id: "conv-other-9",
        status: "SUCCESS",
        response: "wrong conversation",
        duration_seconds: 1,
        num_turns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 2,
        },
      });
      return true;
    case "noevent":
      write({ type: "system", subtype: "ambient" });
      return false;
    case "badresult":
      write({ event: "result", result: {} });
      return false;
    default:
      successResult(text);
      return true;
  }
};

let turnActive = false;
const inputQueue: string[] = [];

const runUserText = (text: string): void => {
  const scenario = /^scenario:([a-z0-9-]+)/.exec(text)?.[1] ?? "basic";
  const answered = runTurn(scenario, text);
  if (answered) {
    turnActive = false;
    const next = inputQueue.shift();
    if (next !== undefined) runUserText(next);
    return;
  }
  // The turn stays open until the process dies; further input queues.
  turnActive = true;
};

const handleLine = (line: string): void => {
  if (line.trim() === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const event = parsed as Record<string, unknown>;
  if (event["type"] === "user") {
    const message = event["message"] as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.["content"]) ? (message?.["content"] as Record<string, unknown>[]) : [];
    const text = typeof content[0]?.["text"] === "string" ? (content[0]["text"] as string) : "";
    record("input-lines.jsonl", { text });
    if (turnActive) {
      inputQueue.push(text);
      return;
    }
    runUserText(text);
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  let buffer = chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    handleLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
// The stdin close ends the input loop after the line it is running: an
// open turn finishes with its result first, then the process exits 0 —
// the claude-style loop's shape (step-0 probe 7), which is agy's only end
// carrier since it has no interrupt (review live17). Under
// FAKE_SIGTERM_PERSIST the close is ignored instead: those modes model a
// harness that answers only the shutdown signal, so codemux's answer
// window runs out and the SIGTERM below decides the outcome; FAKE_IGNORE_EOF=1
// ignores it too but keeps the default SIGTERM disposition (die at once,
// never answering), the shape whose open turn codemux must synthesize.
process.stdin.on("end", () => {
  if (process.env.FAKE_SIGTERM_PERSIST !== undefined || process.env.FAKE_IGNORE_EOF === "1") {
    // Nothing else holds the event loop once stdin is gone; stay alive
    // for the signal.
    setInterval(() => {}, 60_000);
    return;
  }
  if (!turnActive) process.exit(0);
  successResult("finished after the stdin close");
  turnActive = false;
  // Let the pipe take the result before the exit.
  setTimeout(() => process.exit(0), 50);
});

// FAKE_SIGTERM_PERSIST=1: survive the shutdown SIGTERM for a moment and,
// if a turn is still open, answer it with a final result envelope before
// exiting — output arriving inside the grace window, which the drain
// tests pin as delivered. =garbage additionally writes one non-JSON line
// first — a harness emitting unusable output inside the grace window,
// which the live7 regression pins as costing success rather than being
// absorbed by the already-running end path. =exit1 answers like =1 and
// then exits 1: a delivered result no longer excuses a nonzero exit
// (review live18). =exit42 answers nothing: the
// turn stays open and the process exits 42 — an agy failing while
// persisting during the shutdown, the live9 shape whose cost the driver
// must report (exit 1, not 0). =exit143 is the same silence with exit
// code 143 — a wrapper answering the SIGTERM with an exit code instead
// of dying by signal (the scode spelling), which must NOT be read as the
// live9 failure (review live11). These modes prove codemux's drain
// behavior, not a claim about what the real harness does on SIGTERM
// (nothing in the recorded fixture or help text evidences that). Without
// the env the default SIGTERM disposition applies (die at once).
const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (
  persistMode === "1" ||
  persistMode === "exit1" ||
  persistMode === "garbage" ||
  persistMode === "exit42" ||
  persistMode === "exit143"
) {
  process.on("SIGTERM", () => {
    if (persistMode === "garbage") {
      process.stdout.write("this line is not json\n");
    }
    if (persistMode !== "exit42" && persistMode !== "exit143") {
      if (turnActive) successResult("drained after the shutdown signal");
      turnActive = false;
    }
    setTimeout(
      () =>
        process.exit(
          persistMode === "exit42" ? 42 : persistMode === "exit143" ? 143 : persistMode === "exit1" ? 1 : 0
        ),
      300
    );
  });
}
