/**
 * Served-model e2e (design P5): the model-naming wire frames the fake
 * stamps under FAKE_MODEL_ID flow through the real driver into
 * session_started, turn_completed, and the ledger's session_turn line,
 * and a wire that names no model (the default fake) reports null on the
 * same three surfaces.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor
} from "./helpers/session-e2e.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

registerNoLeakedSignals(
  async (mark) => { while (cleanups.length > mark) await cleanups.pop()!(); },
  () => cleanups.length
);

/** The session_turn ledger line a session wrote, from the test-run ledger. */
function turnLedgerLine(sessionId: string): Record<string, unknown> | undefined {
  const path = process.env.CODEMUX_TEST_LEDGER as string;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record["session_id"] === sessionId && record["kind"] === "session_turn");
}

describe("claude session served model (design P5)", () => {
  test("a naming wire reports the init model at start and message.model per turn", async () => {
    const session = await startSession(
      { modelAlias: "judge" },
      { FAKE_MODEL_ID: "glm-5.3" }
    );
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    // The init frame's `model` is the harness naming what it configured,
    // so the announcement reports source `harness`.
    expect(started.model_served).toBe("glm-5.3");
    expect(started.model_served_source).toBe("harness");
    expect(started.model_alias).toBe("judge");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // `message.model` is the provider's own report of what answered the
    // turn, so the completion reports source `provider`.
    expect(completed.model_served).toBe("glm-5.3");
    expect(completed.model_served_source).toBe("provider");
    expect(completed.model_alias).toBe("judge");
    // The ledger line mirrors the event: the turn's model_effective and
    // the alias the request carried.
    const line = turnLedgerLine(session.options.sessionId);
    expect(line?.["model_effective"]).toBe("glm-5.3");
    expect(line?.["model_alias"]).toBe("judge");
    send(session.driver, { type: "shutdown" });
    await session.code;
  });

  test("a wire that names no model reports null on every surface", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.model_served).toBeNull();
    expect(started.model_served_source).toBeNull();
    expect(started.model_alias).toBeNull();
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.model_served).toBeNull();
    expect(completed.model_served_source).toBeNull();
    expect(completed.model_alias).toBeNull();
    const line = turnLedgerLine(session.options.sessionId);
    expect(line?.["model_effective"]).toBeNull();
    expect(line?.["model_alias"]).toBeNull();
    send(session.driver, { type: "shutdown" });
    await session.code;
  });
});
