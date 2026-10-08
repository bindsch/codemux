/**
 * Driver e2e tests for the agy session (design §4.7, plan step 8): the
 * real AgySessionDriver over the scenario-driven fake agy
 * (tests/fixtures/live/fake-agy-session.ts), whose wire shapes come from
 * the step-0 fixture — the claude-style input frame and the
 * `event`-keyed result envelope. Every round-trip is live: the deferred
 * identity model (session_started waits for the first result's
 * conversation id), the two-turn exchange, resume, the honest-false
 * input rejections, and the three tiers' end paths including the
 * fixture-pinned auth failure.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgySessionDriver, type AgyDriverOptions } from "../src/session/agy-driver.js";
import { SessionProcess } from "../src/session/process.js";
import { readRegistry } from "../src/session/registry.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-agy-session.ts", import.meta.url));

type Event = Record<string, any>;

interface Session {
  driver: AgySessionDriver;
  proc: SessionProcess;
  events: Event[];
  code: Promise<number>;
  options: AgyDriverOptions;
  stateDir: string;
  workDir: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups) await clean();
});

let root: string | null = null;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-agy-e2e-"));
  return root;
}

/** One driver over the fake agy; `overrides` may bend any option and
 * `extraEnv` reaches the fake's environment (scenario switches). */
async function startSession(
  overrides: Partial<AgyDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  beforeAttach?: (driver: AgySessionDriver) => void
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const events: Event[] = [];
  const options: AgyDriverOptions = {
    resumeConversationId: null,
    autonomy: "high",
    cwd: workDir,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: true,
    sessionTimeoutMs: null,
    registryPath: join(registryDir, "live-sessions.json"),
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  // The fake reads the conversation it must name from its argv, exactly
  // the way the real binary reads `--conversation`.
  const command = ["bun", FAKE];
  if (options.resumeConversationId !== null) {
    command.push(`--conversation=${options.resumeConversationId}`);
  }
  const driver = new AgySessionDriver(options);
  const proc = new SessionProcess({
    command,
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_STATE_DIR: stateDir,
      HOME: dir,
      ...extraEnv,
    },
    onLine: (line) => driver.handleHarnessLine(line),
    onFatal: (fatal) => driver.handleFatal(fatal),
    graceMs: 500,
  });
  // A harness line that lands before attach queues as an early line.
  beforeAttach?.(driver);
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, code, options, stateDir, workDir };
}

/** What the fake agy recorded, re-read so late appends are visible. */
function fakeRecord(session: Session, name: string): Record<string, any>[] {
  const path = join(session.stateDir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

/** Wait until the event stream satisfies `want`, or fail with what came. */
async function waitFor<T>(
  events: Event[],
  want: (events: Event[]) => T | undefined,
  label: string,
  timeoutMs = 8_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = want(events);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
      );
    }
    await Bun.sleep(10);
  }
}

const of = (type: string) => (events: Event[]) => events.find((event) => event.type === type);

