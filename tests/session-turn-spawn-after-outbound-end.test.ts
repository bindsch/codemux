import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderSessionDriver } from "../src/session/aider-driver.js";
import { OpenCodeSessionDriver } from "../src/session/opencode-driver.js";
import { BoundedOutboundQueue, MAX_PENDING_EVENTS } from "../src/session/process.js";
import type { SessionProcess } from "../src/session/process.js";
import type { SessionFsm } from "../src/session/fsm.js";

// Review round 153, finding 2: a turn must not spawn after the driver
// finished. An outbound bound breached inside a caller input's emits
// (the `turn_started` event, or the `user_message` echo) ends the session
// synchronously — the queue's failure callback runs finish, which sets
// `finished` before its first await — so the turn ends with the session
// and spawnTurn is never called. The turn-per-process drivers (aider,
// opencode) are the exposed ones; a normal turn still spawns exactly
// once. The pending-event cap is 1024, so a prefill of MAX-1 makes the
// `turn_started` emit the breach and a prefill of MAX-2 makes the echo
// the breach (the ack always fits ahead of them).
type Rig = {
  fsm: SessionFsm;
  out: BoundedOutboundQueue;
  done: Promise<number>;
  recordBeforeSpawn?: () => string | null;
};

const baseOptions = (
  spawnTurn: () => Promise<SessionProcess>,
  historyPath: string
) => ({
  agent: "claude" as const,
  sessionId: "round153-session",
  resume: false,
  resumeThreadId: null,
  resumeConversationId: null,
  resumeSessionId: null,
  autonomy: "high" as const,
  cwd: process.cwd(),
  hermetic: false,
  sandboxed: false,
  sandboxTrust: "standard" as const,
  sandboxNoNet: false,
  sandboxScrubEnv: false,
  passEnv: [],
  playwrightMcp: false,
  authorPrefix: true,
  permissionTimeoutMs: 300_000,
  turnTimeoutMs: null,
  sessionTimeoutMs: null,
  spawnGraceMs: 200,
  registryPath: null,
  harnessHome: process.cwd(),
  historyPath,
  providerBaseUrl: null,
  spawnTurn,
  sink: async (_line: string) => {},
});

const scratch: string[] = [];
const historyDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-r153-"));
  scratch.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

for (const agent of ["aider", "opencode"] as const) {
  test(`${agent}: no spawn when an outbound bound ends the session inside the input's emits`, async () => {
    // left = pending-event slots free when the caller input arrives:
    // 1 — the ack fits, `turn_started` is the breach;
    // 2 — the ack and `turn_started` fit, the echo is the breach.
    for (const left of [1, 2] as const) {
      let spawnCalls = 0;
      const options = baseOptions(
        () => {
          spawnCalls += 1;
          return new Promise<SessionProcess>(() => {});
        },
        join(historyDir(), "history.md")
      );
      const driver =
        agent === "aider"
          ? new AiderSessionDriver(options)
          : new OpenCodeSessionDriver(options);
      const rig = driver as unknown as Rig;
      let closed!: () => void;
      const closing = new Promise<void>((resolve) => { closed = resolve; });
      const enqueue = rig.out.enqueue.bind(rig.out);
      const observed = spyOn(rig.out, "enqueue").mockImplementation((line, lane) => {
        const accepted = enqueue(line, lane);
        if (JSON.parse(line).type === "session_ended") closed();
        return accepted;
      });
      try {
        // Aider's startTurn re-verifies the history file before every
        // spawn, so the overflow iterations need a real one — otherwise
        // the missing file stops the turn and the guard is untested.
        if (agent === "aider") expect(rig.recordBeforeSpawn?.() ?? null, `${agent} left=${left}`).toBeNull();
        expect(rig.fsm.transition({ kind: "session_started" }), `${agent} left=${left}`).toBeNull();
        for (let index = 0; index < MAX_PENDING_EVENTS - left; index++) {
          expect(rig.out.enqueue(JSON.stringify({ type: "unknown" })), `${agent} left=${left}`).toBe(true);
        }
        driver.handleCallerLine(JSON.stringify({ type: "user", text: "turn me" }));
        await closing;
        expect(spawnCalls, `${agent} left=${left}`).toBe(0);
        expect(await rig.done, `${agent} left=${left}`).toBe(1);
      } finally {
        observed.mockRestore();
        driver.dispose();
      }
    }
  }, 30_000);

  test(`${agent}: a normal turn still spawns once`, async () => {
    let spawnCalls = 0;
    const options = baseOptions(
      () => {
        spawnCalls += 1;
        return new Promise<SessionProcess>(() => {});
      },
      join(historyDir(), "history.md")
    );
    const driver =
      agent === "aider"
        ? new AiderSessionDriver(options)
        : new OpenCodeSessionDriver(options);
    const rig = driver as unknown as Rig;
    try {
      if (agent === "aider") expect(rig.recordBeforeSpawn?.() ?? null).toBeNull();
      expect(rig.fsm.transition({ kind: "session_started" })).toBeNull();
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "spawn me" }));
      expect(spawnCalls).toBe(1);
      // The spawn never lands by design; the caller's shutdown ends the
      // session through the end path (its grace, then abandonment).
      driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
      expect(await rig.done).toBeGreaterThanOrEqual(0);
      expect(spawnCalls).toBe(1);
    } finally {
      driver.dispose();
    }
  }, 30_000);
}
