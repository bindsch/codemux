/**
 * The shared turn engine's verdict and stream arms, driven at the driver
 * level over the synthetic rig (tests/helpers/session-turn-engine.ts):
 * the whole-stdout verdict rules (no wire, wrong session, no id, the
 * deferred untrackable turn), the gemini line-stream mapping through the
 * real profile, and the per-turn spawn failure paths. The end path's
 * interleavings live in tests/session-turn-engine-end.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { GEMINI_DRIVER_PROFILE } from "../src/session/gemini-driver.js";
import {
  engineSession,
  fakeTurnProcess,
  silentStreamProfile,
  wireProfile,
} from "./helpers/session-turn-engine.js";

const waitCode = async (session: ReturnType<typeof engineSession>): Promise<number> => {
  const code = await session.code();
  session.dispose();
  return code;
};

describe("the whole-stdout turn verdict", () => {
  test("a minted fresh session announces at run() start and completes its turn", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({ options: { spawnTurn: async () => proc } });
    await session.wait("session_started");
    expect(session.events.at(-1)).toMatchObject({ type: "session_started", agent: "droid" });
    session.user();
    session.line("any buffered line");
    proc.settle();
    proc.exit(0);
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "end", turn_id: "t1" });
    const message = await session.until((event) => event.type === "assistant_message");
    expect(message).toMatchObject({ text: "Done" });
    session.shutdown();
    const ended = await session.wait("session_ended");
    // No registry owns this session (registryPath null), so it is not
    // resumable — the honest verdict, not a crash.
    expect(ended).toMatchObject({ reason: "shutdown", exit_code: 0, resumable: false });
    expect(await waitCode(session)).toBe(0);
  });

  test("a deferred fresh session adopts the first turn's id and settles the home then", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        spawnTurn: async () => proc,
        profile: wireProfile({ sessionId: "harness-mint-9" }, { identity: "deferred" }),
      },
    });
    // No announcement before any output named the session.
    expect(session.events.find((event) => event.type === "session_started")).toBeUndefined();
    session.user();
    proc.settle();
    proc.exit(0);
    const started = await session.wait("session_started");
    expect(started).toMatchObject({ session_id: "harness-mint-9" });
    await session.wait("turn_completed");
    session.shutdown();
    await session.wait("session_ended");
    expect(await waitCode(session)).toBe(0);
  });

  test("a spawn that rejects ends the session crashed with the spawn fatal", async () => {
    const session = engineSession({
      options: { spawnTurn: async () => Promise.reject(new Error("probe refused")) },
    });
    session.user();
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error).toMatchObject({ source: "codemux" });
    expect(error.message).toContain("could not spawn the droid turn process");
    expect(error.message).toContain("probe refused");
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "failed" });
    expect(await waitCode(session)).toBe(1);
  });

  test("a refused prompt write on the stdin carrier ends the turn crashed", async () => {
    const proc = fakeTurnProcess();
    proc.failWrites = true;
    const session = engineSession({ options: { spawnTurn: async () => proc } });
    session.user();
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("could not deliver the prompt to the droid process");
    proc.exit(1);
    expect(await waitCode(session)).toBe(1);
  });

  test("a profile with no parse at all is the wrong-wire tier 3 fatal", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        spawnTurn: async () => proc,
        profile: { ...wireProfile(), parseTurnOutput: undefined },
      },
    });
    session.user();
    proc.settle();
    proc.exit(0);
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("the droid turn produced no parsable wire");
    expect(await waitCode(session)).toBe(1);
  });

  test("output with no result object is the no-wire fatal", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: { spawnTurn: async () => proc, profile: wireProfile({ noWire: true }) },
    });
    session.user();
    proc.settle();
    proc.exit(1);
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("printed no result object");
    expect(error.message).toContain("exited with code 1");
    expect(await waitCode(session)).toBe(1);
  });

  test("output answering under a foreign session id is the wrong-session fatal", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        spawnTurn: async () => proc,
        profile: wireProfile({ wrongSession: true, sessionId: "other-session" }),
      },
    });
    session.user();
    proc.settle();
    proc.exit(0);
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("answered under session other-session");
    expect(await waitCode(session)).toBe(1);
  });

  test("a minted identity whose turn names no id breaks the identity contract", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        spawnTurn: async () => proc,
        profile: wireProfile({ noSessionId: true, sessionId: null }),
      },
    });
    session.user();
    proc.settle();
    proc.exit(0);
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("named no session id, breaking the session identity");
    expect(await waitCode(session)).toBe(1);
  });

  test("the deferred untrackable rule: a first turn with no id fails the turn, then the session", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        spawnTurn: async () => proc,
        profile: wireProfile({ noSessionId: true, sessionId: null }, { identity: "deferred" }),
      },
    });
    session.user();
    proc.settle();
    proc.exit(0);
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "failed" });
    expect(completed.reason).toContain("named no session id");
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("cannot be recorded in the registry");
    const ended = await session.wait("session_ended");
    expect(ended).toMatchObject({ exit_code: 1, resumable: false });
    expect(await waitCode(session)).toBe(1);
  });

  test("a structured failed turn fails the turn but not the session", async () => {
    const first = fakeTurnProcess();
    const second = fakeTurnProcess();
    const procs = [first, second];
    const session = engineSession({
      options: {
        spawnTurn: async () => procs.shift()!,
        profile: wireProfile({ failed: true, failureReason: "budget spent", answer: null }),
      },
    });
    session.user();
    first.settle();
    first.exit(0);
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "failed", reason: "budget spent" });
    expect(session.events.find((event) => event.type === "error" && event.fatal === true)).toBeUndefined();
    // The session survives: the next turn still runs.
    session.user();
    second.settle();
    second.exit(0);
    await session.until(
      (event) => event.type === "turn_completed" && event.turn_id === "t2"
    );
    session.shutdown();
    expect(await waitCode(session)).toBe(0);
  });
});

describe("the gemini line-stream arm through the real profile", () => {
  // A minted id in gemini's own shape (GEMINI_SESSION_ID_PATTERN).
  const MINT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const gemini = (options: Parameters<typeof engineSession>[0]) =>
    engineSession({
      ...options,
      options: {
        ...options?.options,
        profile: GEMINI_DRIVER_PROFILE,
        mintedSessionId: MINT,
      },
    });
  const line = (event: Record<string, unknown>): string => JSON.stringify(event);

  test("init, deltas, tools, a warning, and the result fold into events as they arrive", async () => {
    const proc = fakeTurnProcess();
    const session = gemini({ options: { spawnTurn: async () => proc } });
    session.user();
    session.line(line({ type: "init", session_id: MINT, model: "gemini-2.6-pro" }));
    session.line(line({ type: "message", role: "assistant", content: "Do", delta: true }));
    session.line(line({ type: "message", role: "assistant", content: "ing" }));
    session.line(line({ type: "tool_use", tool_id: "t1", tool_name: "read_file", parameters: { path: "a" } }));
    session.line(line({ type: "tool_result", tool_id: "t1", status: "error", output: "nope" }));
    session.line(line({ type: "error", severity: "warning", message: "a notice" }));
    session.line(line({ type: "result", status: "success", stats: { input_tokens: 100, output_tokens: 20, cached: 10 } }));
    expect(await session.until((event) => event.type === "assistant_delta")).toMatchObject({
      delta: "Do",
      turn_id: "t1",
    });
    expect(await session.until((event) => event.type === "tool_call")).toMatchObject({
      call_id: "t1",
      name: "read_file",
    });
    expect(await session.until((event) => event.type === "tool_result")).toMatchObject({
      is_error: true,
    });
    // The warning reports without failing the turn.
    expect(await session.until((event) => event.type === "error" && event.fatal === false)).toMatchObject({
      message: "a notice",
    });
    proc.settle();
    proc.exit(0);
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "end" });
    expect(completed.usage).toMatchObject({ input_tokens: 90, output_tokens: 20, cached_input_tokens: 10 });
    session.shutdown();
    expect(await waitCode(session)).toBe(0);
  });

  test("a non-JSON line is the unusable fatal", async () => {
    const proc = fakeTurnProcess();
    const session = gemini({ options: { spawnTurn: async () => proc } });
    session.user();
    session.line("not json at all");
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("unusable harness output (not JSON");
    proc.exit(1);
    expect(await waitCode(session)).toBe(1);
  });

  test("an init line naming a foreign session is the grammar fatal", async () => {
    const proc = fakeTurnProcess();
    const session = gemini({ options: { spawnTurn: async () => proc } });
    session.user();
    session.line(line({ type: "init", session_id: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d" }));
    await session.until((event) => event.type === "unknown");
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("session");
    proc.exit(1);
    expect(await waitCode(session)).toBe(1);
  });

  test("a severity-error line fails the turn; the result error names the reason", async () => {
    const proc = fakeTurnProcess();
    const session = gemini({ options: { spawnTurn: async () => proc } });
    session.user();
    session.line(line({ type: "init", session_id: MINT }));
    session.line(line({ type: "error", severity: "error", message: "quota spent" }));
    session.line(line({ type: "result", status: "error", error: "quota spent", stats: { input_tokens: 1, output_tokens: 1 } }));
    proc.settle();
    proc.exit(0);
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "failed", reason: "quota spent" });
    session.shutdown();
    expect(await waitCode(session)).toBe(0);
  });

  test("a stream line with no open turn breaks the stream's grammar", async () => {
    const session = gemini({ options: { spawnTurn: async () => fakeTurnProcess() } });
    session.line(line({ type: "message", role: "assistant", content: "early" }));
    const error = await session.until((event) => event.type === "error" && event.fatal === true);
    expect(error.message).toContain("no open turn");
    expect(await waitCode(session)).toBe(1);
  });

  test("a line-stream deferred wire that never names the id is the untrackable rule", async () => {
    const proc = fakeTurnProcess();
    const session = engineSession({
      options: {
        spawnTurn: async () => proc,
        profile: silentStreamProfile({ identity: "deferred" }),
      },
    });
    session.user();
    session.line(JSON.stringify({ type: "message", role: "assistant", content: "hi" }));
    proc.settle();
    proc.exit(0);
    const completed = await session.wait("turn_completed");
    expect(completed).toMatchObject({ finish: "failed" });
    expect(completed.reason).toContain("named no session id");
    expect(await waitCode(session)).toBe(1);
  });
});
