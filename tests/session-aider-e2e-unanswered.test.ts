/** Driver e2e tests for the aider session, the unanswered-prompt split
 * (from tests/session-aider-e2e-end-paths.test.ts): a turn whose chat
 * history holds the `#### ` prompt with no reply is unreliable session
 * state whatever the exit code was — the turn fails, the session ends
 * non-resumable, and nothing spawns onto the half-written history again
 * (review round 96; review round 162 extended the rule to exit 0). */

import { afterAll, describe, expect, test } from "bun:test";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor
} from "./helpers/session-aider-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("aider session e2e - unanswered prompts", () => {
  test("a failed turn that leaves its prompt unanswered ends the session as unreliable (review round 96)", async () => {
    // The promptexit scenario: aider appended the `#### ` user block (the
    // prompt is written the moment the turn starts) and exited 1 before
    // any reply. The old verdict failed the turn but kept the session
    // open, so the next --restore-chat-history process would have
    // replayed the unanswered prompt as if the caller had sent it again.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:promptexit broken" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the aider process exited with code 1");
    const fatal = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "the fatal error"
    );
    expect(fatal.source).toBe("codemux");
    expect(fatal.message).toContain("holds the failed turn's prompt with no reply");
    expect(fatal.message).toContain("the session state is unreliable");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    // Exactly one turn ran: the session never spawns onto the half-written
    // history again (nothing is emitted after session_ended, so a further
    // input has no answer to check — the turn count is the proof).
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await Bun.sleep(150);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
  });

  test("a clean-exiting turn that leaves its prompt unanswered ends the session as unreliable (review round 162)", async () => {
    // The promptexit0 scenario: aider appended the `#### ` user block and
    // exited 0 before any reply — the exit code real aider reports for
    // many provider errors. The history file, not the code, is the
    // session's state, so the exit-0 verdict owes the same refusal the
    // nonzero path gives: the turn fails, the session ends non-resumable,
    // and the offset never advances past the unanswered prompt.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:promptexit0 broken" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the chat history holds the prompt with no reply");
    const fatal = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "the fatal error"
    );
    expect(fatal.source).toBe("codemux");
    expect(fatal.message).toContain("holds the failed turn's prompt with no reply");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    // The registry record is stamped ended and releases the claim — the
    // end stamp a later --resume reads.
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find(
            (candidate) => candidate.id === session.options.sessionId
          )
        : undefined;
    expect(entry?.ended).not.toBe(null);
    // No assistant message ever claimed an answer, and exactly one turn
    // ran: the session never spawns onto the half-written history again.
    expect(session.events.filter((event) => event.type === "assistant_message")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
  });

  test("a normal answered turn still completes and stays resumable (review round 162)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic one");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
  });

  test("a drained turn that exits 0 without its reply ends the session non-resumable (review round 162)", async () => {
    // FAKE_SIGTERM_PERSIST=exit0silent: the shutdown drain's child exits
    // 0 with only the `#### ` user block written. The drain runs inside
    // the end path, so the crash verdict rides an already-running
    // finish — the raised exit code and the latched flag must both land
    // in the one session_ended the caller sees.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit0silent" });
    send(session.driver, { type: "user", text: "scenario:wait one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the chat history holds the prompt with no reply");
    const fatal = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "the fatal error"
    );
    expect(fatal.message).toContain("holds the failed turn's prompt with no reply");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a reply that is only a thinking block fails as an empty answer but keeps the session (review round 163, E1)", async () => {
    // Aider records the reasoning block as the assistant's block and
    // restores it, so the history does not hold an unanswered prompt and
    // the session stays usable. The caller gets no text (the block is
    // stripped), so the shared empty-answer rule (src/session/completion.ts)
    // fails the turn; the session takes a further turn and stays resumable.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:thinkingonly hidden" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("empty answer");
    expect(session.events.some((event) => event.type === "assistant_message")).toBe(false);
    expect(session.events.some((event) => event.type === "error")).toBe(false);
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic two");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
  });
});
