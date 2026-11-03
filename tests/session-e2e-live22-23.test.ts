import { afterAll, describe, expect, test } from "bun:test";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e - review live22", () => {
  test("a refused timeout interrupt ends the session once, without a re-armed second fatal", async () => {
    // Correctness minor 5: the refused interrupt write started the crash
    // end, which cleared the timers, and the callback then re-armed the
    // turn timer with no check on `finished`. A drain longer than the
    // timeout (here the fake survives SIGTERM for 300 ms) raised a second,
    // false "--turn-timeout" fatal.
    const session = await startSession({ turnTimeoutMs: 100 }, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("harness_failed");
    expect(await session.code).toBe(1);
    const fatals = session.events.filter((event) => event.type === "error" && event.fatal === true);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]!.message).toContain("could not deliver a line to the harness (backlog)");
  }, 30_000);
});

describe("claude session driver e2e - review live22 audit siblings", () => {
  test("a refused interrupt is cleared: the turn's own API error stays failed", async () => {
    // Every control_response fell through to `unknown`, so an interrupt
    // the harness refused stayed pending and labeled the turn's next
    // error result `interrupted`. The codex driver already cleared it.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:refuseint hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    const notice = session.events.find(
      (event) => event.type === "error" && String(event.message).includes("rejected the interrupt")
    );
    expect(notice?.fatal).toBe(false);
    expect(
      session.events.some(
        (event) => event.type === "unknown" && String(event.raw).includes("cannot interrupt now")
      )
    ).toBe(true);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a caller-stdin read error during the drain stays nonfatal while the child failure is reported", async () => {
    // handleCallerEnd guarded on `settled`, not `finished`: an error on
    // stdin after an acked shutdown added a fatal and turned exit 0 into
    // exit 1, though the session no longer reads stdin.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    session.driver.handleCallerEnd(new Error("EIO: i/o error, read"));
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(await session.code).toBe(1);
    const errors = session.events.filter((event) => event.type === "error");
    expect(errors.filter((event) => event.fatal === true)).toHaveLength(1);
    expect(errors.find((event) => event.fatal === true)?.source).toBe("harness");
    expect(errors.some((event) => String(event.message).includes("EIO"))).toBe(true);
  });
});

describe("claude session driver e2e - review live23", () => {
  test("a refused end-path interrupt is cleared: the turn stays failed and the drain exit 1 counts", async () => {
    // Contracts major 1: the refusal matched only the caller spelling
    // `interrupt-N`, so the end path's `interrupt-end-N` stayed pending.
    // The turn's own error result was labeled `interrupted`, which
    // excused the child's exit 1, and the session ended 0.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:refuseint hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
    const notice = session.events.find(
      (event) => event.type === "error" && String(event.message).includes("rejected the interrupt")
    );
    expect(notice?.fatal).toBe(false);
    expect(ended.reason).toBe("harness_failed");
    expect(await session.code).toBe(1);
  }, 30_000);
});

describe("claude session driver e2e - review live23 siblings", () => {
  test("an interrupt whose write is refused is rejected, never acked accepted", async () => {
    // The claude-family sibling of correctness-2 minor 1 (codex): the
    // interrupt was acked first, and the refused write also left it
    // pending, so the crash end could label a drained error result
    // interrupted.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "interrupt" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = session.events.find(
      (event) => String(event.type).startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
  }, 30_000);
});
