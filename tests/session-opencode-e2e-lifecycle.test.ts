/** Driver e2e tests for the opencode session, lifecycle split (from
 * tests/session-opencode-e2e.test.ts): the deferred identity, the
 * two-turn stdin-prompt exchange, --session resume, tool mapping, turn
 * verdicts, the timeout, the author prefix, the text bound, and spawn
 * failure. */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  type Event
} from "./helpers/session-opencode-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("opencode session e2e - lifecycle", () => {
  test("a fresh session runs a two-turn exchange with the identity deferred to the first line", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });

    // Before the first run-output line, the session does not exist yet:
    // the input is answered and echoed with an empty session id, and the
    // turn opens codemux-side.
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic one");
    expect(echo.turn_id).toBe("t1");
    expect(echo.session_id).toBe("");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    expect(turnStarted.raw).toBeNull();

    // The first line of output adopts the native session id.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.agent).toBe("opencode");
    expect(started.session_id).toBe("ses_fake1234567890");
    expect(started.autonomy).toBe("high");
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: false,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic one");
    expect(message.turn_id).toBe("t1");
    expect(message.session_id).toBe("ses_fake1234567890");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // usage_stream: false means usage rides ONLY the per-turn completion;
    // no standalone usage event may appear.
    expect(of("usage")(session.events)).toBeUndefined();
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 50,
      total_tokens: 120,
      cost_usd: 0.01,
    });
    // Identity ordering: turn_started precedes session_started, and the
    // turn's mapped events follow it.
    const order = session.events.map((event) => event.type);
    expect(order.indexOf("session_started")).toBeGreaterThan(order.indexOf("turn_started"));
    expect(order.indexOf("session_started")).toBeLessThan(order.indexOf("assistant_message"));

    // The prompt reached the process as raw stdin text, and the fresh
    // turn's argv carried no --session while the second turn resumes the
    // native id the first adopted.
    const prompts = fakeRecord(session, "prompts.jsonl");
    expect(prompts[0]!.text).toBe("scenario:basic one");
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs[0]!.args).toEqual([
      "--pure",
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "--auto",
    ]);

    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");
    const argvsAfter = fakeRecord(session, "argv.jsonl");
    expect(argvsAfter[1]!.args[argvsAfter[1]!.args.indexOf("--session") + 1]).toBe(
      "ses_fake1234567890"
    );

    send(session.driver, { type: "shutdown" });
    const code = await session.code;
    expect(code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    // Two identical turns under the cumulative rules (a plain addUsage
    // sum, review D2 contracts 2): the token parts sum, total_tokens is
    // recomputed by the input+cached+output identity, and cost SUMS the
    // per-turn figures — each step_finish part's cost is that step's own
    // (the binary runs `assistantMessage.cost += step.cost`), never a
    // session-lifetime figure to adopt.
    expect(ended.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cached_input_tokens: 100,
      total_tokens: 340,
      cost_usd: 0.02,
    });

    // The registry recorded the session under the native id (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "ses_fake1234567890")
        : undefined;
    expect(entry?.agent).toBe("opencode");
    expect(entry?.ended).not.toBe(null);
  });

  test("a resumed session adopts its id at run start and resumes by --session", async () => {
    const session = await startSession({ resumeSessionId: "ses_resume00001" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("ses_resume00001");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    send(session.driver, { type: "user", text: "scenario:basic hi" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.session_id).toBe("ses_resume00001");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs[0]!.args[argvs[0]!.args.indexOf("--session") + 1]).toBe("ses_resume00001");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a resumed session the harness never confirms: clean end resumable, failure end not (review live21)", async () => {
    // The resume claims the registry record at spawn from the vouched id;
    // whether opencode actually holds that id is the harness's fact. A
    // turn whose process dies before any line named the session fails the
    // turn but not the session — a clean end after it keeps the claimed
    // record resumable (the agy rule), while a failure end without any
    // confirmation does not.
    const clean = await startSession({ resumeSessionId: "ses_resume00002" });
    await waitFor(clean.events, of("session_started"), "session_started");
    send(clean.driver, { type: "user", text: "scenario:crash" });
    const failed = await waitFor(clean.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the opencode process exited with code 1");
    send(clean.driver, { type: "shutdown" });
    expect(await clean.code).toBe(1);
    const cleanEnded = clean.events.at(-1) as Event;
    expect(cleanEnded.type).toBe("session_ended");
    expect(cleanEnded.resumable).toBe(false);

    const crashing = await startSession({ resumeSessionId: "ses_resume00003" });
    await waitFor(crashing.events, of("session_started"), "session_started");
    send(crashing.driver, { type: "user", text: "scenario:garbage" });
    expect(await crashing.code).toBe(1);
    const crashEnded = crashing.events.at(-1) as Event;
    expect(crashEnded.type).toBe("session_ended");
    expect(crashEnded.reason).toBe("harness_failed");
    expect(crashEnded.resumable).toBe(false);
  });

  test("a tool_use line maps to tool_call and tool_result events", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:tools list" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.call_id).toBe("tu_1");
    expect(call.name).toBe("bash");
    expect(call.input).toEqual({ command: "ls" });
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.call_id).toBe("tu_1");
    expect(result.output).toBe("file-a\nfile-b");
    expect(result.is_error).toBe(false);
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an error line plus a nonzero exit fails the turn with the error as reason; the session survives", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorturn" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error"),
      "the non-fatal error"
    );
    expect(error.fatal).toBe(false);
    expect(error.message).toBe("the model refused the turn");
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the model refused the turn");
    // The session is still alive: the next turn runs.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    expect(second.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    expect(of("session_ended")(session.events)?.reason).toBe("harness_failed");
  });

  test("an error line followed by exit 0 still fails the turn; the ledger mirrors it and the next turn runs (review round 123)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorzero" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error"),
      "the non-fatal error"
    );
    expect(error.fatal).toBe(false);
    expect(error.message).toBe("the model refused the turn");
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the model refused the turn");
    // The ledger's turn record mirrors the event the caller just saw. The
    // suite shares one per-process ledger (tests/setup.ts), and other
    // opencode sessions wrote their own t1 records before this one, so the
    // record to judge is the last of this shape — this turn's append.
    const ledger = process.env.CODEMUX_TEST_LEDGER!;
    const records = (existsSync(ledger) ? readFileSync(ledger, "utf8") : "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const turn = records.filter(
      (record) =>
        record.kind === "session_turn" &&
        record.agent === "opencode" &&
        record.session_id === "ses_fake1234567890" &&
        record.turn_id === "t1"
    ).at(-1);
    expect(turn).toBeDefined();
    expect(turn!.finish).toBe("failed");
    // The session survives the failed turn: the next one runs and ends.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    expect(second.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });
    // The process exited 0 and no fatal owns the end: a failed turn is not
    // a failed session, so the shutdown ends clean.
    expect(await session.code).toBe(0);
    expect(of("session_ended")(session.events)?.reason).toBe("shutdown");
  });

  test("a silent nonzero exit mid-session fails the turn on the exit code alone", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:silentfail" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the opencode process exited with code 1");
    // A failed turn is not a failed session.
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
  });

  test("a first turn that never names a session id ends the untrackable session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe(
      "the opencode process exited with code 1 and named no session id"
    );
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("the first turn named no session id");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
    // Never identified, never announced.
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
  });

  test("the author prefix rides the prompt stdin", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const prompts = fakeRecord(session, "prompts.jsonl");
    expect(prompts[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a text past the 16 MiB bound is rejected text_too_long before the ack", async () => {
    // The protocol's text bound (MAX_INPUT_TEXT_BYTES) rejects the text
    // during parse, before the ack — an accepted line the turn process
    // cannot be handed would hang its turn open. The raw write's own cap
    // (17 MiB) is the second gate; this text never reaches it.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "x".repeat(16 * 1024 * 1024 + 1) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an empty message is rejected unsupported and the session stays usable (review round 96)", async () => {
    // The opencode wire exits 1 on an empty message (a non-TTY stdin is
    // read to EOF and used as the message), and on a fresh session that
    // also leaves no session id — so an accepted empty message ended the
    // whole session as untrackable instead of being refused as invalid
    // input before the acknowledgement.
    const session = await startSession();
    send(session.driver, { type: "user", text: "   " });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the unsupported rejection"
    );
    expect(rejected.input_seq).toBe(1);
    expect(rejected.reason).toBe("unsupported");
    // No turn opened, no process spawned, nothing delivered to the wire.
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    expect(fakeRecord(session, "prompts.jsonl")).toHaveLength(0);
    // The session stays usable: a following valid message runs its turn.
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a spawn failure is a fatal codemux error, never an unhandled rejection", async () => {
    const session = await startSession({
      spawnTurn: () => Promise.reject(new Error("the binary is gone")),
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("could not spawn the opencode turn process");
    expect(error.message).toContain("the binary is gone");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });
});
