/** Driver e2e test for the opencode session's model fields (design P5),
 * split from tests/session-opencode-e2e-lifecycle.test.ts at the
 * 500-line bound: the resolved-versus-wire id normalization under a
 * provider override. */

import { afterAll, describe, expect, test } from "bun:test";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
} from "./helpers/session-opencode-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("opencode session e2e - model fields", () => {
  test("under a provider override the resolved id reports on session_started while the argv keeps the wire id (design P5)", async () => {
    // Design §2.3's normalization: like every other agent, session_started
    // and the registry record carry the resolved model id; the
    // provider-prefixed wire id (what adapter.wireModelFor computes under
    // an override) rides the per-turn argv alone.
    const session = await startSession({
      model: "kimi-code/k3.1-pro",
      wireModel: "codemux/kimi-code/k3.1-pro",
      modelAlias: "judge",
    });
    try {
      send(session.driver, { type: "user", text: "scenario:basic one" });
      const started = await waitFor(session.events, of("session_started"), "session_started");
      expect(started.model).toBe("kimi-code/k3.1-pro");
      expect(started.model_alias).toBe("judge");
      expect(started.model_served).toBeNull();
      const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
      expect(completed.model_alias).toBe("judge");
      const argvs = fakeRecord(session, "argv.jsonl");
      expect(argvs[0]!.args[argvs[0]!.args.indexOf("--model") + 1]).toBe(
        "codemux/kimi-code/k3.1-pro"
      );
      const registry = readRegistry(session.options.registryPath as string);
      expect(registry.outcome).toBe("ok");
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === started.session_id)
          : undefined;
      expect(entry?.model).toBe("kimi-code/k3.1-pro");
      expect(entry?.model_alias).toBe("judge");
      send(session.driver, { type: "shutdown" });
      expect(await session.code).toBe(0);
    } finally {
      await session.driver.dispose();
    }
  });
});
