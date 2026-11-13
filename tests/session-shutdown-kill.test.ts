import { afterAll, expect, test } from "bun:test";
import * as claude from "./helpers/session-e2e.js";
import * as codex from "./session-codex-e2e-helpers.js";
import * as agy from "./helpers/session-agy-e2e.js";
import { SessionStopSignals, shutdownKillWarning } from "../src/session/shutdown-kill.js";

// The persistent fixtures use fixtures/live/shutdown-linger.ts to model
// owned kills and independent exits after stdin closes.
afterAll(async () => {
  await codex.cleanupSessions();
  for (const clean of [...claude.cleanups, ...agy.cleanups].reverse()) await clean();
});

for (const agent of ["claude", "zai", "codex", "agy"] as const) {
  const start = (env: Record<string, string>) => agent === "codex" ? codex.startAndWait({}, env)
    : agent === "agy" ? agy.startSession({}, env) : claude.startSession({ agent }, env);
  for (const kill of ["SIGTERM", "SIGKILL", "143"]) {
    test(`${agent}: requested shutdown after a completed turn accepts owned ${kill}`, async () => {
      const session = await start({ FAKE_SHUTDOWN_LINGER: kill });
      session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:basic one" }));
      const turn = await claude.waitFor(session.events, claude.of("turn_completed"), "completed turn");
      expect(turn.finish).toBe("end");
      session.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
      expect(await session.code).toBe(0);
      const ended = session.events.at(-1)!;
      expect(ended).toMatchObject({ type: "session_ended", reason: "shutdown", exit_code: 0, resumable: true });
      expect(ended.harness_exit).toMatchObject(kill === "143" ? { code: 143, signal: null } : { signal: kill });
      const warnings = session.events.filter((event) => event.type === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain(kill);
      expect(warnings[0]!.raw).toBeNull();
      expect(session.events.some((event) => event.type === "error" && event.fatal)).toBe(false);
    });
  }

  test(`${agent}: a kill while a turn is open still fails`, async () => {
    const session = await start({ FAKE_SHUTDOWN_LINGER: "SIGKILL" });
    const scenario = agent === "agy" ? "wait" : "deaf";
    session.driver.handleCallerLine(JSON.stringify({ type: "user", text: `scenario:${scenario} hold` }));
    await claude.waitFor(session.events, claude.of("turn_started"), "open turn");
    session.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
    expect(await session.code).toBe(1);
    expect(session.events.at(-1)).toMatchObject({ reason: "harness_failed", exit_code: 1 });
    expect(session.events.at(-1)!.harness_exit.signal).toBe("SIGKILL");
    expect(session.events.some((event) => event.type === "warning")).toBe(false);
  });

  for (const code of [42, 143]) {
    test(`${agent}: independent exit ${code} during idle shutdown still fails`, async () => {
      const session = await start({ FAKE_SHUTDOWN_LINGER: `exit${code}` });
      session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:basic one" }));
      await claude.waitFor(session.events, claude.of("turn_completed"), "completed turn");
      session.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
      expect(await session.code).toBe(1);
      expect(session.events.at(-1)).toMatchObject({ reason: "harness_failed", harness_exit: { code, signal: null } });
      expect(session.events.some((event) => event.type === "warning")).toBe(false);
    });
  }

  test(`${agent}: caller EOF after completion also accepts an owned kill`, async () => {
    const session = await start({ FAKE_SHUTDOWN_LINGER: "SIGTERM" });
    session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:basic one" }));
    await claude.waitFor(session.events, claude.of("turn_completed"), "completed turn");
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    expect(session.events.at(-1)).toMatchObject({ reason: "shutdown", exit_code: 0 });
    expect(session.events.some((event) => event.type === "warning")).toBe(true);
  });
}

test("only a matching codemux signal during an idle caller shutdown excuses an exit", () => {
  const signals = new SessionStopSignals();
  const outcome = { code: null, signal: "SIGTERM" };
  const classify = (reason = "shutdown", turnOpen = false, code = 0) =>
    shutdownKillWarning("claude", outcome, signals, reason, turnOpen, code);
  expect(classify()).toBeNull();
  signals.record("SIGTERM", { exitCode: 143, signalCode: null });
  expect(classify()).toBeNull();
  signals.record("SIGTERM", { exitCode: null, signalCode: null });
  expect(classify()).toContain("SIGTERM");
  expect(classify("stdin-close")).toContain("SIGTERM");
  for (const reason of ["timeout", "crash", "signal"]) expect(classify(reason)).toBeNull();
  expect(classify("shutdown", true)).toBeNull();
  expect(classify("shutdown", false, 1)).toBeNull();
  for (const exit of [{ code: 42, signal: null }, { code: 143, signal: "SIGKILL" }, { code: 0, signal: null }]) {
    expect(shutdownKillWarning("claude", exit, signals, "shutdown", false, 0)).toBeNull();
  }
});
