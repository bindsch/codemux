import { afterAll, expect, test } from "bun:test";
import * as aider from "./helpers/session-aider-e2e.js";
import * as opencode from "./helpers/session-opencode-e2e.js";
import * as kimi from "./helpers/session-kimi-e2e.js";
import { of, waitFor } from "./helpers/session-e2e.js";
import { engineSession, fakeTurnProcess, wireProfile } from "./helpers/session-turn-engine.js";
import { SessionStopSignals } from "../src/session/shutdown-kill.js";

afterAll(async () => {
  for (const clean of [...aider.cleanups, ...opencode.cleanups, ...kimi.cleanups].reverse()) await clean();
});

for (const [name, start] of [["aider", aider.startSession], ["opencode", opencode.startSession], ["kimi", kimi.startSession]] as const) {
  test(`${name}: completed process turns shut down cleanly; an owned kill with a turn open fails`, async () => {
    const idle = await start();
    idle.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:basic one" }));
    await waitFor(idle.events, of("turn_completed"), "completed turn");
    idle.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
    expect(await idle.code).toBe(0);
    expect(idle.events.at(-1)).toMatchObject({ reason: "shutdown", exit_code: 0 });

    const active = await start();
    active.driver.handleCallerLine(JSON.stringify({ type: "user", text: "scenario:wait hold" }));
    await waitFor(active.events, of("turn_started"), "open turn");
    active.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
    expect(await active.code).toBe(1);
    expect(active.events.at(-1)).toMatchObject({ reason: "harness_failed", exit_code: 1 });
    expect(active.events.some((event) => event.type === "warning")).toBe(false);
  });
}

for (const agent of ["cursor", "droid", "pi", "qwen", "gemini", "copilot", "goose", "openhands", "cline"] as const) {
  test(`${agent}: shared turn engine never excuses a kill before process completion`, async () => {
    const child = fakeTurnProcess();
    Object.assign(child, { stopSignals: new SessionStopSignals() });
    child.requestStop = () => {
      child.stopSignals.record("SIGTERM", { exitCode: null, signalCode: null });
      child.exit(143);
    };
    const session = engineSession({ options: { profile: wireProfile({}, { agent }), spawnTurn: async () => child } });
    session.user();
    await session.wait("turn_started");
    session.shutdown();
    expect(await session.code()).toBe(1);
    expect(session.events.at(-1)).toMatchObject({ reason: "harness_failed", exit_code: 1 });
    expect(session.events.some((event) => event.type === "warning")).toBe(false);
    session.dispose();
  });
}
