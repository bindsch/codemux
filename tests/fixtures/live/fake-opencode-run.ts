/**
 * A scenario-driven fake of `opencode run --format json` (the per-turn
 * process behind the opencode session driver), built from the shapes the
 * installed 1.18.18 binary's run command prints (opencode-session.ts pins
 * them: one JSON object per line of `{type, timestamp, sessionID, …}`). The
 * e2e tests drive the real driver against this script, so every
 * round-trip — prompt-on-stdin, the JSON line tiers, the exit-code
 * verdicts — is live.
 *
 * Protocol: the prompt is the whole non-TTY stdin read to EOF (the wire's
 * one-shot message), the scenario is the prompt's `scenario:<name>`
 * prefix, and the session named by every line is the `--session <id>`
 * value when one was passed (resume), else $FAKE_SESSION_ID (default
 * ses_fake1234567890 — a fresh session mints its id in its first line,
 * the driver's deferred-identity model). Everything received (argv,
 * prompts) is recorded as JSONL under $FAKE_STATE_DIR for the assertions.
 *
 *   basic (default) — step_start, a text part, step_finish (tokens and
 *                     cost), exit 0
 *   tools           — a tool_use part before the text, exit 0
 *   errorturn       — an error line, then exit 1: the turn fails with
 *                     the error line as its reason, the session survives
 *   silentfail      — no lines at all, exit 1 (mid-session: the turn
 *                     fails on the exit code alone)
 *   crash           — no lines at all, exit 1 on the FIRST turn: the
 *                     session is never identified and must end
 *   wait            — step_start only, then nothing (the turn stays
 *                     open until a signal ends the process)
 *   wrongid         — lines naming a DIFFERENT session id (tier-2 once
 *                     an id is adopted — only meaningful from turn 2)
 *   nosession       — a line with no sessionID (tier-2)
 *   notype          — a JSON object with no `type` key (tier-2)
 *   garbage         — a non-JSON line, then nothing (tier-3)
 *
 * FAKE_SIGTERM_PERSIST covers the shutdown drain, the agy fake's modes:
 * =1 survives the shutdown SIGTERM and answers the open turn (text +
 * step_finish) before exiting 0 — output arriving inside the grace
 * window, which the drain tests pin as delivered; =exit42 answers
 * nothing and exits 42 — the drain-failure verdict; =exit143 is the
 * same silence with the signal's coded spelling, which must NOT be read
 * as a failure. Without the env the default SIGTERM disposition applies.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-opencode-run";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });
// The provider-override delivery, recorded without the key's value: the
// key rides the environment (never argv) and OPENCODE_CONFIG names the
// config file codemux wrote for this run.
record("env.jsonl", {
  hasProviderKey: process.env.CODEMUX_OPENCODE_PROVIDER_API_KEY !== undefined,
  openCodeConfig: process.env.OPENCODE_CONFIG ?? null,
  pid: process.pid,
});

// The driver passes `--session <id>` as two arguments; a resumed turn
// names that session, a fresh one mints $FAKE_SESSION_ID.
const sessionIndex = args.indexOf("--session");
const sessionId =
  (sessionIndex !== -1 ? args[sessionIndex + 1] : undefined) ||
  process.env.FAKE_SESSION_ID ||
  "ses_fake1234567890";

const timestamp = (): string => new Date().toISOString();

const write = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const withSession = (type: string, payload: Record<string, unknown>): void => {
  write({ type, timestamp: timestamp(), sessionID: sessionId, ...payload });
};

const textPart = (text: string): void => {
  withSession("text", { part: { id: "tx_1", type: "text", text } });
};

const usage = {
  input: 100,
  output: 20,
  reasoning: 5,
  total: 120,
  cache: { read: 40, write: 10 },
};

const stepStart = (): void => {
  withSession("step_start", { part: { id: "st_1", type: "step" } });
};

const stepFinish = (): void => {
  // Real wire shape (pinned 1.18.18 run command): the emitter spreads its
  // payload beside the envelope, so tokens and cost ride INSIDE part —
  // never at the line's top level (review D2, contracts 1).
  withSession("step_finish", { part: { id: "st_1", type: "step", tokens: usage, cost: 0.01 } });
};

const errorLine = (message: string): void => {
  withSession("error", { error: { message } });
};

/** Runs one scenario; the exit code when the process answered, null when
 * the turn stays open (wait/garbage — only a signal ends it). */
const runTurn = (scenario: string, prompt: string): number | null => {
  switch (scenario) {
    case "basic":
      stepStart();
      textPart(`Done: ${prompt}`);
      stepFinish();
      return 0;
    case "tools":
      stepStart();
      withSession("tool_use", {
        part: {
          id: "tu_1",
          type: "tool_use",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "file-a\nfile-b" },
        },
      });
      textPart(`Listed: ${prompt}`);
      stepFinish();
      return 0;
    case "errorturn":
      errorLine("the model refused the turn");
      return 1;
    case "silentfail":
    case "crash":
      // No lines at all, exit 1: silentfail mid-session (the turn fails
      // on the exit code alone), crash on the first turn (the session is
      // never identified and must end).
      return 1;
    case "wait":
      stepStart();
      return null;
    case "wrongid": {
      // A second session's line: valid JSON, valid shape, wrong identity.
      write({
        type: "text",
        timestamp: timestamp(),
        sessionID: "ses_other123456789",
        part: { id: "tx_1", type: "text", text: "wrong session" },
      });
      return 0;
    }
    case "nosession":
      write({ type: "text", timestamp: timestamp(), part: { id: "tx_1", type: "text", text: "no id" } });
      return 0;
    case "notype":
      write({ timestamp: timestamp(), sessionID: sessionId, part: {} });
      return 0;
    case "garbage":
      process.stdout.write("this is not json\n");
      return null;
    default:
      stepStart();
      textPart(`Done: ${prompt}`);
      stepFinish();
      return 0;
  }
};

// The prompt is the whole stdin stream to EOF — the wire's one-shot
// message — so the turn cannot start before the stream closes.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  record("prompts.jsonl", { text: input });
  const scenario = /^scenario:([a-z0-9-]+)/.exec(input)?.[1] ?? "basic";
  const code = runTurn(scenario, input);
  if (code !== null) {
    process.exit(code);
  }
  // The turn stays open; nothing else holds the event loop, so stay alive
  // for the signal (or the caller's kill).
  setInterval(() => {}, 60_000);
});

const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (persistMode === "1" || persistMode === "exit42" || persistMode === "exit143") {
  process.on("SIGTERM", () => {
    if (persistMode === "1") {
      // The drained answer: the turn's remaining output, delivered inside
      // the grace window before the exit.
      textPart("drained after the shutdown signal");
      stepFinish();
    }
    setTimeout(
      () => process.exit(persistMode === "exit42" ? 42 : persistMode === "exit143" ? 143 : 0),
      300
    );
  });
}
