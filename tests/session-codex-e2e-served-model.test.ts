/**
 * Served-model e2e for the codex app-server session (design P5): the
 * thread/start response's top-level `model` reports on session_started
 * (source harness), a turn's model/rerouted notification reports on
 * turn_completed (source provider), a turn without one reports null, and
 * the ledger line mirrors the attribution.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanupMark, cleanupSessions, cleanupSessionsSince, of, send, startAndWait, waitFor } from "./session-codex-e2e-helpers.js";

afterAll(async () => {
  await cleanupSessions();
});

/** The test-run ledger's current byte length (0 when it does not exist yet). */
function ledgerOffset(): number {
  try { return readFileSync(process.env.CODEMUX_TEST_LEDGER as string).length; } catch { return 0; }
}

/** The session_turn ledger lines a session wrote after `offset`. The fake
 * codex app-server answers every thread/start with the same fixed thread
 * id, and the ledger is shared by the whole test run, so the session id
 * alone also matches every earlier fake codex session's turns (full run 2
 * of lane F47-T read 44 such lines). */
function turnLedgerLines(sessionId: string, offset: number): Record<string, unknown>[] {
  const path = process.env.CODEMUX_TEST_LEDGER as string;
  return readFileSync(path).subarray(offset).toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["session_id"] === sessionId && record["kind"] === "session_turn");
}

describe("codex session served model (design P5)", () => {
  test("thread response reports at start; a reroute reports per turn; no reroute reports null", async () => {
    const mark = cleanupMark();
    const offset = ledgerOffset();
    try {
      const session = await startAndWait({ modelAlias: "judge" });
      // The fake's thread/start response carries a top-level `model`
      // beside `thread` — the harness naming what it configured, so the
      // announcement reports source `harness`.
      const started = session.events.find((event) => event.type === "session_started")!;
      expect(started.model_served).toBe("gpt-fake");
      expect(started.model_served_source).toBe("harness");
      expect(started.model_alias).toBe("judge");

      // A rerouted turn attributes the notification's to-model: the
      // provider's own report of what served the turn.
      send(session.driver, { type: "user", text: "scenario:reroute reroute me" });
      const rerouted = await waitFor(session.events, of("turn_completed"), "rerouted turn_completed");
      expect(rerouted.model_served).toBe("gpt-5.3-codex");
      expect(rerouted.model_served_source).toBe("provider");
      expect(rerouted.model_alias).toBe("judge");

      // A turn without a reroute reports null: the thread response's
      // model configured the SESSION, never a turn.
      send(session.driver, { type: "user", text: "scenario:basic plain" });
      const plain = await waitFor(
        session.events,
        (events) => {
          const completions = events.filter((event) => event.type === "turn_completed");
          return completions.length >= 2 ? completions[completions.length - 1] : undefined;
        },
        "plain turn_completed"
      );
      expect(plain.model_served).toBeNull();
      expect(plain.model_served_source).toBeNull();
      expect(plain.model_alias).toBe("judge");

      // The ledger mirrors both turns: the rerouted one attributed, the
      // plain one null.
      const lines = turnLedgerLines(started.session_id, offset);
      expect(lines.map((line) => [line["model_effective"], line["model_alias"]])).toEqual([
        ["gpt-5.3-codex", "judge"],
        [null, "judge"],
      ]);

      send(session.driver, { type: "shutdown" });
      await session.code;
    } finally {
      await cleanupSessionsSince(mark);
    }
  });
});
