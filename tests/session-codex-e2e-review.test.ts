import { afterAll, describe, expect, test, spyOn } from "bun:test";
import { readRegistry, recordSessionStart } from "../src/session/registry.js";
import { cleanupSessions, type Event, fakeRecord, of, send, startAndWait, startSession, waitFor } from "./session-codex-e2e-helpers.js";

afterAll(cleanupSessions);

describe("codex session e2e - review live20", () => {
  test("a late usage update and delta from the previous turn do not end the session once the next turn is named", async () => {
    // Correctness major 2: a second user line queued behind turn 1 opens
    // turn 2 the moment turn 1 completes. When turn 1's tokenUsage (real
    // codex sends it after turn/completed) arrived after turn 2's id was
    // known, the parser called it a grammar error and the session ended
    // fatally. Stragglers of the closed turn are now accepted, carry no
    // turn id, and their usage folds into the session total only.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:laggard one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.finish).toBe("end");
    expect(second.usage.total_tokens).toBe(18979);
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    const straggler = session.events.find((event) => event.type === "assistant_delta" && event.delta === "straggler");
    expect(straggler?.turn_id).toBeNull();
    const lateUsage = session.events.find(
      (event) => event.type === "usage" && event.usage.total_tokens === 2009
    );
    expect(lateUsage?.turn_id).toBeNull();
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(18979 + 2009);
    expect(await session.code).toBe(0);
  });

  test("a decision whose answer cannot be written is rejected, never acked accepted", async () => {
    // Correctness major 3: the refused write started the crash end, which
    // superseded the approval, and the decision was still acked accepted.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "deny" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = session.events.find(
      (event) => event.type.startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
    const resolved = session.events.filter((event) => event.type === "permission_resolved");
    expect(resolved.map((event) => event.resolution)).toEqual(["superseded"]);
  });

  test("a line the session state rejects still goes out raw before the fatal (review live21)", async () => {
    // The codex sibling of the claude-family tier-2 fix: a duplicate
    // approval id was reported but its line never mirrored.
    const session = await startSession();
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "user", text: "scenario:dupask" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("duplicate permission request id");
    const mirrored = session.events.filter(
      (event) => event.type === "unknown" && String(event.raw).includes("cmd-dup-2")
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]!.seq).toBe(fatal!.seq - 1);
  });

  test("a claimed resume the server refuses is not reported resumable (review live21)", async () => {
    // The codex sibling of correctness minor 1: `resumable` followed the
    // claim alone, so a resume the server answered with another thread
    // (FAKE_RESUME_WRONG_THREAD) ended on the crash path still reporting
    // `resumable: true`.
    const threadId = "0123456789abcdef";
    const session = await startSession(
      { resumeThreadId: threadId },
      { FAKE_RESUME_WRONG_THREAD: "1" }
    );
    expect(
      recordSessionStart(session.options.registryPath as string, {
        id: threadId,
        agent: "codex",
        cwd: session.options.cwd,
        hermetic: false,
        harness_home: session.options.harnessHome,
        provider_base_url: null,
        model: null,
        autonomy: "high",
        sandboxed: true,
        sandbox_trust: "standard",
        sandbox_no_net: false,
        sandbox_scrub_env: false,
        pass_env: [],
        playwright_mcp: false,
      }).ok
    ).toBe(true);
    session.driver.adoptResumeClaim();
    expect(await session.code).toBe(1);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    // The claim is still released.
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome === "ok" && read.file.sessions[0]?.ended !== null).toBe(true);
  });

  test("a claimed resume that ends during the handshake releases the claim and stays resumable", async () => {
    // The claude-family sibling of correctness major 1: the CLI claims
    // the record before the spawn, but the driver recorded ownership only
    // at the thread/resume response. An end before it skipped the end
    // stamp and reported resumable false.
    const threadId = "0123456789abcdef";
    const session = await startSession({ resumeThreadId: threadId }, { FAKE_STALL_INIT: "1" });
    expect(
      recordSessionStart(session.options.registryPath as string, {
        id: threadId,
        agent: "codex",
        cwd: session.options.cwd,
        hermetic: false,
        harness_home: session.options.harnessHome,
        provider_base_url: null,
        model: null,
        autonomy: "high",
        sandboxed: true,
        sandbox_trust: "standard",
        sandbox_no_net: false,
        sandbox_scrub_env: false,
        pass_env: [],
        playwright_mcp: false,
      }).ok
    ).toBe(true);
    session.driver.adoptResumeClaim();
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.resumable).toBe(true);
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome === "ok" && read.file.sessions[0]?.ended !== null).toBe(true);
  });
});

