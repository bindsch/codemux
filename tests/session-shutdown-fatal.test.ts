import { expect, test } from "bun:test";
import { AiderSessionDriver } from "../src/session/aider-driver.js";
import { OpenCodeSessionDriver } from "../src/session/opencode-driver.js";
import type { SessionFsm } from "../src/session/fsm.js";
import type { SessionProcess } from "../src/session/process.js";

test.each(["aider", "opencode"])("%s cancels the shutdown wait when a fatal arrives", async (agent) => {
  const events: Array<Record<string, unknown>> = [];
  const options = {
    sessionId: "shutdown-fatal", resume: false, resumeSessionId: null,
    autonomy: "high" as const, cwd: process.cwd(), hermetic: false, sandboxed: false,
    sandboxTrust: "standard" as const, sandboxNoNet: false, sandboxScrubEnv: false,
    passEnv: [], authorPrefix: true, sessionTimeoutMs: null, registryPath: null,
    harnessHome: process.cwd(), historyPath: "unused", providerBaseUrl: null,
    spawnTurn: async (): Promise<never> => { throw new Error("no spawn needed"); },
    sink: (line: string) => { events.push(JSON.parse(line)); },
  };
  const driver = agent === "aider" ? new AiderSessionDriver(options) : new OpenCodeSessionDriver(options);
  const rig = driver as unknown as {
    fsm: SessionFsm; turnProc: SessionProcess; done: Promise<number>;
    finish(reason: "shutdown", code: number): Promise<void>;
  };
  let predicate!: () => boolean;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let stopped = false;
  const outcome = { code: 143, signal: null };
  rig.turnProc = {
    awaitEndAnswer(answered: () => boolean) { predicate = answered; return waiting; },
    requestStop() { stopped = true; }, settled: Promise.resolve(), exited: Promise.resolve(outcome),
  } as unknown as SessionProcess;
  expect(rig.fsm.transition({ kind: "session_started" })).toBeNull();
  expect(rig.fsm.transition({ kind: "turn_started", turnId: "t1" })).toBeNull();
  const finishing = rig.finish("shutdown", 0);
  try {
    expect(predicate()).toBe(false);
    driver.handleFatal({ kind: "line-overflow", bytes: 100, excerpt: "overflow" });
    expect(predicate()).toBe(true);
    release();
    await finishing;
    expect(stopped).toBe(true);
    expect(await rig.done).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: "session_ended", harness_exit: outcome, reason: "harness_failed" });
  } finally { release(); await finishing; driver.dispose(); }
});
