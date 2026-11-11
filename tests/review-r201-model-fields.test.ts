import { expect, test } from "bun:test";
import { engineSession, fakeTurnProcess, wireProfile } from "./helpers/session-turn-engine.js";

test.each(["end", "failed", "untrackable", "synthesized"])("shared session model fields survive %s completion", async (finish) => {
  const child = fakeTurnProcess();
  child.requestStop = () => child.exit(0);
  const h = engineSession({ options: {
    modelAlias: "worker", model: "requested", mintedSessionId: "s-1",
    profile: wireProfile({ modelEffective: "served", failed: finish === "failed",
      ...(finish === "untrackable" ? { sessionId: null, noSessionId: true } : {}) },
    { agent: "pi", ...(finish === "untrackable" ? { identity: "deferred" } : {}) }),
    spawnTurn: async () => {
      if (finish === "synthesized") throw new Error("synthetic spawn failure");
      return child;
    },
  } });
  try {
    h.user(); await Promise.resolve(); await Promise.resolve();
    if (finish !== "synthesized") child.exit(0);
    const completed = await h.wait("turn_completed");
    expect(completed).toMatchObject({ model_alias: "worker", model_served: finish === "synthesized" ? null : "served",
      model_served_source: finish === "synthesized" ? null : "provider" });
    if (finish !== "untrackable") {
      expect(h.events.find((e) => e.type === "session_started"))
        .toMatchObject({ model_alias: "worker", model_served: null, model_served_source: null });
    }
  } finally { child.exit(0); h.close(); await h.code(); h.dispose(); }
});
