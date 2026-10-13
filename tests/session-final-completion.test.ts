import { expect, spyOn, test } from "bun:test";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { CodexSessionDriver } from "../src/session/codex-driver.js";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { OpenCodeSessionDriver } from "../src/session/opencode-driver.js";
import { AiderSessionDriver } from "../src/session/aider-driver.js";
import { BoundedOutboundQueue, MAX_PENDING_EVENTS } from "../src/session/process.js";
import type { SessionFsm } from "../src/session/fsm.js";

test("all five drivers preserve final turn pairing behind a blocked sink (al40)", async () => {
  for (const agent of ["claude", "codex", "agy", "opencode", "aider"] as const) {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const delivered: Array<Record<string, unknown>> = [];
    const options = {
      agent: "claude" as const,
      sessionId: "al40-session",
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
      registryPath: null,
      harnessHome: process.cwd(),
      historyPath: "unused-history",
      providerBaseUrl: null,
      spawnTurn: async (): Promise<never> => { throw new Error("no spawn in this queue test"); },
      sink: async (line: string) => {
        await blocked;
        delivered.push(JSON.parse(line));
      },
    };
    const driver = agent === "claude" ? new ClaudeSessionDriver(options)
      : agent === "codex" ? new CodexSessionDriver(options)
      : agent === "agy" ? new AgySessionDriver(options)
      : agent === "opencode" ? new OpenCodeSessionDriver(options)
      : new AiderSessionDriver(options);
    // Isolate the queue/end-path contract from each harness's startup
    // protocol. Seed the shared FSM with an open turn, then use the
    // driver's real queue, overflow callback, and final synthesis.
    const rig = driver as unknown as {
      fsm: SessionFsm;
      out: BoundedOutboundQueue;
      done: Promise<number>;
    };
    const queuedFinals: Array<{ type: string; accepted: boolean }> = [];
    let closed!: () => void;
    const closing = new Promise<void>((resolve) => { closed = resolve; });
    const enqueue = rig.out.enqueue.bind(rig.out);
    const observed = spyOn(rig.out, "enqueue").mockImplementation((line, lane) => {
      const accepted = enqueue(line, lane);
      const event = JSON.parse(line);
      if (event.type === "turn_completed" || event.type === "session_ended") {
        queuedFinals.push({ type: event.type, accepted });
      }
      if (event.type === "session_ended") closed();
      return accepted;
    });
    try {
      expect(rig.fsm.transition({ kind: "session_started" }), agent).toBeNull();
      expect(rig.fsm.transition({ kind: "turn_started", turnId: "t1" }), agent).toBeNull();
      expect(rig.out.enqueue(JSON.stringify({ type: "turn_started", turn_id: "t1" }))).toBe(true);
      for (let index = 1; index < MAX_PENDING_EVENTS; index++) {
        expect(rig.out.enqueue(JSON.stringify({ type: "unknown" }))).toBe(true);
      }
      expect(rig.out.enqueue(JSON.stringify({ type: "unknown" }))).toBe(false);
      await closing;
      expect(queuedFinals, agent).toEqual([
        { type: "turn_completed", accepted: true },
        { type: "session_ended", accepted: true },
      ]);
      release();
      expect(await rig.done, agent).toBeGreaterThan(0);
      const paired = delivered.filter((event) =>
        ["turn_started", "turn_completed", "session_ended"].includes(event.type as string));
      expect(paired.map((event) => event.type), agent).toEqual([
        "turn_started", "turn_completed", "session_ended",
      ]);
      expect(paired[1]?.turn_id, agent).toBe("t1");
    } finally {
      release();
      observed.mockRestore();
      driver.dispose();
    }
  }
});