const send = (driver: AgySessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

describe("agy session e2e - lifecycle", () => {
  test("a fresh session runs a two-turn exchange with the identity deferred to the first result", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });

    // Before the first result, the session does not exist yet: the
    // input is answered and echoed with an empty session id.
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic one");
    expect(echo.turn_id).toBe("t1");
    expect(echo.session_id).toBe("");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    expect(turnStarted.raw).toBeNull();

    // The first result both names the conversation and completes the
    // turn: session_started lands after turn_started but before the
    // turn's remaining events (the assertions below pin both sides of
    // that order).
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.agent).toBe("agy");
    expect(started.session_id).toBe("conv-fake-1");
    expect(started.autonomy).toBe("high");
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities).toEqual({
      live_input: true,
      user_during_turn: false,
      steer: false,
      interrupt: false,
      permissions: false,
      deltas: false,
      file_changes: false,
      usage_stream: false,
      resume: true,
    });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic one");
    expect(message.turn_id).toBe("t1");
    expect(message.session_id).toBe("conv-fake-1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live4, contracts 1: `usage_stream: false` means usage rides
    // ONLY the per-turn result envelope — the same contract claude/zai
    // ship. No standalone `usage` event may appear (the turn has
    // completed, so its absence is settled, not early).
    expect(of("usage")(session.events)).toBeUndefined();
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 60,
      output_tokens: 20,
      cached_input_tokens: 40,
      total_tokens: 120,
      cost_usd: null,
    });
    // Identity ordering: the echo and turn_started precede
    // session_started; assistant_message and the rest of the turn's
    // events follow it. Both sides are pinned, not just the first.
    const order = session.events.map((event) => event.type);
    expect(order.indexOf("session_started")).toBeGreaterThan(order.indexOf("turn_started"));
    expect(order.indexOf("session_started")).toBeLessThan(order.indexOf("assistant_message"));

    // The second turn names the same conversation.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");

    send(session.driver, { type: "shutdown" });
    const code = await session.code;
    expect(code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    // Two identical turns, summed field-wise; cost stays null — agy
    // never reports one, and a null component stays null through sums.
    expect(ended.usage).toEqual({
      input_tokens: 120,
      output_tokens: 40,
      cached_input_tokens: 80,
      total_tokens: 240,
      cost_usd: null,
    });

    // The registry recorded the session under the conversation id (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "conv-fake-1")
        : undefined;
    expect(entry?.agent).toBe("agy");
    expect(entry?.ended).not.toBe(null);
  });

  test("a resumed conversation adopts its id at spawn, before any turn", async () => {
    const session = await startSession({ resumeConversationId: "conv-res-7" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("conv-res-7");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    send(session.driver, { type: "user", text: "scenario:basic hi" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.session_id).toBe("conv-res-7");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a resumed conversation the harness never confirms is not reported resumable (review live21)", async () => {
    // The agy sibling of correctness minor 1: a resumed session records
    // at spawn from the registry-vouched id, so `resumable` was true even
    // when agy died before any result named the conversation (the crash
    // scenario: exit 1, no frame).
    const session = await startSession({ resumeConversationId: "conv-res-8" });
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "user", text: "scenario:crash" });
    expect(await session.code).toBe(1);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });

  test("the fixture-pinned auth failure fails the turn and ends the untrackable session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:authfail" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe('status "ERROR": authentication failed or timed out');
    expect(completed.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
      cost_usd: null,
    });
    // No assistant message: the envelope's response is empty.
    expect(of("assistant_message")(session.events)).toBeUndefined();
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("named no conversation id");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    // Never identified, never recorded.
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("an error turn with a known conversation fails the turn but not the session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorturn" });
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe('status "ERROR": the model refused the turn');
    // The session is still alive: the next turn runs.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    expect(second.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("stdin close mid-turn lets the open turn deliver its own result (review live17)", async () => {
    // Review live17, correctness 3: the end path sent SIGTERM in the same
    // step it began and never closed the harness's stdin, so agy — whose
    // only end carrier is the stdin close — never got to finish the turn:
    // it was always the synthesized `interrupted` with null usage. The
    // driver now closes stdin and gives the turn the grace before any
    // signal; the fake models the input loop finishing the running line
    // on EOF, so the turn ends with its own result and real usage.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    expect(completed.raw).not.toBeNull();
    expect(completed.usage.input_tokens).not.toBeNull();
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    // The result named the conversation, so the session was identified.
    expect(of("session_started")(session.events)).toBeDefined();
  });

  test("stdin close mid-turn ends cleanly, with the open turn answered", async () => {
    // Review live10, correctness 7: agy has no interrupt carrier, so the
    // end path used to leave the held turn's `turn_started` unanswered —
    // every other driver closes the pairing through the end-interrupt's
    // drained result. The driver now synthesizes the completion the
    // harness cannot: codemux-originated (raw null), interrupted, and
    // the usage it never reported all-null rather than guessed zeros.
    // FAKE_IGNORE_EOF keeps the turn open past the stdin close (live17
    // gives it the grace to answer first) and dies at once on SIGTERM.
    const session = await startSession({}, { FAKE_IGNORE_EOF: "1" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("stdin-close");
    expect(completed.raw).toBeNull();
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
    // The completion precedes the end on the stream, and the pairing is
    // exactly one-to-one: one turn_started, one turn_completed.
    expect(session.events.indexOf(completed)).toBeLessThan(session.events.indexOf(ended));
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
    // Never identified: a fresh agy session whose first turn never
    // completed has no vouchable conversation id, so nothing was
    // recorded and nothing is resumable — even though the end is clean.
    expect(ended.resumable).toBe(false);
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
  });

  test("the author prefix rides the harness line", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const lines = fakeRecord(session, "input-lines.jsonl");
    expect(lines[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a text whose harness frame cannot fit is rejected text_too_long before the ack", async () => {
    // The M2 window: 16 MiB of quotes passes the protocol's raw-text
    // bound, but the frame's JSON-escaping doubles every quote past the
    // 17 MiB write cap. Rejected, never accepted-then-dropped.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: '"'.repeat(16 * 1024 * 1024) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    // Only turn 1's echo exists; the undeliverable line was never echoed.
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a harness-stdin write failure is a fatal codemux error, not a silent diagnostic", async () => {
    // M2's escalation: a refused write after the ack ends the session as
    // codemux's own failure instead of leaving the turn hanging open.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
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

  test("a write failure on a fresh turn announces the turn before the fatal (review live16)", async () => {
    // Review live16, correctness minor: the user path wrote first and
    // emitted turn_started after, so a refused write put the fatal error
    // (and the crash path) ahead of the turn's opening on the stream.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
    const types = session.events
      .filter((event) => event.turn_id === "t2" || (event.type === "error" && event.fatal))
      .map((event) => event.type);
    // Review live17, correctness minor 6: turn_started now precedes the
    // user_message that names it, the order the claude and codex drivers
    // emit; the live16 rule (both before the fatal) still holds.
    expect(types).toEqual(["turn_started", "user_message", "error", "turn_completed"]);
  });

  test("a sink failing on the final event reports exit 1, not success", async () => {
    // M3: shutdown already set `finished`, so the failure callback's own
    // end attempt is a no-op and the flush rejection was swallowed — a
    // caller whose pipe broke on `session_ended` still saw exit 0.
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
    // Review live3, correctness 1: the give-up used to win without
    // marking the final event undelivered and without canceling the
    // flush, so a stalled sink reproduced run() resolving 0 with
    // `session_ended` undelivered and the flush poll loop holding the
    // process open. The give-up now reports the miss AND abandons the
    // queue, so the end path resolves.
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
});

describe("agy session e2e - honest false capabilities", () => {
  test("mid-turn and unsupported inputs are rejected by name, never silently ignored", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // The honest matrix refuses each unsupported input type outright.
    send(session.driver, { type: "steer", text: "go west" });
    send(session.driver, { type: "interrupt" });
    send(session.driver, {
      type: "permission_decision",
      request_id: "r1",
      decision: "allow",
    });
    const rejections = await waitFor(
      session.events,
      (events) =>
        events.filter((event) => event.type === "input_rejected").length >= 3
          ? events.filter((event) => event.type === "input_rejected")
          : undefined,
      "the three rejections"
    );
    expect(rejections.map((event) => [event.input_seq, event.reason])).toEqual([
      [2, "unsupported"],
      [3, "unsupported"],
      [4, "unsupported"],
    ]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a user line mid-turn is rejected busy — turns serialize", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const rejection = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the busy rejection"
    );
    expect(rejection.reason).toBe("busy");
    expect(rejection.input_seq).toBe(2);
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
  });
});

describe("agy session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("a result naming a foreign conversation is a tier-2 fatal with the raw preserved", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wrongid two" });
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && typeof event.raw === "string" && event.raw.includes("conv-other-9")
        ),
      "the raw passthrough"
    );
    expect(unknown.session_id).toBe("conv-fake-1");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("conv-other-9");
    expect(await session.code).toBe(1);
  });

  test("a frame without an event name is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:noevent probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("no event name");
    expect(await session.code).toBe(1);
  });

  test("a result envelope without a status is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:badresult probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("no usable envelope");
    expect(await session.code).toBe(1);
  });

  test("a harness crash ends the session through the crash path", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the crash error"
    );
    expect(error.message).toContain("exited unexpectedly");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
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
    const driver = new AgySessionDriver({
      resumeConversationId: null,
      autonomy: "high",
      cwd: dir,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      sessionTimeoutMs: null,
      registryPath: null,
      harnessHome: join(dir, "home"),
      providerBaseUrl: null,
      sink: () => {},
    });
    // The pre-attach end: the driver finishes with no child to stop.
    driver.handleCallerEnd();
    const proc = new SessionProcess({
      command: ["bun", FAKE],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        FAKE_STATE_DIR: stateDir,
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
    // early, so a second SIGINT/SIGTERM during the shutdown grace killed
    // codemux mid-kill. The gate must stay installed until the child has
    // settled and session_ended is out. Deterministic: send() runs
    // finish()'s synchronous prefix (requestStop) while the awaits from
    // proc.settled onward resume only on a later event-loop turn.
    const count = () =>
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const withGate = count();
    send(session.driver, { type: "shutdown" });
    // Mid-cleanup: the gate's three listeners must still be installed.
    expect(count()).toBe(withGate);
    expect(await session.code).toBe(0);
    // Cleanup complete: exactly the gate came off.
    expect(count()).toBe(withGate - 3);
  });

  test("the shutdown drain delivers the harness's final output", async () => {
    // Review live5, major 2: harness lines were dropped once `finished`
    // flipped, so a result envelope arriving during the grace window —
    // here the wait turn's success result, emitted by the persist-mode
    // fake as it survives the shutdown SIGTERM — vanished: no
    // turn_completed for the open turn, a short-counted session_ended,
    // exit 0. The drain must deliver it.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // A fresh session's identity lands with the first result; the second
    // turn is the one the drain will complete.
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    const secondTurn = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    expect(secondTurn.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });

    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "drained turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("end");
    expect(completed.usage).toEqual(first.usage);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    // Two identical turns, summed field-wise by the drain's fold.
    expect(ended.usage).toEqual({
      input_tokens: 120,
      output_tokens: 40,
      cached_input_tokens: 80,
      total_tokens: 240,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a fatal arriving during the shutdown drain costs success", async () => {
    // Review live7, major 2: once `finish` began, its re-entry guard
    // ignored every later failure call — the driver emitted the tier-3
    // fatal and still exited 0 with reason "shutdown". Cleanup stays
    // idempotent; the verdict does not freeze until the child settles: a
    // fatal line arriving inside the grace window raises the exit code
    // to 1. FAKE_SIGTERM_PERSIST=garbage keeps the fake alive past the
    // shutdown SIGTERM and emits one non-JSON line before dying (the
    // drained result after it still reaches the caller — both facts
    // hold at once).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "garbage" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    const fatal = session.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unusable harness output");
    // The drain still delivered the open turn's completion alongside the
    // fatal: the grace window is not forfeited by the failure.
    expect(of("turn_completed")(session.events)).toBeDefined();
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // Review live9, contracts: §4.1 and the README promise every input
    // line is acknowledged, but the driver's guard returned before
    // parsing once `finished` flipped — the documented `shutting_down`
    // reason was unreachable dead code. The drain window (`finished`,
    // not yet `settled`) now answers every line with the rejection.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    send(session.driver, { type: "user", text: "too late" });

    const rejection = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "input_rejected" && event.reason === "shutting_down"
        ),
      "the shutting_down rejection"
    );
    expect(rejection.input_seq).toBe(3);
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a harness exiting nonzero during the drain with its turn open costs success", async () => {
    // Review live9, correctness 2 (the agy sibling): finish() resolved
    // with the initiating end's success code and ignored the child's
    // exit — driver exit 0 while session_ended.exit_code said 42. The
    // verdict now reads the child: a turn still open at the drain's end
    // (no result envelope delivered) plus a nonzero exit is a failure,
    // with the error on the stream ahead of session_ended. A delivered
    // result exempts (the drain test above, exit 0) and a signal death
    // exempts itself (code null). Turn 1 must complete first: a fresh
    // agy session has no identity until its first result.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(42);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("exited with code 42 during the shutdown drain");
    // Review live12: this exit class used to leave `turn_started t2`
    // unpaired — the failure verdict and the synthesis were mutually
    // exclusive. The open turn is now answered too: a failed completion
    // whose reason mirrors the fatal, after the error, before the end.
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toContain("exited with code 42 during the shutdown drain");
    expect(completions[1]!.raw).toBeNull();
    expect(completions[1]!.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("a wrapper exiting 143 during the drain is the signal's coded spelling, not a failure", async () => {
    // Review live11: the live9 verdict read any nonzero exit as failure,
    // so a wrapper that answers the shutdown SIGTERM with exit code 143
    // (the scode spelling, 128+SIGTERM) cost success while the signal
    // death it encodes (code null) did not. 143 now exempts itself like
    // the signal, and the still-open turn is synthesized interrupted —
    // agy has no interrupt carrier, so nothing else can answer it. Turn
    // 1 must complete first: a fresh agy session has no identity until
    // its first result.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(143);
    // No false "during the shutdown drain" fatal.
    expect(of("error")(session.events)).toBeUndefined();
    // The open turn is still answered — synthesized interrupted,
    // codemux-originated, usage never guessed.
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second).toBeDefined();
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("interrupted");
    expect(second.reason).toBe("the session ended (shutdown) before the turn completed");
    expect(second.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a crash mid-turn reports one fatal and still answers the open turn", async () => {
    // Review live11, minor 5: the crash path already told the failure
    // story ("exited unexpectedly"), but the live9 verdict then added a
    // second, false "during the shutdown drain" fatal for the same exit,
    // and the open turn's turn_started was never answered — the synthesis
    // only covered exit codes null and 0. The crash end now exempts
    // itself from the drain verdict and the turn is synthesized failed
    // with the crash as its reason.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    // Exactly one fatal — the crash itself — and no drain fatal behind it.
    const fatals = session.events.filter(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatals).toHaveLength(1);
    expect(fatals[0]!.message).toContain("exited unexpectedly");
    expect(
      session.events.some((event) => String(event.message ?? "").includes("shutdown drain"))
    ).toBe(false);
    // The open turn is answered: synthesized failed, codemux-originated,
    // usage never guessed. Events before the first result carry an empty
    // session id — the identity never landed.
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    // Review live17: the reason is the fatal that ended the session.
    expect(completed.reason).toContain("the agy process exited unexpectedly (code 1");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });
});