describe("codex session e2e - review live22", () => {
  test("a session ending mid-turn keeps the open turn's reported usage", async () => {
    // Correctness major 1: usage for the open turn collected in turnUsage
    // and folded into the session total only at turn/completed. An end
    // with the turn still open synthesized a completion with all-null
    // usage and left those tokens out of session_ended.usage, though the
    // caller had already seen them as usage events.
    const session = await startAndWait({ turnTimeoutMs: null });
    send(session.driver, { type: "user", text: "scenario:usagewait hold" });
    const reported = await waitFor(session.events, of("usage"), "usage");
    expect(reported.usage.total_tokens).toBe(311);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = of("turn_completed")(session.events);
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.usage.total_tokens).toBe(311);
    expect(ended.usage.total_tokens).toBe(311);
  });

  test("usage reported before a refused turn/start reaches the session total", async () => {
    // Sibling of major 1: failOpenTurn reported the turn's usage on its
    // turn_completed but never folded it into the session total.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:usagefailstart go" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.usage.total_tokens).toBe(413);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(413);
    expect(await session.code).toBe(0);
  });

  test("a turn/start success that names no turn ends the session at once", async () => {
    // Correctness minor 6: the codemux turn was failed but the server's
    // turn could still be running, and the next queued turn/start went to
    // a busy thread. The session now ends on the crash path; with no
    // turn id there is nothing to interrupt, so no grace window is spent
    // waiting for an answer.
    const session = await startAndWait();
    const started = Date.now();
    send(session.driver, { type: "user", text: "scenario:noturnid one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the turn/start response carries no turn id");
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.finish).toBe("failed");
    expect(fakeRecord(session, "interrupts.jsonl")).toHaveLength(0);
    // Only one turn/start ever reached the server.
    const turnStarts = fakeRecord(session, "requests.jsonl").filter(
      (request) => request.method === "turn/start"
    );
    expect(turnStarts).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a refused timeout interrupt ends the session once, without a re-armed second fatal", async () => {
    // Correctness minor 5 (the codex sibling): the refused write started
    // the crash end, and the timer re-armed anyway; a drain longer than
    // the timeout then raised a false "--turn-timeout" fatal.
    const timeout = globalThis.setTimeout;
    const turnTimers: Array<() => void> = [];
    const parkedTimers: ReturnType<typeof setTimeout>[] = [];
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: any[]) => void, delay?: number, ...args: any[]
    ) => {
      if (delay !== 100) return timeout(callback, delay, ...args);
      turnTimers.push(() => callback(...args));
      const timer = timeout(callback, 60_000, ...args);
      parkedTimers.push(timer);
      return timer;
    }) as typeof setTimeout);
    try {
      const session = await startAndWait({ turnTimeoutMs: 100 }, { FAKE_SIGTERM_PERSIST: "exit143" });
      send(session.driver, { type: "user", text: "scenario:deaf hold" });
      // turn_started is local. The shim item proves turn/start was read
      // and its native turn id is available before the timeout fires.
      await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-deaf")),
        "the turn's first item"
      );
      expect(turnTimers).toHaveLength(1);
      session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
      clearTimeout(parkedTimers[0]);
      turnTimers[0]!();
      const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
      expect(ended.reason).toBe("harness_failed");
      expect(await session.code).toBe(1);
      expect(turnTimers).toHaveLength(1);
      const fatals = session.events.filter((event) => event.type === "error" && event.fatal === true);
      expect(fatals.map((event) => event.message)).toEqual([
        "could not deliver a line to the harness (backlog)",
      ]);
    } finally {
      for (const timer of parkedTimers) clearTimeout(timer);
      timerSpy.mockRestore();
    }
  });
});

