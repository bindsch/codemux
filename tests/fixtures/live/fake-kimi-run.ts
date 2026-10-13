/**
 * A scenario-driven fake of headless kimi (`--prompt … --output-format
 * stream-json`, the per-turn process behind the kimi session driver),
 * built from the shapes the installed 0.31.1 binary's PromptJsonWriter
 * prints (kimi-session.ts pins them). The e2e tests drive the real
 * driver against this script, so every round-trip — prompt-on-argv, the
 * JSON line tiers, the deferred session id in the closing resume hint,
 * the exit-code verdicts — is live.
 *
 * Protocol: the prompt is the `--prompt` argv value (kimi 0.31.1 has no
 * stdin transport), the scenario is the prompt's `scenario:<name>`
 * prefix, and the session the resume hint names is the `--session <id>`
 * value when one was passed (resume), else $FAKE_SESSION_ID (default
 * session_11111111-2222-3333-4444-555555555555 — a fresh session mints
 * its id in its own hint, the driver's deferred-identity model). The
 * hint is written after the turn body exactly as the real binary's
 * runPrompt order does (runPromptTurn, then writeResumeHint); a thrown
 * turn writes NO hint — the same order's consequence, read from the
 * source rather than live-verified. Everything received
 * (argv, prompts, the override env's presence) is recorded as JSONL
 * under $FAKE_STATE_DIR for the assertions.
 *
 *   basic (default) — one assistant text line, the resume hint, exit 0
 *   tools           — assistant tool_calls, a tool result, final text,
 *                     the hint, exit 0
 *   danglingtool    — assistant tool_calls, then the hint and exit 0
 *                     with NO tool result and no final text: the tool
 *                     loop cut mid-flight, which must fail the turn
 *                     (round al33) — before it, a tool-call frame
 *                     counted as the turn's reply and the truncation
 *                     completed as a success
 *   retrying        — a turn.step.retrying meta line (tier 1) before
 *                     the text, the hint, exit 0
 *   silent          — the hint only, exit 0: no assistant output, so
 *                     the turn fails on the empty verdict
 *   errorturn       — nothing at all, exit 1: a thrown turn, no hint
 *                     (mid-session the turn fails and the session
 *                     survives)
 *   nohint          — the assistant text and exit 0, but NO resume
 *                     hint: a completed-looking turn whose closing line
 *                     never arrived (truncated or drifted output); the
 *                     turn fails on the unconfirmed-session verdict and
 *                     the end is not resumable (round al13)
 *   trailing        — the assistant text, the hint, then MORE assistant
 *                     output: the writer runs the turn body, then writes
 *                     the hint, then exits, so a line past the hint is a
 *                     malformed or concatenated stream — a tier-2 fatal
 *                     whose turn fails and crash ends non-resumable
 *                     (round al14)
 *   crash           — the same exit 1 on the FIRST turn: the session is
 *                     never identified and must end
 *   wait            — a system.version meta line (tier 1), then
 *                     nothing: the turn stays open until a signal ends
 *                     the process (no hint is written)
 *   wrongid         — the hint names a DIFFERENT session id (tier 2
 *                     once an id is adopted — a fresh session just
 *                     adopts it, which the adoption test pins)
 *   badhint         — the hint carries a malformed session id (tier 2)
 *   notoolid        — a tool line with no tool_call_id (tier 2)
 *   emptyassistant  — an assistant line with neither content nor tool
 *                     calls (tier 2)
 *   postfatal       — the same tier-2 line, then a VALID assistant line
 *                     and the hint: output that arrives after the fatal's
 *                     asynchronous crash end began, which the driver must
 *                     never parse — pre-fix it emitted a post-fatal
 *                     assistant message and re-confirmed the session
 *                     through the late hint (round al22, edges 2)
 *   garbage         — a non-JSON line, then nothing (tier 3)
 *
 * FAKE_SIGTERM_PERSIST covers the shutdown drain: =1 survives the
 * shutdown SIGTERM and answers the open turn (text + hint) before
 * exiting 0 — output arriving inside the grace window, which the drain
 * tests pin as delivered; =exit42 answers nothing and exits 42 — the
 * drain-failure verdict; =exit143 is the same silence with the signal's
 * coded spelling (kimi's own handler exits exactly that), which must
 * NOT be read as a failure. Without the env the default disposition
 * applies.
 *
 * FAKE_DRAIN_SELFKILL=1 (wait scenario) models the external kill (round
 * al25, edges major): the driver endInput()s the child's stdin when the
 * graceful end begins, and 100 ms after that close the child SIGKILLs
 * itself — a signaled death during the drain that codemux's own cleanup
 * did not cause, which the session must report instead of swallowing it
 * as an interrupted turn.
 *
 * FAKE_DRAIN_EXIT143=1 (wait scenario) is the coded spelling of the same
 * external death (round al26, correctness major 1): 100 ms after the
 * stdin close the child exits 143 — the 128 + SIGTERM a wrapper reports
 * for a SIGTERM nobody at codemux sent, which must be reported with its
 * real cause, not exempted as the coded spelling of cleanup's own stop.
 *
 * FAKE_SIGTERM_PERSIST=selfkill (wait scenario) receives SIGTERM, then
 * SIGKILLs itself 100 ms later, inside the kill timer's grace. This
 * signal exit fails the session regardless of either signal's sender.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-kimi-run";
mkdirSync(stateDir, { recursive: true });
const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

const args = process.argv.slice(2);
record("argv.jsonl", { args, pid: process.pid });
// The provider override rides the environment (never argv); the
// override test asserts the KIMI_MODEL_* group reached the child
// without recording the key's value.
record("env.jsonl", {
  hasOverride: process.env.KIMI_MODEL_NAME !== undefined,
  kimiCodeHome: process.env.KIMI_CODE_HOME ?? null,
  pid: process.pid,
});

const argValue = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at !== -1 ? args[at + 1] : undefined;
};

const prompt = argValue("--prompt") ?? "";
record("prompts.jsonl", { text: prompt });

// kimi's own headless entry validates the prompt before anything runs and
// refuses a whitespace-only one before a session exists (round al22):
// exit 1, no lines, no hint — a fresh session accepted into a turn with
// such a prompt could never name its id. The driver refuses the line
// before the ack instead, so this arm exists to keep the model honest.
if (prompt.trim() === "") {
  process.exit(1);
}

// The driver passes `--session <id>` as two arguments; a resumed turn
// names that session in its hint, a fresh one mints $FAKE_SESSION_ID.
const sessionId =
  argValue("--session") ||
  process.env.FAKE_SESSION_ID ||
  "session_11111111-2222-3333-4444-555555555555";

const write = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const hint = (id = sessionId): void => {
  write({
    role: "meta",
    type: "session.resume_hint",
    session_id: id,
    command: `kimi -r ${id}`,
    content: `To resume this session: kimi -r ${id}`,
  });
};

/** Runs one scenario; the exit code when the process answered, null
 * when the turn stays open (wait/garbage — only a signal ends it). */
