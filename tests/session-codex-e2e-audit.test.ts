import { afterAll, describe, expect, test } from "bun:test";
import { cleanupSessions, of, send, startAndWait, startSession, waitFor, refuseWrites } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - review live23 audit siblings", () => {
  test("a server request whose answer is refused mirrors first and claims no answer", async () => {
    // The answer was written before the raw mirror, so a refused write put
    // the fatal ahead of the line and an "answered with an error" notice
    // after it.
    const session = await startAndWait();
    refuseWrites(session.proc, (line) => line.includes("-32601"));
    send(session.driver, { type: "user", text: "scenario:unknownreq go" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    const mirror = session.events.find(
      (event) => event.type === "unknown" && String(event.raw).includes("fs/readFileText")
    );
    expect(mirror!.seq).toBeLessThan(fatal!.seq);
    expect(
      session.events.some((event) => event.type === "error" && String(event.message).includes("answered with an error"))
    ).toBe(false);
  });

  test("a rejected end-path interrupt stops the grace wait", async () => {
    // The end path's wait had no rejection term, so a refused interrupt
    // held the full grace window before the stop signal.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refusehold hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    const started = Date.now();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(Date.now() - started).toBeLessThan(400);
    expect(
      session.events.some((event) => event.type === "error" && String(event.message).includes("rejected the interrupt"))
    ).toBe(true);
  });

  test("an interrupt queued behind turn/start names its input_seq when delivery is refused", async () => {
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "300" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_accepted" && event.input_seq === 2),
      "the ack"
    );
    refuseWrites(session.proc, (line) => line.includes("turn/interrupt"));
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(
      session.events.some(
        (event) => event.type === "error" && String(event.message).includes("(input_seq 2) could not be delivered")
      )
    ).toBe(true);
  });

  test("a steer buffered behind turn/start names its input_seq when delivery is refused", async () => {
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "300" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "steer", text: "later" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_accepted" && event.input_seq === 2),
      "the ack"
    );
    refuseWrites(session.proc, (line) => line.includes("turn/steer"));
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(
      session.events.some(
        (event) =>
          event.type === "error" &&
          String(event.message).includes("steering input could not be delivered to the harness (input_seq 2)")
      )
    ).toBe(true);
  });

  test("a timeout interrupt that was never written does not label the end's interrupt turn-timeout", async () => {
    // Scale-based, not time-bound: the pinned path needs the turn/start
    // response handled BEFORE the timer fires, so the timeout's interrupt
    // is written (not queued behind the response) and the refusal lands on
    // it. At 100 ms a loaded runner (a paired batch) once read the
    // response later than the timer and the test took the queued path;
    // 1500 ms is a few pipe round-trips scaled to a margin no runner load
    // crosses — the live25 grace test's graceMs/2 argument.
    const session = await startAndWait({ turnTimeoutMs: 1_500 });
    // Installed before the turn opens, so the timer cannot win the race.
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes("turn/interrupt")) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.reason).not.toBe("turn-timeout");
  }, 15_000);

  test("a queued timeout interrupt whose delivery is refused does not label the end's interrupt turn-timeout", async () => {
    // The middle window of the same race, forced deterministically: the
    // timeout fires while the turn/start response is still held
    // (FAKE_TURNSTART_DELAY past the first expiry, before the second), so
    // the timeout's interrupt queues, and its delivery — once the
    // response lands — is the refused write. The crash end's own
    // interrupt (which passes the latch) then answers the turn, and that
    // completion must not wear the timeout's label: the label names only
    // an interrupt the timeout produced (the stale-flag mislabel this
    // pins; review live23's rule). The window's two edges (response
    // after the first expiry, handled before the second) each carry
    // ~1,000 ms of margin: a 250 ms window flaked once under a full
    // gate's coverage load and was widened to ~500 ms, and round al31's
    // gate crossed that too (the crash end still unfinished when the
    // second expiry fired, the turn labeled turn-timeout), so the
    // margins doubled again rather than trust the same load twice.
    const session = await startAndWait(
      { turnTimeoutMs: 2_000 },
      { FAKE_TURNSTART_DELAY: "3000" }
    );
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes("turn/interrupt")) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.reason).not.toBe("turn-timeout");
    // The pinned path: the queued interrupt's refused write is the fatal
    // that ended the session (the crash end), not the timeout's second
    // expiry — the response landed inside the first re-arm window.
    const fatal = session.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(String(fatal?.message)).toContain("could not deliver a line to the harness");
  }, 15_000);

  test("a refused turn/start write ends at once, without waiting the grace for its response (review live25)", async () => {
    // Review live25, correctness-2 minor 4: call() registered the
    // turn/start before writing it, so the crash end the refused write
    // started saw a turn/start in flight, queued its interrupt behind the
    // response, and waited the full 500 ms grace for an answer that could
    // not come.
    // Scale-based, not time-bound: with a 5 s grace, an end that waited
    // the grace takes at least 5 s, and one that ends at once takes well
    // under half of it even on a loaded runner (the 400 ms absolute bound
    // this replaced failed at 514 ms under a full gate).
    const graceMs = 5_000;
    const session = await startAndWait({}, {}, graceMs);
    refuseWrites(session.proc, (line) => line.includes("turn/start"));
    const started = Date.now();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    expect(await session.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(graceMs / 2);
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
  });

  test("an orderly end whose interrupt the app-server will not take exits 1, not 0 (review live25 sibling)", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    refuseWrites(session.proc, (line) => line.includes("turn/interrupt"));
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(String(fatal?.message)).toContain("could not deliver the end-path interrupt");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
  });

  test("a refused initialized notification sends no thread request", async () => {
    const attempted: string[] = [];
    const session = await startSession({}, {}, (_driver, proc) => {
      refuseWrites(proc, (line) => {
        attempted.push(line);
        return line.includes("notifications/initialized");
      });
    });
    expect(await session.code).toBe(1);
    expect(attempted.some((line) => line.includes("notifications/initialized"))).toBe(true);
    expect(attempted.some((line) => line.includes("thread/start"))).toBe(false);
  });

  test("an early harness line that ends the session starts no handshake", async () => {
    const attempted: string[] = [];
    const session = await startSession({}, {}, (driver, proc) => {
      refuseWrites(proc, (line) => {
        attempted.push(line);
        return false;
      });
      driver.handleHarnessLine("not json");
    });
    expect(await session.code).toBe(1);
    expect(attempted.some((line) => line.includes('"initialize"'))).toBe(false);
  });
});
