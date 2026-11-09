import { afterAll, describe, expect, test } from "bun:test";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-opencode-e2e.js";

afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

describe("OpenCode session interruption", () => {
  test("interrupt stops a child, reports its outcome, and accepts a later turn", async () => {
    const session = await startSession({ resumeSessionId: "ses_fake1234567890" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn started");
    send(session.driver, { type: "interrupt" });
    const turn = await waitFor(session.events, of("turn_completed"), "interrupted turn");
    expect(turn.finish).toBe("interrupted");
    send(session.driver, { type: "user", text: "scenario:basic next" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed").length === 2 ? true : undefined,
      "second turn");
    expect(session.events.filter((event) => event.type === "turn_completed")[1]?.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a deadline interrupts only its turn and preserves the raw child exit", async () => {
    const session = await startSession({ resumeSessionId: "ses_fake1234567890", turnTimeoutMs: 50 });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    const turn = await waitFor(session.events, of("turn_completed"), "deadline turn");
    expect(turn.finish).toBe("interrupted");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events.find((event) => event.type === "session_ended");
    expect(ended?.reason).toBe("shutdown");
    expect(ended?.harness_exit).toBeDefined();
    expect(ended?.harness_exit.code !== 0 || ended?.harness_exit.signal !== null).toBe(true);
  });

  test("an interrupt while spawning stops the late child before writing its prompt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = await startSession({ resumeSessionId: "ses_fake1234567890" }, {}, 0, gate);
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    release();
    const turn = await waitFor(session.events, of("turn_completed"), "late interrupted turn");
    expect(turn.finish).toBe("interrupted");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("hermetic construction fails closed without lifetime state", async () => {
    await expect(startSession({ hermetic: true })).rejects.toThrow("session-lifetime private home");
    await expect(startSession({ tools: "none" })).rejects.toThrow("requires --hermetic");
  });

  test("shutdown during an interrupted spawn never restores the canceled prompt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = await startSession({ resumeSessionId: "ses_fake1234567890" }, {}, 0, gate);
    send(session.driver, { type: "user", text: "scenario:wait canceled" });
    send(session.driver, { type: "interrupt" });
    send(session.driver, { type: "shutdown" });
    release();
    expect(await session.code).toBe(0);
    expect(session.events.find((event) => event.type === "turn_completed")?.finish).toBe("interrupted");
  });
});