const runTurn = (scenario: string): number | null => {
  switch (scenario) {
    case "basic":
      write({ role: "assistant", content: `Done: ${prompt}` });
      hint();
      return 0;
    case "tools":
      write({
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: "call_1",
            function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
          },
        ],
      });
      write({ role: "tool", tool_call_id: "call_1", content: "file-a\nfile-b" });
      write({ role: "assistant", content: `Listed: ${prompt}` });
      hint();
      return 0;
    case "danglingtool":
      // The truncated tool loop (round al33, edges major 2): the
      // assistant opens a call, the result never arrives, and no final
      // text follows — only the writer's closing hint and a clean exit,
      // the exact shape that used to complete as a success.
      write({
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: "call_1",
            function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
          },
        ],
      });
      hint();
      return 0;
    case "retrying":
      write({
        role: "meta",
        type: "turn.step.retrying",
        failed_attempt: 1,
        next_attempt: 2,
        max_attempts: 5,
        delay_ms: 500,
        error_name: "APIStatusError",
        error_message: "429",
        status_code: 429,
      });
      write({ role: "assistant", content: `Done: ${prompt}` });
      hint();
      return 0;
    case "silent":
      hint();
      return 0;
    case "errorturn":
    case "crash":
      // No lines at all, exit 1: a thrown turn writes no hint.
      // errorturn mid-session fails the turn and the session survives;
      // crash on the first turn leaves the session never identified.
      return 1;
    case "trailing":
      // The closing record, then output past it (round al14): the hint is
      // the stream's final line by the writer's own order, so anything
      // after it cannot belong to this turn.
      write({ role: "assistant", content: `Done: ${prompt}` });
      hint();
      write({ role: "assistant", content: "after the closing hint" });
      return 0;
    case "nohint":
      // A turn that looks completed — text, exit 0 — minus the closing
      // hint the writer pins to every completed turn: the
      // unconfirmed-session shape (round al13).
      write({ role: "assistant", content: `Done: ${prompt}` });
      return 0;
    case "wait":
      write({ role: "meta", type: "system.version", version: "0.31.1" });
      return null;
    case "wrongid":
      write({ role: "assistant", content: "from another session" });
      hint("session_99999999-8888-7777-6666-555555555555");
      return 0;
    case "badhint":
      write({ role: "assistant", content: "text" });
      write({
        role: "meta",
        type: "session.resume_hint",
        session_id: "not-a-session-id",
        command: "kimi -r not-a-session-id",
        content: "To resume this session: kimi -r not-a-session-id",
      });
      return 0;
    case "notoolid":
      write({ role: "tool", content: "no call id" });
      return 0;
    case "emptyassistant":
      write({ role: "assistant" });
      return 0;
    case "postfatal":
      // Round al22, edges 2: the tier-2 line fires the fatal and its
      // asynchronous crash end, then the process's remaining output — a
      // valid assistant line and the closing hint — still arrives.
      write({ role: "assistant" });
      write({ role: "assistant", content: "after the fatal" });
      hint();
      return 0;
    case "garbage":
      process.stdout.write("this is not json\n");
      return null;
    default:
      write({ role: "assistant", content: `Done: ${prompt}` });
      hint();
      return 0;
  }
};

