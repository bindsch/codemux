import { expect, spyOn, test } from "bun:test";
import { initialKimiState, step } from "../src/session/kimi-machine.js";
import { buildSessionEnded, harnessFailed, SessionProcess } from "../src/session/process.js";

const ID = "session_11111111-2222-3333-4444-555555555555";
const hint = JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: ID,
  command: `kimi -r ${ID}`, content: `To resume this session: kimi -r ${ID}` });

test("al41: a fresh resume hint waits for the recorded session announcement", () => {
  for (const registryEnabled of [false, true]) {
    for (const ok of [false, true]) {
      const config = { authorPrefix: true, registryEnabled };
      const state = initialKimiState(null);
      step(state, { kind: "run_started" }, config);
      step(state, { kind: "user_input", line: '{"type":"user","text":"hello"}' }, config);
      const effects = step(state, { kind: "child_line", line: hint }, config);
      if (!registryEnabled) {
        expect(effects.map((effect) => effect.kind)).toEqual(["announce", "emit"]);
        continue;
      }
      expect(effects).toEqual([{ kind: "record_start" }]);
      expect(state.announced).toBe(false);
      const recorded = step(state, { kind: "record_outcome", ok, error: "registry unavailable" }, config);
      if (ok) {
        expect(recorded).toEqual([
          { kind: "announce" }, { kind: "emit", event: "unknown_event", raw: hint },
        ]);
      } else {
        expect(state.announced).toBe(false);
        expect(recorded.some((effect) => effect.kind === "emit")).toBe(false);
      }
      expect(state.pendingHint).toBeNull();
    }
  }
});

for (const code of [0, 1, 7, 137, 143]) {
  for (const errorCode of ["ESRCH", "EPERM"]) {
    test(`al41: delayed exit ${code} with refused ${errorCode} cleanup preserves failure`, async () => {
      const proc = Bun.spawn(["bun", "-e", `process.exit(${code})`], {
        stdin: "pipe", stdout: "pipe", stderr: "ignore",
      });
      await proc.exited;
      const refuses = () => { throw Object.assign(new Error(errorCode), { code: errorCode }); };
      const handleKill = spyOn(proc, "kill").mockImplementation(refuses);
      const rawKill = spyOn(process, "kill").mockImplementation(refuses);
      const error = spyOn(console, "error").mockImplementation(() => {});
      const spawn = spyOn(Bun, "spawn").mockReturnValue(proc);
      const child = new SessionProcess({ command: ["unused"], cwd: process.cwd(), env: {},
        onLine: () => {}, onFatal: () => {}, graceMs: 1 });
      spawn.mockRestore();
      try {
        const config = { authorPrefix: true, registryEnabled: false };
        const state = initialKimiState(ID);
        step(state, { kind: "run_started" }, config);
        step(state, { kind: "user_input", line: '{"type":"user","text":"hello"}' }, config);
        step(state, { kind: "spawn_settled", child }, config);
        step(state, { kind: "stdin_eof" }, config);
        child.requestStop();
        const outcome = await child.exited;
        step(state, { kind: "child_exit", child, outcome }, config);
        const effects = step(state, { kind: "children_settled" }, config);
        expect(outcome).toEqual({ code, signal: null });
        expect(effects).toContainEqual({ kind: "resolve_done", code: code === 0 ? 0 : 1 });
        expect(effects).toContainEqual(expect.objectContaining({ kind: "emit", event: "session_ended",
          reason: code === 0 ? "stdin-close" : "harness_failed", harnessExit: outcome }));
      } finally {
        await child.settled;
        handleKill.mockRestore();
        rawKill.mockRestore();
        error.mockRestore();
      }
    });
  }
}

test("al41: signal outcomes always fail and idle sessions preserve a null outcome", () => {
  for (const signal of ["SIGTERM", "SIGKILL", "SIGINT"]) {
    const outcome = { code: null, signal };
    expect(harnessFailed(outcome)).toBe(true);
    const event = JSON.parse(buildSessionEnded(1, ID, outcome, {
      reason: "shutdown", shutdown_requested: true,
    }));
    expect(event.reason).toBe("harness_failed");
    expect(event.harness_exit).toEqual(outcome);
    expect(event.shutdown_requested).toBe(true);
  }
  expect(harnessFailed(null)).toBe(false);
  expect(harnessFailed({ code: 0, signal: null })).toBe(false);
});
