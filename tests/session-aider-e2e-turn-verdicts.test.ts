/** Driver e2e tests for the aider session, turn-verdict split (from
 * tests/session-aider-e2e.test.ts): history-delta verdicts, the
 * symlinked history file's pre-turn check, and the truncated-state
 * end. */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  type Event
} from "./helpers/session-aider-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("aider session e2e - turn verdicts", () => {
  test("a nonzero exit with no history delta fails the turn; the session survives", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorturn" });
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the aider process exited with code 1");
    expect(of("assistant_message")(session.events)).toBeUndefined();
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

  test("a clean exit that records no exchange fails the turn; the session survives", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:noexchange" });
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the chat history records no exchange for this turn");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    // The turn failed but the end is clean: the history file (the
    // resumable state) is intact.
    expect(ended.resumable).toBe(true);
  });

  test("a history file replaced by a symlink between turns fails the next turn before any spawn (review D7, security)", async () => {
    // The finding's window: the creation-time check is one-shot and the
    // O_NOFOLLOW read runs only after a turn's process exits, so between
    // turns nothing guarded the file — a sandboxed child that can write
    // `~/.aider` could replace it with a symlink to a file outside its
    // sandbox, and the next turn's aider would follow it: read the
    // target into the model context and append to it. The pre-turn check
    // trips first, fails the TURN (never the session), and no aider
    // process ever runs against the link.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // What turn 1's child could have planted between turns.
    const canary = join(dirname(session.historyPath), "authorized_keys");
    writeFileSync(canary, "ssh-ed25519 AAAA canary");
    rmSync(session.historyPath);
    symlinkSync(canary, session.historyPath);

    send(session.driver, { type: "user", text: "scenario:basic two" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toContain("cannot be trusted for this turn");
    expect(failed.reason).toContain("mode 0600");
    // A non-fatal error names the check — the session lives on.
    const error = session.events.find(
      (event) => event.type === "error" && event.fatal === false
    );
    expect(error?.source).toBe("codemux");
    expect(error?.message).toContain("failed its pre-turn check");
    // Exactly one spawn ever happened: the guarded turn never reached
    // aider, and the canary was never read or written through the link.
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
    expect(readFileSync(canary, "utf8")).toBe("ssh-ed25519 AAAA canary");

    // The turn failed, the session survived: a clean shutdown end.
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  });

  test("a history file that shrank below what codemux consumed ends the session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:truncate" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed truncate turn"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the chat history file is unreadable or truncated");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("the session state is unreliable");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });
});