describe("agy session e2e - review live17", () => {
  test("a nonzero exit during an idle shutdown costs success", async () => {
    // Correctness 4: the drain verdict required an open turn, so an idle
    // agy that failed while persisting ended exit 0 with no error.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(42);
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the agy process exited with code 42 during the shutdown drain");
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  });

  test("a nonzero exit after the drained result costs success (review live18)", async () => {
    // Sibling of the claude-family correctness 6: a delivered result
    // excused every nonzero exit, though no exit convention was ever
    // recorded for agy. The fake delivers the result on the SIGTERM, then
    // exits 1.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit1" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(1);
    expect(of("turn_completed")(session.events)?.finish).toBe("end");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the agy process exited with code 1 during the shutdown drain");
  });
});

describe("agy session e2e - review live22", () => {
  test("a confirmed conversation whose start was never recorded is not resumable", async () => {
    // Correctness major 2: applyResult set harnessConfirmed before the
    // start record ran. When the record failed, the crash end still
    // reported `resumable: true`, and `codemux session --resume <id>`
    // then exited 66 (not found). Resumable now requires a record this
    // process owns, the claude driver's rule.
    const blockerRoot = mkdtempSync(join(workRoot(), "blocker-"));
    const blocker = join(blockerRoot, "blocker");
    writeFileSync(blocker, "not a directory");
    const session = await startSession({ registryPath: join(blocker, "reg", "live-sessions.json") });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("cannot record the session in the registry");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });
});

describe("agy session e2e - review live22 audit siblings", () => {
  test("a caller-stdin read error during the drain does not fail an orderly end", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    session.driver.handleCallerEnd(new Error("EIO: i/o error, read"));
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    const errors = session.events.filter((event) => event.type === "error");
    expect(errors.filter((event) => event.fatal === true)).toHaveLength(0);
  });
});

describe("agy session e2e - review live23 audit siblings", () => {
  test("an early harness line that ends a resumed session starts and records nothing", async () => {
    // run() replayed the early lines, and a resume then announced
    // session_started and recorded the session after the crash began.
    const session = await startSession({ resumeConversationId: "conv-res-23" }, {}, (driver) =>
      driver.handleHarnessLine("not json")
    );
    expect(await session.code).toBe(1);
    expect(session.events.some((event) => event.type === "session_started")).toBe(false);
    const read = readRegistry(session.options.registryPath!);
    if (read.outcome === "ok") {
      expect(read.file.sessions.map((entry) => entry.id)).not.toContain("conv-res-23");
    } else {
      expect(read.outcome).toBe("missing");
    }
  });
});
