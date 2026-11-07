/**
 * A scenario-driven fake of the claude-family stream-json harness, built
 * from the shapes pinned by the step-0 fixtures. The e2e tests drive the
 * real driver against this script instead of a recorded transcript, so
 * every round-trip (user lines, control responses, interrupts) is live.
 *
 * Protocol: NDJSON on stdin (the lines codemux sends), stream-json on
 * stdout (the lines the fixtures recorded). The scenario for a turn is
 * selected by the user text's `scenario:<name>` prefix:
 *
 *   basic   — deltas, one assistant message, a successful result
 *   tools   — an Edit tool_use, its tool_result, a message, a result
 *   askedit — an Edit tool_use on the wire, then a can_use_tool for the
 *             same call; the allow/deny arms below report the tool_result,
 *             so a derived file change exists to confirm or drop
 *   write   — a Write tool_use whose target rides the text
 *             (`scenario:write <rel>`), then its successful tool_result;
 *             the driver's stash-time existsSync reads the workspace, so
 *             a pre-existing target derives "edit" and a fresh one "add"
 *   lostwrite — a Write tool_use whose tool_result never arrives; the
 *             turn's result frame ends it with the call unanswered
 *   latewrite — the delayed tool_result for the PREVIOUS turn's
 *             lostwrite call, under the same id: confirms nothing (the
 *             candidate died with its turn, review round 259)
 *   ask     — a can_use_tool request for Bash; the turn continues only
 *             after the control_response, and the tool_result reports
 *             the behavior: the substituted input on allow, the denial
 *             message on deny (the real harness shows the model that
 *             text as the failing tool result)
 *   dupask  — two can_use_tool requests under one request id (tier 2,
 *             review live21)
 *   badask  — a can_use_tool with no input object; the driver answers
 *             deny and the turn continues (tier-1, non-fatal)
 *   asklose — a can_use_tool for Bash, then the turn completes by itself
 *             while the decision is still out (review live11)
 *   ctlreq  — a control_request of a subtype codemux does not implement
 *             (`hook_callback`); the turn completes only once it is
 *             answered, the way a real harness blocks on it (review live18)
 *   wait    — one assistant message, then nothing until interrupted
 *   deaf    — like wait, but every interrupt is acknowledged and
 *             ignored, so the turn never completes (review live17)
 *   refuseint — like wait, but the interrupt is answered with the
 *             control protocol's error, and the turn then ends on its
 *             own API-error result (review live22)
 *   nostdin — one assistant message, then stdin is never read again
 *             (the stdin backlog bound, review live19)
 *   race    — one assistant message, then hold; an interrupt during this
 *             turn completes it CLEANLY, as if the result were already
 *             in flight, and the interrupt is spent: the harness has no
 *             turn left to interrupt and drops it (the stale-interrupt
 *             race, reviews live12 and live21)
 *   apierror — an API failure: a result with `is_error` true under
 *             subtype `success`, the way the real wire reports one
 *             (review live20)
 *   ede     — a result with subtype `error_during_execution` and no
 *             interrupt behind it (review live21)
 *   crash   — one assistant message, then exit 1
 *   garbage — a non-JSON line, then nothing (tier-3 fatal)
 *   badinit — a second system/init mid-turn (tier-1 unknown now); the
 *             turn still completes
 *   wrongsession — an event framed with a foreign session id (tier-2)
 *
 * Costs model the real wire (fixture zai-session-a.ndjson): a result's
 * token counts are that turn's own, while total_cost_usd is the running
 * session total — each result reports the counter, which already
 * includes every earlier turn. Results without the field (ask, badask,
 * the default arm) exercise a turn that reports no cost.
 *
 * Everything received (argv, user texts, control responses) is recorded
 * as JSONL under $FAKE_STATE_DIR for the assertions.
 *
 * The scenario bodies live in fake-claude-session-parts/scenarios.ts,
 * the wire writer and shared state in ...-parts/wire.ts, and the control
 * handlers in ...-parts/requests.ts; this file owns the scenario switch
 * and the process lifecycle.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { record, sessionId, state, stateDir, write } from "./fake-claude-session-parts/wire.js";
import { makeScenarioHandlers } from "./fake-claude-session-parts/scenarios.js";
import { handleControlRequest, handleControlResponse } from "./fake-claude-session-parts/requests.js";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_VERSION ?? "2.1.280"}\n`);
  process.exit(0);
}

record("argv.jsonl", { args, pid: process.pid });
// A `resume-missing` marker in the state dir: `--resume <id>` names a
// transcript that no longer exists (Claude Code deletes old ones after
// cleanupPeriodDays). The real harness (live21 probe, 2026-10-07) sends
// one `result` with no init frame before it — subtype
// error_during_execution, is_error, the reason in `errors` — prints the
// reason on stderr, and exits 1. A marker file, not an env switch: the
// CLI tests pass only the recorded `--pass-env` names, and adding one
// would trip the resume guard.
if (args.includes("--resume") && existsSync(join(stateDir, "resume-missing"))) {
  const reason = `No conversation found with session ID: ${sessionId}`;
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      session_id: sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      errors: [reason],
    })}\n`
  );
  process.stderr.write(`${reason}\n`);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(1);
}
// The endpoint identity the adapter injected (zai's Z.AI mode), for the
// tests that drive one binary under two agents, and the config directory
// a project-settings launch points at.
record("env.jsonl", {
  anthropic_base_url: process.env.ANTHROPIC_BASE_URL ?? null,
  anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN !== undefined,
  zai_api_key_present: process.env.ZAI_API_KEY !== undefined,
  claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
});

const finishTurn = (): void => {
  state.turnActive = false;
  const next = state.inputQueue.shift();
  if (next !== undefined) runUserText(next);
};

const scenarios = makeScenarioHandlers({ finishTurn });

const runUserText = (text: string): void => {
  state.turnActive = true;
  // The real wire emits one system/init per turn, with the same session
  // id every time (the step-0 fixtures): nothing is emitted at spawn, so
  // session_started follows the first user line, not the process start.
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.env.FAKE_CWD ?? process.cwd(),
    tools: ["Bash", "Edit", "Write", "Read"],
  });
  // `--replay-user-messages`: the turn's own line, echoed after its init
  // (fixture zai-session-a.ndjson lines 6-8).
  write({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    isReplay: true,
  });
  const scenario = /^scenario:([a-z0-9-]+)/.exec(text)?.[1] ?? "basic";
  state.currentScenario = scenario;
  runTurn(scenario, text);
};

const runTurn = (scenario: string, text: string): void => {
  switch (scenario) {
    case "basic":
      scenarios.basic();
      return;
    case "tools":
      scenarios.tools(text);
      return;
    case "askedit":
      scenarios.askedit();
      return;
    case "write":
      scenarios.write(text);
      return;
    case "lostwrite":
      scenarios.lostwrite();
      return;
    case "latewrite":
      scenarios.latewrite();
      return;
    case "ask":
      scenarios.ask();
      return;
    case "dupask":
      scenarios.dupask();
      return;
    case "badask":
      scenarios.badask();
      return;
    case "asklose":
      scenarios.asklose();
      return;
    case "ctlreq":
      scenarios.ctlreq();
      return;
    case "wait":
      scenarios.wait();
      return;
    case "refuseint":
      scenarios.refuseint();
      return;
    case "deaf":
      scenarios.deaf();
      return;
    case "nostdin":
      scenarios.nostdin();
      return;
    case "race":
      scenarios.race();
      return;
    case "apierror":
      scenarios.apierror();
      return;
    case "ede":
      scenarios.ede();
      return;
    case "crash":
      scenarios.crash();
      return;
    case "garbage":
      scenarios.garbage();
      return;
    case "badinit":
      scenarios.badinit();
      return;
    case "wrongsession":
      scenarios.wrongsession();
      return;
    default:
      scenarios.defaultArm();
  }
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
    if (state.turnActive) {
      state.inputQueue.push(text);
      return;
    }
    runUserText(text);
    return;
  }
  if (event["type"] === "control_response") {
    handleControlResponse(event, finishTurn);
    return;
  }
  if (event["type"] === "control_request") {
    handleControlRequest(event, finishTurn);
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    handleLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  // The persistence scenarios also run on a protocol shutdown.
  if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM");
  else process.exit(0);
});

// FAKE_SIGTERM_PERSIST=1: survive the shutdown SIGTERM for a moment the
// way the real harness survives it inside the grace window — the
// end-interrupt request arrives on stdin either just before or just
// after the signal, its interrupted-turn frames (control_response, the
// user message, the result with its usage) go back while the pipes are
// still open, and only then does the process exit — with code 1, the
// real claude convention for a turn interrupted at shutdown (step-0
// probe 4: the interrupt round-trip ends in result
// error_during_execution, is_error true, exit 1). The nonzero exit
// fails the session even when the completion was delivered.
// =garbage additionally writes one non-JSON line before dying — a
// harness emitting unusable output inside the grace window, which the
// live7 regression pins as costing success rather than being absorbed by
// the already-running end path. =ask survives the same way but, on the
// end-interrupt itself, first surfaces a can_use_tool that lands inside
// the drain window (see the interrupt branch) and completes the
// interrupted turn only after its answer — the live8 regression's shape.
// =exit2 answers like =1 but exits 2: a harness that answered the
// end-interrupt and then failed while persisting (review live18 — only
// exit 1 after an interrupted turn is the convention).
// =exit42 answers nothing: the turn stays open and the process exits 42
// — a harness failing while persisting during the shutdown, the live9
// shape whose cost the driver must report (exit 1, not 0). =exit143 is
// the same silence with exit code 143 — a wrapper answering the SIGTERM
// with an exit code instead of dying by signal. This also fails. Without
// the env the default SIGTERM disposition applies (die at once), the
// pre-fix behavior every other test relies on.
const persistMode = process.env.FAKE_SIGTERM_PERSIST;
if (
  persistMode === "1" ||
  persistMode === "exit2" ||
  persistMode === "garbage" ||
  persistMode === "ask" ||
  persistMode === "exit42" ||
  persistMode === "exit143"
) {
  process.on("SIGTERM", () => {
    if (persistMode === "garbage") {
      process.stdout.write("this line is not json\n");
    }
    setTimeout(
      () =>
        process.exit(
          persistMode === "exit42"
            ? 42
            : persistMode === "exit143"
              ? 143
              : persistMode === "exit2"
                ? 2
                : 1
        ),
      300
    );
  });
}
