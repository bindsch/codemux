import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionProcess } from "../src/session/process.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  type Event
} from "./helpers/session-e2e.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

// Review round 4, session finding 8: every session a test built is ended
// in that test's afterEach, not left for the file's afterAll — a driver
// still holding the process's signal handlers would fire in any later
// test that raises one.
registerNoLeakedSignals(
  async (mark) => { while (cleanups.length > mark) await cleanups.pop()!(); },
  () => cleanups.length
);

describe("claude fake fidelity - review live23", () => {
  test("the fake's interrupt answer has the recorded wire's shape", async () => {
    // Contracts minor 8: the fake's interrupt echo carried an inner
    // `subtype: "success"` the recorded wire never has, so a byte-level
    // pin against the fake would have validated a shape the harness
    // never sends.
    const recorded = readFileSync(
      fileURLToPath(new URL("./fixtures/live/zai-session-a.ndjson", import.meta.url)),
      "utf8"
    )
      .split("\n")
      .filter((line) => line.includes("still_queued"))
      .map((line) => JSON.parse(JSON.parse(line).line).response.response);
    expect(recorded.length).toBeGreaterThan(0);
    const shapeOf = (value: Record<string, unknown>) => Object.keys(value).sort();
    for (const scenario of ["wait", "deaf"]) {
      const session = await startSession();
      send(session.driver, { type: "user", text: `scenario:${scenario} hold` });
      await waitFor(session.events, of("assistant_message"), "assistant_message");
      send(session.driver, { type: "interrupt" });
      const answer = await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("still_queued")),
        "interrupt answer"
      );
      expect(shapeOf(JSON.parse(answer.raw).response.response)).toEqual(shapeOf(recorded[0]));
      send(session.driver, { type: "shutdown" });
      await session.code;
    }
  }, 30_000);
});

/** Refuse the harness writes `refuse` picks, the way a harness that
 * stopped reading refuses them (the backlog cap); pass the rest through. */
function refuseWrites(proc: SessionProcess, refuse: (line: string) => boolean): void {
  const real = proc.writeLine.bind(proc);
  proc.writeLine = (line: string) => (refuse(line) ? { ok: false, reason: "backlog" } : real(line));
}

describe("claude session driver e2e - review live25", () => {
  test("an orderly end whose interrupt the harness will not take exits 1, not 0", async () => {
    // Review live25, correctness-2 minor 5: a harness that stopped reading
    // stdin refused the end-path interrupt silently, died by SIGTERM (code
    // null, so no drain failure), and the synthesized "interrupted" turn
    // let the shutdown end 0.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    refuseWrites(session.proc, (line) => line.includes('"interrupt"'));
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(String(fatal?.message)).toContain("could not deliver the end-path interrupt");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  }, 30_000);
});

describe("claude session driver e2e - review live23 audit siblings", () => {
  test("a control request whose answer is refused mirrors first and claims no answer", async () => {
    const session = await startSession();
    refuseWrites(session.proc, (line) => line.includes("does not implement"));
    send(session.driver, { type: "user", text: "scenario:ctlreq go" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    const mirror = session.events.find(
      (event) => event.type === "unknown" && String(event.raw).includes("hook_callback")
    );
    expect(mirror!.seq).toBeLessThan(fatal!.seq);
    expect(
      session.events.some((event) => event.type === "error" && String(event.message).includes("answered with an error"))
    ).toBe(false);
  }, 30_000);

  test("a caller interrupt after a refused supersede writes no second interrupt", async () => {
    // The refused deny started the crash end, which wrote its own
    // interrupt; the handler then wrote another and overwrote the id a
    // refusal is matched against.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ask go" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes('"deny"')) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "interrupt" });
    await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    const ack = session.events.find(
      (event) => String(event.type).startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    await Bun.sleep(100);
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  }, 30_000);

  test("a timeout interrupt that was never written does not label the end's interrupt turn-timeout", async () => {
    const session = await startSession({ turnTimeoutMs: 100 });
    // Installed before the turn opens, so the timer cannot win the race.
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes('"interrupt"')) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.reason).not.toBe("turn-timeout");
  }, 30_000);

  test("an interrupt held for init names its input_seq when delivery is refused", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    refuseWrites(session.proc, (line) => line.includes('"interrupt"'));
    await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(
      session.events.some(
        (event) => event.type === "error" && String(event.message).includes("(input_seq 2) could not be delivered")
      )
    ).toBe(true);
  }, 30_000);
});