describe("codex session e2e - review live22 audit siblings", () => {
  test("a caller-stdin read error during the drain does not fail an orderly end", async () => {
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    session.driver.handleCallerEnd(new Error("EIO: i/o error, read"));
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(0);
    const errors = session.events.filter((event) => event.type === "error");
    expect(errors.filter((event) => event.fatal === true)).toHaveLength(0);
    expect(errors.some((event) => String(event.message).includes("EIO"))).toBe(true);
  });
});

describe("codex session e2e - review live23", () => {
  const ackFor = (events: Array<Record<string, any>>, inputSeq: number) =>
    events.find((event) => String(event.type).startsWith("input_") && event.input_seq === inputSeq);

  test("an interrupt whose write is refused is rejected, never acked accepted", async () => {
    // Correctness-2 minor 1: the interrupt was acked before it was
    // written, so a refused write left an accepted ack for an interrupt
    // the harness never got.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "interrupt" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = ackFor(session.events, 2);
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
  });

  test("a steer whose write is refused is rejected and never echoed", async () => {
    // The steer sibling of minor 1: it was acked and echoed as a
    // user_message on the turn before the write was attempted.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "steer", text: "lost" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
    const ack = ackFor(session.events, 2);
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
    expect(
      session.events.some((event) => event.type === "user_message" && event.input_seq === 2)
    ).toBe(false);
  });

  test("a steer the app-server rejects is reported by its input_seq and turn", async () => {
    // Correctness-2 minor 2: the rejection was a bare non-fatal error, so
    // nothing told the caller which acked, echoed steer never arrived.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refusesteer hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    send(session.driver, { type: "steer", text: "too late" });
    const notice = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && String(event.message).includes("rejected the steer")),
      "steer rejection"
    );
    expect(notice.fatal).toBe(false);
    expect(notice.message).toContain("input_seq 2, turn t1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a straggler from two turns back is still late, not a grammar error", async () => {
    // Correctness-2 minor 3: only the last closed turn was remembered, so
    // turn 1's usage arriving once turn 3 was named ended the session.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:laggard2 one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    send(session.driver, { type: "user", text: "scenario:basic three" });
    const third = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t3"),
      "turn_completed t3"
    );
    expect(third.finish).toBe("end");
    expect(session.events.filter((event) => event.type === "error")).toEqual([]);
    const lateUsage = session.events.find(
      (event) => event.type === "usage" && event.usage.total_tokens === 2009
    );
    expect(lateUsage?.turn_id).toBeNull();
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(2 * 18979 + 2009);
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - review live23 contracts", () => {
  test("response-side violations mirror the raw line before the fatal", async () => {
    // Contracts major 1 (second half): an unknown response id, a thread
    // response with a bad id, a turn/start success with no turn id, and a
    // thread/started naming another thread ended with the fatal alone,
    // though design §4.2 mirrors the line wherever a violation is caught.
    const stringId = await startSession({}, { FAKE_STRING_ID_RESPONSE: "1" });
    expect(await stringId.code).toBe(1);
    const idFatal = stringId.events.find((event) => event.type === "error" && event.fatal === true);
    expect(idFatal?.message).toContain("unknown request id 1");
    const idMirror = stringId.events.find((event) => event.seq === idFatal!.seq - 1);
    expect(idMirror?.type).toBe("unknown");
    expect(String(idMirror?.raw)).toContain('"id":"1"');

    const noTurn = await startAndWait();
    send(noTurn.driver, { type: "user", text: "scenario:noturnid hold" });
    expect(await noTurn.code).toBe(1);
    const turnFatal = noTurn.events.find((event) => event.type === "error" && event.fatal === true);
    expect(turnFatal?.message).toContain("carries no turn id");
    const turnMirror = noTurn.events.find((event) => event.seq === turnFatal!.seq - 1);
    expect(turnMirror?.type).toBe("unknown");
    expect(String(turnMirror?.raw)).toContain('"status":"inProgress"');
  });
});
