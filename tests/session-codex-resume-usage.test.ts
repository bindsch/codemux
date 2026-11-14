import { afterEach, expect, test } from "bun:test";
import { CodexStreamParser } from "../src/session/codex-session.js";
import { cleanupSessions, of, send, startAndWait, waitFor } from "./session-codex-e2e-helpers.js";

afterEach(cleanupSessions);

test("resume usage snapshot is raw-only and never charged to this session", async () => {
  const s = await startAndWait({ resumeThreadId: "0123456789abcdef", harnessVersion: "0.167.1" },
    { FAKE_RESUME_USAGE: "1" });
  send(s.driver, { type: "user", text: "scenario:basic hello" });
  await waitFor(s.events, of("turn_completed"), "new turn");
  send(s.driver, { type: "shutdown" });
  expect(await s.code).toBe(0);
  expect(s.events.some(e => e.type === "unknown" && e.raw?.includes("previous-turn"))).toBe(true);
  expect(s.events.filter(e => e.type === "usage").every(e => e.usage.input_tokens < 90000)).toBe(true);
  expect(s.events.at(-1)?.usage.input_tokens).toBeLessThan(90000);
});

const context = { threadId: "thread", activeTurnId: null, resumedUsageTurnIds: new Set(["old"]) };
const threadId = "0123456789abcdef";
function notification(method: string, threadId: string, turnId: string) {
  return JSON.stringify({ method, params: { threadId, turnId,
    tokenUsage: { last: { inputTokens: 90000, outputTokens: 90000 } } } });
}

for (const status of ["completed", "interrupted", "failed", "inProgress"]) {
  test(`historical ${status} usage stays raw-only after the first new turn`, async () => {
    const s = await startAndWait({ resumeThreadId: threadId },
      { FAKE_RESUME_USAGE: "metadata", FAKE_RESUME_USAGE_STATUS: status });
    send(s.driver, { type: "user", text: "scenario:basic hello" });
    s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "previous-turn"));
    await waitFor(s.events, of("turn_completed"), "new turn");
    s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "previous-turn"));
    send(s.driver, { type: "shutdown" });
    expect(await s.code).toBe(0);
    expect(s.events.filter(e => e.type === "unknown" && e.raw?.includes("previous-turn"))).toHaveLength(2);
    expect(s.events.at(-1)?.usage.input_tokens).toBeLessThan(90000);
  });
}

test("empty paginated history learns usage before the first turn and never charges its replays", async () => {
  const s = await startAndWait({ resumeThreadId: threadId },
    { FAKE_RESUME_USAGE: "1", FAKE_RESUME_EMPTY_TURNS: "1" });
  await waitFor(s.events, events => events.find(e => e.type === "unknown" && e.raw?.includes("previous-turn")), "replay");
  send(s.driver, { type: "user", text: "scenario:basic hello" });
  s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "previous-turn"));
  await waitFor(s.events, of("turn_completed"), "new turn");
  s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "previous-turn"));
  send(s.driver, { type: "shutdown" });
  expect(await s.code).toBe(0);
  expect(s.events.filter(e => e.type === "unknown" && e.raw?.includes("previous-turn"))).toHaveLength(3);
  expect(s.events.some(e => e.type === "usage")).toBe(true);
  expect(s.events.at(-1)?.usage.input_tokens).toBeLessThan(90000);
});

test("historical usage learning ends permanently at the first submitted turn", async () => {
  const s = await startAndWait({ resumeThreadId: threadId },
    { FAKE_RESUME_USAGE: "metadata", FAKE_RESUME_EMPTY_TURNS: "1" });
  send(s.driver, { type: "user", text: "scenario:basic hello" });
  await waitFor(s.events, of("turn_completed"), "new turn");
  s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "unseen-history"));
  expect(await s.code).toBe(1);
  expect(s.events.some(e => e.type === "error" && e.message?.includes("no open turn"))).toBe(true);
});

test("historical usage memory retains only the most recent 1024 IDs", async () => {
  const s = await startAndWait({ resumeThreadId: threadId },
    { FAKE_RESUME_USAGE: "metadata", FAKE_RESUME_EMPTY_TURNS: "1" });
  for (let i = 0; i <= 1024; i++) {
    s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, `old-${i}`));
    if (i % 128 === 0) await Bun.sleep(0);
  }
  send(s.driver, { type: "user", text: "scenario:basic hello" });
  await waitFor(s.events, of("turn_completed"), "new turn");
  s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "old-1024"));
  expect(s.events.at(-1)?.type).toBe("unknown");
  s.driver.handleHarnessLine(notification("thread/tokenUsage/updated", threadId, "old-0"));
  expect(await s.code).toBe(1);
});

test("replay discovery requires a known matching thread and a nonempty turn, and only covers usage", () => {
  const parser = new CodexStreamParser();
  const discovering = { ...context, discoverResumedUsage: true };
  expect(parser.feed(notification("thread/tokenUsage/updated", "thread", "unlisted"), discovering))
    .toEqual([{ kind: "resumed_usage", historicalTurnId: "unlisted" }]);
  for (const [method, thread, turn] of [
    ["thread/tokenUsage/updated", "foreign", "unlisted"],
    ["thread/tokenUsage/updated", "thread", ""],
    ["item/agentMessage/delta", "thread", "unlisted"],
  ]) {
    expect(parser.feed(notification(method!, thread!, turn!), discovering)[0]?.kind).toBe("grammar_error");
  }
  expect(parser.feed(notification("thread/tokenUsage/updated", "thread", "unlisted"),
    { ...discovering, threadId: null })[0]?.kind).toBe("grammar_error");
});

test("saved usage remains uncharged while a new turn starts or runs", () => {
  for (const extra of [{}, { turnPending: true, pendingTurnId: "new" }, { activeTurnId: "new" }]) {
    expect(new CodexStreamParser().feed(notification("thread/tokenUsage/updated", "thread", "old"),
      { ...context, ...extra })).toEqual([{ kind: "unknown" }]);
  }
});

test("resume usage exception does not accept another thread, unknown turns, or old item events", () => {
  for (const [method, thread, turn] of [
    ["thread/tokenUsage/updated", "foreign", "old"],
    ["thread/tokenUsage/updated", "thread", "unknown"],
    ["item/agentMessage/delta", "thread", "old"],
  ]) {
    expect(new CodexStreamParser().feed(notification(method!, thread!, turn!), context)[0]?.kind).toBe("grammar_error");
  }
});