// Not anchored: an explicit author prefix can sit ahead of the text
// ("[caller] scenario:basic …" — applyAuthorPrefix prefixes only when the
// caller sends an author), and the scenario still names itself.
const scenario = /(?:^|\s)scenario:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "basic";
const code = runTurn(scenario);
if (code !== null) {
  process.exit(code);
}
// The turn stays open; nothing else holds the event loop, so stay alive
// for the signal (or the caller's kill).
setInterval(() => {}, 60_000);

const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (
  persistMode === "1" ||
  persistMode === "exit42" ||
  persistMode === "exit143" ||
  persistMode === "selfkill"
) {
  process.on("SIGTERM", () => {
    if (persistMode === "1") {
      // The drained answer: the turn's remaining output, delivered
      // inside the grace window before the exit.
      write({ role: "assistant", content: "drained after the shutdown signal" });
      hint();
    }
    if (persistMode === "selfkill") {
      // A different signal during the drain still fails the session.
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
      return;
    }
    setTimeout(
      () => process.exit(persistMode === "exit42" ? 42 : persistMode === "exit143" ? 143 : 0),
      300
    );
  });
}

// Fail during the graceful drain, either by signal or coded exit.
// Both outcomes must fail the session even though shutdown was requested.
if (process.env.FAKE_DRAIN_SELFKILL === "1" || process.env.FAKE_DRAIN_EXIT143 === "1") {
  const exitCode = process.env.FAKE_DRAIN_EXIT143 === "1" ? 143 : null;
  process.stdin.on("end", () => {
    setTimeout(() => {
      if (exitCode !== null) process.exit(exitCode);
      else process.kill(process.pid, "SIGKILL");
    }, 100);
  });
  process.stdin.resume();
}
