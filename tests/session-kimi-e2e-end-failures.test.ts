/**
 * Driver e2e for the kimi session (design §4.7): the end paths' input
 * failures — a failed stdin read during the drain, the fatal closing the
 * drain so no late harness line is accepted, and the idle timeout. Split
 * from tests/session-kimi-e2e.test.ts; the rig is tests/helpers/
 * session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

describe("kimi session e2e - end paths", () => {
  test("a stdin read failure while the end path drains is fatal, not a drained close (round al20)", async () => {
    // Correctness 1: the graceful end (exit 0) had begun — the turn open,
    // the drain waiting — when the caller's stdin READ failed. Before the
    // fix that failure landed in the nonfatal note arm of the finished
    // branch: the exit stayed 0 and the session reported success after its
    // input channel broke. The failure now pairs with the fatal the
    // settled arm reports and raises the code through finish's monotone
    // escalation the way a cancellation does: the drain stops waiting, the
    // open turn's synthesis reads failed, and the session exits 1 with
    // the failure named.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    session.driver.handleCallerEnd(new Error("EPIPE: broken pipe"));

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure before the turn completed");
    expect(completed.reason).toContain("reading the caller's stdin failed");
    expect(completed.reason).toContain("EPIPE: broken pipe");
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("reading the caller's stdin failed");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a stdin read failure closes the graceful drain: no harness line is accepted after the fatal (al23)", async () => {
    // The edges major: the fatal the al20 arm reports left the drain
    // OPEN — the end reason stayed stdin-close and no escalation ran,
    // so harness lines kept arriving into applyParse. The fake's persist
    // mode makes the window real: the drain's stop signal is answered
    // with a valid assistant line and the closing hint (exactly the
    // output the grace exists to deliver), and before the fix that line
    // was emitted as a post-fatal assistant_message while the late hint
    // re-confirmed the session and flipped the end resumable. The fatal
    // now closes the drain the same way every other fatal does: the
    // drained answer is accepted nowhere, and the session ends with the
    // error.
    // A long grace so the fake always answers and exits 0 inside it: the
    // end reason is then the fatal's own, not a timing-dependent kill
    // (a 500 ms grace under load let the kill timer fire first and the
    // reason flip to harness_failed; CI's faster runner saw stdin-close).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" }, 0, 1, 5_000);
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    // turn_started is the driver's own spawn event; the fake's SIGTERM
    // handler exists only once its module has run, which its startup
    // record proves. Ending before that kills a fake that has not armed
    // itself and the reason flips to harness_failed (seen locally under
    // load; CI's faster runner saw the armed fake answer and exit 0).
    const armed = join(session.stateDir, "argv.jsonl");
    for (let i = 0; i < 200 && !existsSync(armed); i++) await Bun.sleep(25);
    expect(existsSync(armed)).toBe(true);
    session.driver.handleCallerEnd();
    session.driver.handleCallerEnd(new Error("EPIPE: broken pipe"));

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("reading the caller's stdin failed");
    // The drained answer arrived after the fatal — and was accepted
    // nowhere: no assistant message, no re-confirmation, no resumable
    // end.
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    // A child that answered and exited 0 is no harness failure (al41): the
    // caller's stdin read failure is the end's own reason, with its code 1.
    expect(ended.reason).toBe("stdin-close");
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  }, 20_000); // the armed-fake wait above is bounded at 5 s (200 x 25 ms); with the default 5 s test timeout it was cut short under load

  test("the session timeout ends an idle session", async () => {
    const session = await startSession({ sessionTimeoutMs: 150 });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("timeout");
    // An idle end's code is its cause's own (round al29): the timeout's
    // 1, matching the process exit — no turn ran, so no child code
    // exists to report in the first place.
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });
});
