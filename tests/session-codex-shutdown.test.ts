import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cleanupMark, cleanupSessionsSince, fakeRecord, of, refuseWrites, send,
  startAndWait, startSession, waitFor,
} from "./session-codex-e2e-helpers.js";

let mark = 0;
beforeEach(() => { mark = cleanupMark(); });
afterEach(() => cleanupSessionsSince(mark));

for (const ending of ["shutdown", "stdin-close"] as const) {
  test(`0.167.1 ${ending} waits for unsubscribe before EOF and preserves resume`, async () => {
    const s = await startAndWait({ harnessVersion: "0.167.1" }, { FAKE_UNSUBSCRIBE: "required" });
    send(s.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(s.events, of("turn_completed"), "completed turn");
    if (ending === "shutdown") send(s.driver, { type: "shutdown" });
    else s.driver.handleCallerEnd();
    expect(await s.code).toBe(0);
    expect(s.events.at(-1)).toMatchObject({ type: "session_ended", reason: ending,
      exit_code: 0, shutdown_requested: true, harness_exit: { code: 0, signal: null }, resumable: true });
    expect(fakeRecord(s, "requests.jsonl").at(-1)).toMatchObject({ method: "thread/unsubscribe",
      params: { threadId: "0123456789abcdef" } });
    expect(fakeRecord(s, "shutdown.jsonl")).toEqual([
      { event: "unsubscribe_answer", status: "unsubscribed" }, { event: "eof", acknowledged: true },
    ]);
    expect(s.events.some(e => e.type === "error" || e.type === "warning")).toBe(false);
  });
}

for (const version of ["0.166.0", "0.167.0-alpha.1", null, "invalid"]) {
  test(`${version}: retains EOF shutdown without a new request`, async () => {
    const s = await startAndWait({ harnessVersion: version });
    send(s.driver, { type: "shutdown" });
    expect(await s.code).toBe(0);
    expect(fakeRecord(s, "requests.jsonl").some(r => r.method === "thread/unsubscribe")).toBe(false);
  });
}

for (const mode of ["notLoaded", "notSubscribed", "closed"]) {
  test(`unsubscribe accepts ${mode} on a resumed thread`, async () => {
    const s = await startAndWait({ harnessVersion: "0.167.1", resumeThreadId: "0123456789abcdef" },
      { FAKE_UNSUBSCRIBE: mode });
    send(s.driver, { type: "shutdown" });
    expect(await s.code).toBe(0);
    expect(s.events.at(-1)?.resumable).toBe(true);
  });
}

for (const mode of ["missing", "reject", "invalid"]) {
  test(`unsubscribe ${mode} remains bounded and reports the failure`, async () => {
    const s = await startAndWait({ harnessVersion: "0.167.1" }, { FAKE_UNSUBSCRIBE: mode }, 100);
    send(s.driver, { type: "shutdown" });
    expect(await s.code).toBe(1);
    expect(s.events.at(-1)?.exit_code).toBe(1);
    expect(s.events.some(e => (e.type === "error" || e.type === "warning") && String(e.message).includes("thread/unsubscribe"))).toBe(true);
    expect(fakeRecord(s, "shutdown.jsonl").at(-1)?.event).toBe("eof");
  });
}

test("an undeliverable unsubscribe closes stdin and retains the raw failure", async () => {
  const s = await startAndWait({ harnessVersion: "0.167.1" }, { FAKE_UNSUBSCRIBE: "required" });
  refuseWrites(s.proc, line => line.includes("thread/unsubscribe"));
  send(s.driver, { type: "shutdown" });
  expect(await s.code).toBe(1);
  expect(s.events.find(e => e.type === "warning")?.message).toContain("not acknowledged");
  expect(s.events.at(-1)?.harness_exit).toEqual({ code: 1, signal: null });
});

for (const exit of ["1", "42"]) {
  test(`0.167.1 exit ${exit} after acknowledged unsubscribe still fails`, async () => {
    const s = await startAndWait({ harnessVersion: "0.167.1" },
      { FAKE_UNSUBSCRIBE: "required", FAKE_UNSUBSCRIBE_EXIT: exit });
    send(s.driver, { type: "shutdown" });
    expect(await s.code).toBe(1);
    expect(s.events.at(-1)).toMatchObject({ reason: "harness_failed", harness_exit: { code: Number(exit), signal: null } });
  });
}

test("an open turn is interrupted before unsubscribe", async () => {
  const s = await startAndWait({ harnessVersion: "0.167.1" }, { FAKE_UNSUBSCRIBE: "required" });
  send(s.driver, { type: "user", text: "scenario:wait hold" });
  await waitFor(s.events, of("turn_started"), "started turn");
  send(s.driver, { type: "shutdown" });
  expect(await s.code).toBe(0);
  expect(of("turn_completed")(s.events)?.finish).toBe("interrupted");
  const methods = fakeRecord(s, "requests.jsonl").map(r => r.method);
  expect(methods.indexOf("turn/interrupt")).toBeLessThan(methods.indexOf("thread/unsubscribe"));
});

test("a turn that stays open is never unsubscribed", async () => {
  const s = await startAndWait({ harnessVersion: "0.167.1" }, { FAKE_UNSUBSCRIBE: "required" }, 100);
  send(s.driver, { type: "user", text: "scenario:deaf hold" });
  await waitFor(s.events, of("turn_started"), "started turn");
  send(s.driver, { type: "shutdown" });
  expect(await s.code).toBe(1);
  expect(fakeRecord(s, "requests.jsonl").some(r => r.method === "thread/unsubscribe")).toBe(false);
});

test("shutdown during initialization never invents a thread to unsubscribe", async () => {
  const s = await startSession({ harnessVersion: "0.167.1" }, { FAKE_STALL_INIT: "1" });
  send(s.driver, { type: "shutdown" });
  expect(await s.code).toBe(0);
  expect(fakeRecord(s, "requests.jsonl").some(r => r.method === "thread/unsubscribe")).toBe(false);
});

test("an unexpected crash is never excused or followed by unsubscribe", async () => {
  const s = await startAndWait({ harnessVersion: "0.167.1" });
  send(s.driver, { type: "user", text: "scenario:crash fail" });
  expect(await s.code).toBe(1);
  expect(s.events.at(-1)).toMatchObject({ reason: "harness_failed", shutdown_requested: false });
  expect(fakeRecord(s, "requests.jsonl").some(r => r.method === "thread/unsubscribe")).toBe(false);
});
