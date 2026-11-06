/**
 * The accepted acknowledgement of a `user` line can itself be the event
 * that breaches the outbound bound (review round 155). The breach ends
 * the session synchronously, and the end path records that no turn is
 * open. The input handler used to go on and open a turn anyway: a turn
 * the harness never received and the end path never completed. All five
 * drivers with this handler shape now stop right after the
 * acknowledgement.
 *
 * The claude-family pre-init path has a second case (review round 156):
 * the acknowledgement fits and the echo overflows. The line is then
 * never written, so the end path must not record it as forwarded.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { CodexSessionDriver } from "../src/session/codex-driver.js";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { OpenCodeSessionDriver } from "../src/session/opencode-driver.js";
import { AiderSessionDriver } from "../src/session/aider-driver.js";
import { BoundedOutboundQueue, MAX_PENDING_EVENTS } from "../src/session/process.js";
import type { SessionProcess } from "../src/session/process.js";
import type { SessionFsm } from "../src/session/fsm.js";

const scratch: string[] = [];
process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

for (const agent of ["claude", "codex", "agy", "opencode", "aider"] as const) {
  test(`${agent}: no turn opens when the acknowledgement overflows the outbound queue`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-r155-"));
    scratch.push(dir);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let spawnCalls = 0;
    const options = {
      agent: "claude" as const,
      sessionId: "round155-session",
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
      historyPath: join(dir, "history.md"),
      providerBaseUrl: null,
      spawnTurn: (): Promise<SessionProcess> => {
        spawnCalls += 1;
        return new Promise<SessionProcess>(() => {});
      },
      sink: async (_line: string) => {
        await blocked;
      },
    };
    const driver = agent === "claude" ? new ClaudeSessionDriver(options)
      : agent === "codex" ? new CodexSessionDriver(options)
      : agent === "agy" ? new AgySessionDriver(options)
      : agent === "opencode" ? new OpenCodeSessionDriver(options)
      : new AiderSessionDriver(options);
    const rig = driver as unknown as {
      fsm: SessionFsm;
      out: BoundedOutboundQueue;
      done: Promise<number>;
      recordBeforeSpawn?: () => string | null;
    };
    const offered: string[] = [];
    let closed!: () => void;
    const closing = new Promise<void>((resolve) => { closed = resolve; });
    const enqueue = rig.out.enqueue.bind(rig.out);
    const observed = spyOn(rig.out, "enqueue").mockImplementation((line, lane) => {
      const accepted = enqueue(line, lane);
      const type = JSON.parse(line).type as string;
      offered.push(type);
      if (type === "session_ended") closed();
      return accepted;
    });
    try {
      if (agent === "aider") expect(rig.recordBeforeSpawn?.() ?? null).toBeNull();
      expect(rig.fsm.transition({ kind: "session_started" }), agent).toBeNull();
      // Fill the pending-event queue exactly: the next event of any kind
      // is the breach, and for a `user` line that is its acknowledgement.
      for (let index = 0; index < MAX_PENDING_EVENTS; index++) {
        expect(rig.out.enqueue(JSON.stringify({ type: "unknown" })), agent).toBe(true);
      }
      offered.length = 0;
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "turn me" }));
      // Synchronously after the handler: no turn is open.
      expect(rig.fsm.activeTurn, agent).toBeNull();
      expect(rig.fsm.state, agent).not.toBe("turn_active");
      await closing;
      expect(offered, agent).not.toContain("turn_started");
      expect(offered, agent).not.toContain("user_message");
      // No turn was opened, so the end path owes no completion for one.
      expect(offered, agent).not.toContain("turn_completed");
      expect(spawnCalls, agent).toBe(0);
      release();
      expect(await rig.done, agent).toBe(1);
    } finally {
      release();
      observed.mockRestore();
      driver.dispose();
    }
  }, 30_000);
}

test("claude: a pre-init line whose echo overflows is not recorded as forwarded", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const options = {
    agent: "claude" as const,
    sessionId: "round156-session",
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
    sink: async (_line: string) => {
      await blocked;
    },
  };
  const driver = new ClaudeSessionDriver(options);
  const rig = driver as unknown as {
    fsm: SessionFsm;
    out: BoundedOutboundQueue;
    done: Promise<number>;
    openerPending: boolean;
    forwardedAtEnd: boolean;
  };
  const offered: Array<{ type: string; message?: string }> = [];
  let closed!: () => void;
  const closing = new Promise<void>((resolve) => { closed = resolve; });
  const enqueue = rig.out.enqueue.bind(rig.out);
  const observed = spyOn(rig.out, "enqueue").mockImplementation((line, lane) => {
    const accepted = enqueue(line, lane);
    const event = JSON.parse(line) as { type: string; message?: string };
    offered.push(event);
    if (event.type === "session_ended") closed();
    return accepted;
  });
  try {
    // Before the init frame: the FSM is still `starting`. One slot is
    // free, so the acknowledgement fits and the echo is the breach.
    expect(rig.fsm.state).toBe("starting");
    for (let index = 0; index < MAX_PENDING_EVENTS - 1; index++) {
      expect(rig.out.enqueue(JSON.stringify({ type: "unknown" }))).toBe(true);
    }
    offered.length = 0;
    driver.handleCallerLine(JSON.stringify({ type: "user", text: "before init" }));
    expect(rig.openerPending).toBe(false);
    expect(rig.forwardedAtEnd).toBe(false);
    await closing;
    expect(offered.map((event) => event.type)).toContain("input_accepted");
    expect(
      offered.some((event) => (event.message ?? "").includes("already forwarded"))
    ).toBe(false);
    release();
    expect(await rig.done).toBe(1);
  } finally {
    release();
    observed.mockRestore();
    driver.dispose();
  }
}, 30_000);
