import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { SessionProcess } from "../src/session/process.js";
import {
  cleanups,
  FAKE,
  of,
  send,
  startSession,
  waitFor,
  workRoot,
  type Event
} from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

describe("claude session driver e2e", () => {
  test("a failing event sink ends the session with exit 1 instead of dropping it", async () => {
    const session = await startSession({
      sink: async () => {
        throw new Error("sink broke");
      },
    });
    // The fake stays silent until input, so this line is what makes the
    // first event's flush fail: the session must end (crash, exit 1)
    // rather than run on with delivery silently disabled.
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    expect(await session.code).toBe(1);
    expect(session.events).toHaveLength(0);
  });

  test("a text whose harness frame cannot fit is rejected text_too_long before the ack", async () => {
    // The M2 window: 16 MiB of quotes passes the protocol's raw-text
    // bound, but JSON-escaping doubles every quote, so the harness frame
    // lands past the 17 MiB write cap. The line must be rejected — an
    // accepted line that cannot reach the harness would hang its turn
    // open with the caller told it went through. No process is needed:
    // the check fires before anything is written.
    const lines: string[] = [];
    const driver = new ClaudeSessionDriver({
      agent: "claude",
      sessionId: crypto.randomUUID(),
      autonomy: "high",
      cwd: workRoot(),
      sandboxed: false,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      playwrightMcp: false,
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath: null,
      harnessHome: "/tmp",
      providerBaseUrl: null,
      sink: (line) => {
        lines.push(line);
      },
    });
    driver.handleCallerLine(
      JSON.stringify({ type: "user", text: '"'.repeat(16 * 1024 * 1024) })
    );
    driver.dispose();
    const events = lines.map((line) => JSON.parse(line) as Event);
    const acks = events.filter(
      (event) => event.type === "input_accepted" || event.type === "input_rejected"
    );
    expect(acks).toHaveLength(1);
    expect(acks[0]?.type).toBe("input_rejected");
    expect(acks[0]?.reason).toBe("text_too_long");
    // Nothing was echoed and no turn opened for the undeliverable line.
    expect(events.some((event) => event.type === "user_message")).toBe(false);
    expect(events.some((event) => event.type === "turn_started")).toBe(false);
  });

  test("a harness-stdin write failure is a fatal codemux error, not a silent diagnostic", async () => {
    // M2's second half: when a write is refused after the ack (a broken
    // harness stdin), the driver must end the session as its own failure
    // rather than print a diagnostic and leave the turn hanging open.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_started"), "session_started");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "interrupt" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("could not deliver a line to the harness");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a sink failing on the final event reports exit 1, not success", async () => {
    // M3: shutdown has already set `finished`, so the failure callback's
    // own end attempt is a no-op and the flush rejection was swallowed —
    // a caller whose pipe broke on `session_ended` still saw exit 0. The
    // exit code must carry the delivery failure.
    const events: Event[] = [];
    const session = await startSession({
      sink: (line) => {
        const event = JSON.parse(line) as Event;
        events.push(event);
        if (event.type === "session_ended") throw new Error("final write broke");
      },
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
  });

  test("a sink that stalls on the final event still resolves run() with exit 1", async () => {
    // Review live3, correctness 1: the one-second give-up used to win
    // the race without marking the final event undelivered and without
    // canceling the flush, so a stalled (never-settling, never-throwing)
    // sink reproduced run() resolving 0 with `session_ended` undelivered
    // and the flush poll loop holding the process open. The give-up now
    // reports the miss AND abandons the queue, so the end path resolves.
    const events: Event[] = [];
    const session = await startSession({
      sink: (line) => {
        const event = JSON.parse(line) as Event;
        events.push(event);
        if (event.type === "session_ended") {
          // A stopped reader: the write is accepted but never completes.
          return new Promise<void>(() => {});
        }
      },
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(events, of("session_ended"), "session_ended queued");
    // run() must resolve (this await is the regression: it used to hang
    // behind the flush poll loop) and carry the delivery failure.
    expect(await session.code).toBe(1);
  });

  test("a signal that fires before attach stops the child instead of stranding it", async () => {
    // Review live4, codex blocker 1 (the window is every driver's): the
    // signal handlers are installed at construction, but the child is
    // attached only after the CLI's async spawn; a signal in that window
    // finished the driver with no child to stop, and the child then ran
    // on, never stopped. handleCallerEnd() is the same public pre-attach
    // end a signal produces, deterministically.
    const dir = mkdtempSync(join(workRoot(), "s-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const driver = new ClaudeSessionDriver({
      agent: "claude",
      sessionId: crypto.randomUUID(),
      autonomy: "high",
      cwd: dir,
      sandboxed: false,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      playwrightMcp: false,
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath: null,
      harnessHome: join(dir, "home"),
      providerBaseUrl: null,
      sink: () => {},
    });
    // The pre-attach end: the driver finishes with no child to stop.
    driver.handleCallerEnd();
    const proc = new SessionProcess({
      command: ["bun", FAKE, "-p", "--verbose", "--session-id", "unused"],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        FAKE_STATE_DIR: stateDir,
        FAKE_CWD: dir,
        HOME: dir,
      },
      onLine: (line) => driver.handleHarnessLine(line),
      onFatal: (fatal) => driver.handleFatal(fatal),
      graceMs: 500,
    });
    driver.attach(proc);
    // Already finished: resolves without starting the session, and the
    // child that arrived after the end is stopped by attach itself.
    expect(await driver.run()).toBe(0);
    const outcome = await Promise.race([
      proc.exited,
      Bun.sleep(4_000).then(() => null),
    ]);
    expect(outcome).not.toBeNull();
    driver.dispose();
    await proc.settled;
  });

  test("signal handlers stay installed until cleanup completes", async () => {
    // Review live5, major 1: finish() used to dispose the signal gate
    // early, so a second SIGINT/SIGTERM during the shutdown grace hit
    // Node's default disposition and killed codemux mid-kill — the child
    // tree it was about to stop survived it. The gate must stay installed
    // until the child has settled and session_ended is out.
    //
    // The check is deterministic: send() runs finish()'s synchronous
    // prefix (finished=true, requestStop sent), while the awaits from
    // proc.settled onward can only resume on a later event-loop turn, so
    // the listener counts read right after send() see the mid-cleanup
    // state for certain.
    const count = () =>
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const withGate = count();
    send(session.driver, { type: "shutdown" });
    // Mid-cleanup: the end path has begun but has not settled — the
    // gate's three listeners must still be installed so a second signal
    // reaches the fire-once latch instead of the default disposition.
    expect(count()).toBe(withGate);
    expect(await session.code).toBe(0);
    // Cleanup complete: exactly the gate came off with the final report.
    expect(count()).toBe(withGate - 3);
  });
});
