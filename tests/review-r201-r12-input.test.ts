import { afterAll, expect, test } from "bun:test";
import * as claude from "./helpers/session-e2e.js";
import * as agy from "./helpers/session-agy-e2e.js";

afterAll(async () => {
  for (const cleanup of [...claude.cleanups, ...agy.cleanups].reverse()) await cleanup();
});

test.each(["claude", "zai", "agy"] as const)("%s rejects an empty prompt before opening a turn", async (agent) => {
  const session = agent === "agy" ? await agy.startSession()
    : await claude.startSession({ agent });
  session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "" }));
  const rejection = await claude.waitFor(session.events, claude.of("input_rejected"), "empty input rejection");
  expect(rejection).toMatchObject({ input_seq: 1, reason: "unsupported" });
  expect(session.events.some((event) => event.type === "input_accepted" || event.type === "turn_started")).toBe(false);
  // Refusal leaves the session available for a real turn.
  session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:basic valid" }));
  await claude.waitFor(session.events, claude.of("turn_completed"), "valid turn completion");
  expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  session.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
  expect(await session.code).toBe(0);
});
