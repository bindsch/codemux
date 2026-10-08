/**
 * Driver e2e tests for the codex app-server session (design §4.7): the
 * real CodexSessionDriver over the scenario-driven fake app-server
 * (tests/fixtures/live/fake-codex-app-server.ts), whose wire shapes come
 * from the step-0 fixture. Every round-trip is live: the handshake, turn
 * submission and queueing, steering, interrupts, approval decisions and
 * their ceiling, usage accumulation, and the three tiers' end paths.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexSessionDriver,
  MAX_HELD_INPUT_LINES,
  type CodexDriverOptions,
} from "../src/session/codex-driver.js";
import { SessionProcess } from "../src/session/process.js";
import { readRegistry, recordSessionStart } from "../src/session/registry.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-codex-app-server.ts", import.meta.url));

type Event = Record<string, any>;

interface Session {
  driver: CodexSessionDriver;
  proc: SessionProcess;
  events: Event[];
  rawLines: string[];
  code: Promise<number>;
  options: CodexDriverOptions;
  stateDir: string;
  workDir: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

let root: string | null = null;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-codex-e2e-"));
  return root;
}

/** One driver over the fake app-server; `overrides` may bend any option
 * and `extraEnv` reaches the fake's environment (scenario switches). */
async function startSession(
  overrides: Partial<CodexDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  beforeAttach?: (driver: CodexSessionDriver, proc: SessionProcess) => void
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const events: Event[] = [];
  const rawLines: string[] = [];
  const options: CodexDriverOptions = {
    resumeThreadId: null,
    autonomy: "high",
    cwd: workDir,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: true,
    permissionTimeoutMs: 300_000,
    turnTimeoutMs: null,
    sessionTimeoutMs: null,
    registryPath: join(registryDir, "live-sessions.json"),
    harnessHome: join(dir, "home"),
    providerBaseUrl: null,
    sink: (line) => {
      rawLines.push(line);
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  const driver = new CodexSessionDriver(options);
  const proc = new SessionProcess({
    command: ["bun", FAKE],
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_STATE_DIR: stateDir,
      FAKE_CWD: options.cwd,
      HOME: dir,
      ...extraEnv,
    },
    onLine: (line) => driver.handleHarnessLine(line),
    onFatal: (fatal) => driver.handleFatal(fatal),
    graceMs: 500,
  });
  // A harness line that lands before attach queues as an early line.
  beforeAttach?.(driver, proc);
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, rawLines, code, options, stateDir, workDir };
}

/** What the fake app-server recorded, re-read so late appends are visible. */
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

/** The fake records a decision when it reads the answer off its stdin,
 * which may land after the event that announced it; poll for it. */
async function waitForRecord(
  session: Session,
  name: string,
  count = 1,
  timeoutMs = 8_000
): Promise<Record<string, any>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = fakeRecord(session, name);
    if (records.length >= count) return records;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} record(s) in ${name}; saw ${records.length}`);
    }
    await Bun.sleep(10);
  }
}

const of = (type: string) => (events: Event[]) => events.find((event) => event.type === type);

const send = (driver: CodexSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

async function startAndWait(
  overrides: Partial<CodexDriverOptions> = {},
  extraEnv: Record<string, string> = {}
): Promise<Session> {
  const session = await startSession(overrides, extraEnv);
  await waitFor(session.events, of("session_started"), "session_started");
  return session;
}

describe("codex session e2e - lifecycle", () => {
  test("a fresh session handshakes, runs one turn, and ends cleanly on shutdown", async () => {
    const session = await startAndWait();
    const started = of("session_started")(session.events) as Event;
    expect(started.agent).toBe("codex");
    expect(started.autonomy).toBe("high");
    expect(started.sandboxed).toBe(true);
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities).toEqual({
      live_input: true,
      user_during_turn: "queue",
      steer: true,
      interrupt: true,
      permissions: true,
      deltas: true,
      file_changes: "native",
      usage_stream: true,
      resume: true,
    });
    expect(started.session_id).toBe("0123456789abcdef");
    expect(String(started.raw)).toContain("thread/started");

    // The handshake the fixture pinned: initialize, initialized
    // notification, thread/start, and only then the turn.
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "thread/start",
    ]);

    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic hello");
    expect(echo.turn_id).toBe("t1");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    // Review live15: turn_started is emitted at submit, claude-family
    // style — codemux-originated, raw null — never by riding the
    // harness's turn/started notification. The notification itself is a
    // harness echo of codemux's own announcement and mirrors as tier-1
    // unknown.
    expect(turnStarted.raw).toBeNull();
    expect(
      session.events.find(
        (event) => event.type === "unknown" && String(event.raw).includes("turn/started")
      )
    ).toBeDefined();
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Hello.");
    expect(message.turn_id).toBe("t1");
    const deltas = session.events.filter((event) => event.type === "assistant_delta");
    expect(deltas.map((delta) => delta.delta).join("")).toBe("Hello.");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 6686,
      output_tokens: 5,
      cached_input_tokens: 12288,
      total_tokens: 18979,
      cost_usd: null,
    });

    send(session.driver, { type: "shutdown" });
    const code = await session.code;
    expect(code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(ended.usage).toEqual(completed.usage);

    // The registry recorded the session under the thread id (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "0123456789abcdef")
        : undefined;
    expect(entry?.agent).toBe("codex");
    expect(entry?.ended).not.toBe(null);
  });

  test("the home settles onto its key before the registry record is released (review D7, correctness-2 1)", async () => {
    // The window the finding named: the end path closed the record
    // BEFORE renaming the fresh override home onto its session-keyed
    // path, so a --resume arriving in between found a released record
    // whose harness_home named a path that did not exist yet — refused
    // "missing or untrusted" for a session that was resumable a moment
    // later. The settle seam must run while the record is still open:
    // the release is what a resume waits on.
    const observed: Array<{ threadId: string | null; recordEnded: boolean | null }> = [];
    const session = await startSession({
      settleSessionHome: (threadId) => {
        const registry = readRegistry(session.options.registryPath as string);
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === threadId)
            : undefined;
        observed.push({
          threadId,
          recordEnded: entry === undefined ? null : entry.ended !== null,
        });
        return true; // the rename landed
      },
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
    // The settle ran exactly once, on the real thread id, and the record
    // was STILL OPEN when it did — the release had not happened yet.
    expect(observed).toEqual([{ threadId: "0123456789abcdef", recordEnded: false }]);
    // After the end the record is closed: the release did happen, just
    // never before the settle.
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "0123456789abcdef")
        : undefined;
    expect(entry?.ended).not.toBe(null);
  });

  test("caller input that arrives before session_started buffers and replays", async () => {
    const session = await startSession();
    // Sent before run() has seen session_started: nothing may answer yet.
    send(session.driver, { type: "user", text: "scenario:basic early" });
    await waitFor(session.events, of("session_started"), "session_started");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("two user lines before session_started run as two turns in order (review live16)", async () => {
    // Review live16, correctness blocker: the replay opened t1 for the
    // first parked line and queued the second, then announceSession's
    // unconditional drainTurnQueue submitted t2 while t1 was still open
    // — the FSM refused, and the session crashed with exit 1 after both
    // lines were acked accepted.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic first" });
    send(session.driver, { type: "user", text: "scenario:basic second" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    const completed = session.events.filter((event) => event.type === "turn_completed");
    expect(completed.map((event) => [event.turn_id, event.finish])).toEqual([
      ["t1", "end"],
      ["t2", "end"],
    ]);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("shutdown");
  });

  test("stdin close mid-turn interrupts and ends cleanly", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
  });

  test("a resumed thread adopts its id and starts from idle", async () => {
    const session = await startSession({ resumeThreadId: "0123456789abcdef" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("0123456789abcdef");
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "thread/resume",
    ]);
    send(session.driver, { type: "user", text: "scenario:basic again" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a thread response naming an id --resume would refuse fails closed (review live16)", async () => {
    // Review live16, correctness major: the response's thread.id was
    // adopted unchecked, and one past the registry's cap made the whole
    // registry corrupt — every resume refused, the next start reset it.
    const session = await startSession({}, { FAKE_THREAD_ID: "t".repeat(129) });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the thread response carries an invalid thread id");
    expect(of("session_started")(session.events)).toBeUndefined();
    expect(readRegistry(session.options.registryPath as string).outcome).toBe("missing");
  });

  test("a resume answered with a different thread id fails closed", async () => {
    // Review live12: `threadId` is preset to the requested id at
    // construction, so the adopt-if-null never ran for a resume and the
    // response's thread.id — the subscription proof the reference
    // clients validate — was never checked. A server resuming into a
    // DIFFERENT thread ran unannounced under the wrong id. The mismatch
    // now fails closed: one fatal naming both ids, no session_started,
    // and a crash end. (FAKE_RESUME_WRONG_THREAD answers the resume
    // with ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb and sends no
    // thread/started, as the real server does on resume.)
    const session = await startSession(
      { resumeThreadId: "0123456789abcdef" },
      { FAKE_RESUME_WRONG_THREAD: "1" }
    );
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain(
      "resumed thread ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb, not the requested 0123456789abcdef"
    );
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("a shutdown that arrives while the handshake is stalled still ends the session", async () => {
    // Review live4, codex blocker 2: every caller line buffered during
    // startup, shutdown included, so an initialize that never answered
    // held the graceful end hostage behind an unlimited default session.
    // The fake records the initialize and never responds
    // (FAKE_STALL_INIT), and the shutdown must still take effect.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    send(session.driver, { type: "shutdown" });
    // The regression: this await used to hang until a turn-timeout or an
    // external kill; the acked shutdown ends the session at once.
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    // The session never existed: no session_started, and whatever the fake
    // managed to record before the SIGTERM is handshake-only — never any
    // turn traffic (the fake's bun startup races the kill, so the file may
    // also be empty).
    expect(of("session_started")(session.events)).toBeUndefined();
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.every((r) => r.method === "initialize")).toBe(true);
  });

  test("caller lines parked behind a stalled handshake are bounded", async () => {
    // Review live19: every line sent while the handshake was pending went
    // into preSessionLines with no count or byte limit, so an app-server
    // that never answered initialize let the caller grow codemux's
    // memory without bound. Past the bound the session ends with a
    // fatal, and every parked line is answered shutting_down in arrival
    // order.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    const lines = MAX_HELD_INPUT_LINES + 1;
    for (let index = 0; index < lines; index++) {
      send(session.driver, { type: "user", text: `parked ${index}` });
    }
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("before the codex handshake completed");
    const rejected = session.events.filter((event) => event.type === "input_rejected");
    expect(rejected).toHaveLength(lines);
    expect(rejected.every((event) => event.reason === "shutting_down")).toBe(true);
    expect(rejected.map((event) => event.input_seq)).toEqual(
      Array.from({ length: lines }, (_, index) => index + 1)
    );
  }, 20_000);

  test("a handshake response landing after the shutdown ack stops the chain, fresh and resumed", async () => {
    // Review live15: the handshake kept going once an end path began —
    // the initialize response landing inside the drain sent the
    // initialized notification and the thread request, the thread
    // response adopted the id, and the session recorded itself in the
    // registry and announced session_started after the caller's shutdown
    // was already acked. The handshake is codemux's own continuation
    // chain, so it stops the moment an end path began: the response is
    // consumed and nothing is sent, adopted, or recorded. (Deliberately
    // unlike the claude family's init frame and agy's first result —
    // harness-initiated identity frames, which keep announcing.) Both
    // arms: a fresh thread/start and a resumed thread/resume.
    // FAKE_STALL_INIT=release holds the initialize and answers it on the
    // shutdown SIGTERM, deterministically inside the drain.
    const fresh = await startSession({}, { FAKE_STALL_INIT: "release" });
    await waitForRecord(fresh, "requests.jsonl", 1);
    send(fresh.driver, { type: "shutdown" });
    expect(await fresh.code).toBe(0);
    expect(of("session_started")(fresh.events)).toBeUndefined();
    expect(of("error")(fresh.events)).toBeUndefined();
    expect(
      fakeRecord(fresh, "requests.jsonl").some((r) => r.method !== "initialize")
    ).toBe(false);
    expect(readRegistry(fresh.options.registryPath as string).outcome).toBe("missing");
    const freshEnded = fresh.events[fresh.events.length - 1] as Event;
    expect(freshEnded.type).toBe("session_ended");
    expect(freshEnded.reason).toBe("shutdown");

    const resumed = await startSession(
      { resumeThreadId: "0123456789abcdef" },
      { FAKE_STALL_INIT: "release" }
    );
    await waitForRecord(resumed, "requests.jsonl", 1);
    send(resumed.driver, { type: "shutdown" });
    expect(await resumed.code).toBe(0);
    expect(of("session_started")(resumed.events)).toBeUndefined();
    expect(
      fakeRecord(resumed, "requests.jsonl").some((r) => r.method !== "initialize")
    ).toBe(false);
    expect(readRegistry(resumed.options.registryPath as string).outcome).toBe("missing");
  });

  test("a handshake error landing after the shutdown ack does not turn the end into a crash", async () => {
    // Review live15, the failure sibling of the stop rule: the initialize
    // answering with a JSON-RPC error inside the drain used to raise the
    // tier-2 fatal and cost success — the session the caller already
    // ended became a crash because a response nobody waits for failed.
    // FAKE_STALL_INIT=rejectrelease answers the held initialize with an
    // error on the shutdown SIGTERM.
    const session = await startSession({}, { FAKE_STALL_INIT: "rejectrelease" });
    await waitForRecord(session, "requests.jsonl", 1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(of("error")(session.events)).toBeUndefined();
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  });

  test("a response echoing a numbered request id as a string is not the reply", async () => {
    // Review live15: pendingCalls matched on Number(id), so a string "1"
    // answered the numeric request 1 — a reply no request this driver
    // made. Ids now match strictly; the frame fails closed.
    // FAKE_STRING_ID_RESPONSE echoes the initialize id as a string.
    const session = await startSession({}, { FAKE_STRING_ID_RESPONSE: "1" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unknown request id 1");
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("a thread/start response naming a different thread than the announced one fails closed", async () => {
    // Review live15: a thread/started notification adopting the id FIRST
    // left the thread/start response's own id unchecked — the driver
    // announced one id while the response named another, two ids for one
    // session. The mismatch now fails closed naming both, like the
    // resume-path echo check. FAKE_ANNOUNCE_OTHER_THREAD announces
    // 99999999-… before answering thread/start with 0123456789abcdef.
    const session = await startSession({}, { FAKE_ANNOUNCE_OTHER_THREAD: "1" });
    // The notification adopts and announces first: the session DID exist
    // under the announced id before the contradiction arrived.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("99999999-8888-7777-6666-555555555555");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain(
      "started thread 0123456789abcdef, not the announced 99999999-8888-7777-6666-555555555555"
    );
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
  });

  test("caller input buffered during a stalled handshake is answered, never dropped", async () => {
    // Review live10, correctness 2: the only drain of `preSessionLines`
    // was the session_started replay, guarded by `!finished` — so a user
    // line that arrived before the handshake answered, plus an end path
    // that fired before it completed, left the line with no ack, no
    // event, and exit 0, breaking §4.1's every-line-answered contract
    // (the finding's own trigger: `printf '{"type":"user",...}' | codemux
    // session -a codex`). The end path now rejects each buffered line
    // with the same `shutting_down` the drain window gives a fresh line.
    // FAKE_STALL_INIT holds the initialize; handleCallerEnd is the
    // stdin-close the trigger produces.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    send(session.driver, { type: "user", text: "hi" });
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    const rejection = session.events.find(
      (event) => event.type === "input_rejected" && event.reason === "shutting_down"
    );
    expect(rejection).toBeDefined();
    expect(rejection!.input_seq).toBe(1);
    expect(of("session_started")(session.events)).toBeUndefined();
    expect(of("user_message")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
  });

  test("an early shutdown answers the lines parked ahead of it, in order", async () => {
    // Review live14: the starting-state shutdown ack used to take the
    // next input_seq while an earlier user line sat unsequenced in
    // preSessionLines — the shutdown answered seq 1 and the user line's
    // later rejection seq 2, so a broker matching acks in order read
    // its user line's rejection as the shutdown's answer. The parked
    // lines are now rejected first, arrival order preserved, and
    // finish()'s own drain of the same buffer makes the pair
    // idempotent.
    const session = await startSession({}, { FAKE_STALL_INIT: "1" });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const acks = session.events.filter(
      (event) => event.type === "input_accepted" || event.type === "input_rejected"
    );
    expect(acks).toHaveLength(2);
    expect(acks[0]!.type).toBe("input_rejected");
    expect(acks[0]!.reason).toBe("shutting_down");
    expect(acks[0]!.input_seq).toBe(1);
    expect(acks[1]!.type).toBe("input_accepted");
    expect(acks[1]!.input_seq).toBe(2);
    // The session never existed: no announcement, no echo, the end last.
    expect(of("session_started")(session.events)).toBeUndefined();
    expect(of("user_message")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  });

  test("queued user input that can no longer run is reported, not lost silently", async () => {
    // Review live10, correctness 2's sibling: mid-turn user lines acked
    // and echoed but still in the FIFO vanished on every end path. The
    // end path now emits one non-fatal notice naming the drop — the
    // acks cannot be retracted, and a second answer per line would
    // double-ack. FAKE_SIGTERM_PERSIST keeps the drained t1 completion
    // arriving, pinning that the notice and the drain coexist.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:wait one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "scenario:basic two"),
      "queued echo"
    );
    send(session.driver, { type: "shutdown" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the queued-input drop notice"
    );
    expect(error.message).toContain("queued user input");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    // The queued turn never ran: exactly one turn_completed — t1's
    // drained interrupted completion.
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a signal that fires before attach stops the child instead of stranding it", async () => {
    // Review live4, codex blocker 1: the driver installs its signal
    // handlers at construction, but the child is attached only after the
    // CLI's async spawn; a signal in that window finished the driver with
    // no child to stop, and the child then ran on, never stopped.
    // handleCallerEnd() is the same public pre-attach end a signal
    // produces, deterministically — no real signal is needed.
    const dir = mkdtempSync(join(workRoot(), "s-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const events: Event[] = [];
    const driver = new CodexSessionDriver({
      resumeThreadId: null,
      autonomy: "high",
      cwd: dir,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: null,
      sessionTimeoutMs: null,
      registryPath: null,
      harnessHome: join(dir, "home"),
      providerBaseUrl: null,
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
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
    // Already finished: resolves without handshaking, and the child that
    // arrived after the end is stopped by attach itself.
    expect(await driver.run()).toBe(0);
    const outcome = await Promise.race([
      proc.exited,
      Bun.sleep(4_000).then(() => null),
    ]);
    expect(outcome).not.toBeNull();
    driver.dispose();
    await proc.settled;
  });
});

describe("codex session e2e - turns", () => {
  test("mid-turn user input queues and rolls the next turn on completion", async () => {
    const session = await startAndWait();
    // A waiting first turn keeps the session mid-turn while the second
    // input arrives, so the queue path is exercised deterministically.
    send(session.driver, { type: "user", text: "scenario:wait one" });
    await waitFor(session.events, of("turn_started"), "first turn_started");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "scenario:basic two"),
      "second user_message"
    );
    // A queued echo names no turn: the field is absent, not null (the
    // protocol builder omits turn_id rather than writing null).
    expect("turn_id" in echo).toBe(false);
    send(session.driver, { type: "interrupt" });
    const completions = await waitFor(
      session.events,
      (events) => (events.filter((event) => event.type === "turn_completed").length >= 2 ? events : undefined),
      "both turns completed"
    );
    const turns = completions.filter((event) => event.type === "turn_completed");
    expect(turns.map((turn) => [turn.turn_id, turn.finish])).toEqual([
      ["t1", "interrupted"],
      ["t2", "end"],
    ]);
    const started = session.events.filter((event) => event.type === "turn_started");
    expect(started.map((turn) => turn.turn_id)).toEqual(["t1", "t2"]);
    // One turn/start per turn, submitted only after the previous turn
    // completed: the fake saw them in order.
    const turnStarts = fakeRecord(session, "requests.jsonl").filter((r) => r.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("steering rides turn/steer with the harness turn id and echoes on the open turn", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:steer please" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "steer", text: "go west" });
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "go west"),
      "steer echo"
    );
    expect(echo.turn_id).toBe("t1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const steers = fakeRecord(session, "steers.jsonl");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.expectedTurnId).toBe("turn-fake-1");
    expect(steers[0]!.texts).toEqual(["go west"]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("user lines queued behind a turn and steers held for its id are bounded (busy)", async () => {
    // Review live19, the class of the pre-handshake buffer: turnQueue and
    // steerBuffer held every accepted text with no limit. Past the bound
    // a line is rejected busy at its own input_seq, so order holds.
    const rejectionsOf = (session: Session): Event[] =>
      session.events.filter((event) => event.type === "input_rejected");
    const queued = await startAndWait();
    send(queued.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(queued.events, of("turn_started"), "turn_started");
    for (let index = 0; index <= MAX_HELD_INPUT_LINES; index++) {
      send(queued.driver, { type: "user", text: `queued ${index}` });
      if (index % 64 === 0) await Bun.sleep(5);
    }
    const busy = await waitFor(
      queued.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the queue's busy rejection"
    );
    expect(busy.reason).toBe("busy");
    expect(busy.input_seq).toBe(MAX_HELD_INPUT_LINES + 2);
    expect(rejectionsOf(queued)).toHaveLength(1);
    send(queued.driver, { type: "shutdown" });
    await queued.code;

    // The steer hold: turn/start is answered late, so the harness turn
    // id stays unknown while the steers arrive.
    const held = await startAndWait({}, { FAKE_TURNSTART_DELAY: "3000" });
    send(held.driver, { type: "user", text: "scenario:wait hold" });
    for (let index = 0; index <= MAX_HELD_INPUT_LINES; index++) {
      send(held.driver, { type: "steer", text: `steer ${index}` });
      if (index % 64 === 0) await Bun.sleep(5);
    }
    const steerBusy = await waitFor(
      held.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the steer hold's busy rejection"
    );
    expect(steerBusy.reason).toBe("busy");
    expect(steerBusy.input_seq).toBe(MAX_HELD_INPUT_LINES + 2);
    expect(rejectionsOf(held)).toHaveLength(1);
    send(held.driver, { type: "shutdown" });
    await held.code;
  }, 30_000);

  test("a steer buffered while the harness turn id is unknown is reported when its turn dies", async () => {
    // Review live10, correctness 2's sibling: failOpenTurn used to clear
    // the steer buffer silently — the same loss completeTurn reports.
    // The steer lands while the turn/start response is still in flight
    // (both sends are synchronous, so the response cannot interleave),
    // and the failstart scenario's rejection then kills the turn it
    // steered.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failstart nope" });
    send(session.driver, { type: "steer", text: "go west" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the steer drop notice"
    );
    expect(error.message).toContain("steering input arrived too late");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    // No steer ever reached the harness.
    expect(fakeRecord(session, "steers.jsonl")).toEqual([]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("steers buffered behind a delayed turn/start are split, never joined past the write cap", async () => {
    // Review live14: each steer passed the pre-ack deliverability check
    // alone and was acked, but flushSteer then joined every buffered
    // text into ONE turn/steer frame with no size check — two 9 MiB
    // steers made a ~18 MiB frame, over the 17 MiB harness write cap,
    // writeToHarness refused it, and the session crashed as a codemux
    // failure after both inputs had been accepted. The batch is now
    // grown only while the built frame fits, so the join falls back to
    // one request per steer — the wire's common shape anyway (each
    // steer arriving after the turn started sends its own request).
    // FAKE_TURNSTART_DELAY holds the turn/start response so both steers
    // buffer, exactly the race.
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "250" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    send(session.driver, { type: "steer", text: "a".repeat(9 * 1024 * 1024) });
    send(session.driver, { type: "steer", text: "b".repeat(9 * 1024 * 1024) });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    // Pre-fix the joined frame was refused as oversize and ended the
    // session as a crash; the split frames all fit.
    expect(session.events.find((event) => event.type === "error" && event.fatal)).toBeUndefined();
    // Wait for the fake to have READ both split frames before ending the
    // session: a 9 MiB line drains through the pipe for a while, and the
    // fake dies at once on the shutdown SIGTERM — the split is what is
    // under test, not the drain's race with the kill.
    await waitForRecord(session, "steers.jsonl", 2);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    // Both steers reached the harness as separate requests of one text
    // each (initialize, initialized, thread/start, turn/start, then the
    // two turn/steer frames).
    const requests = fakeRecord(session, "requests.jsonl");
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "thread/start",
      "turn/start",
      "turn/steer",
      "turn/steer",
    ]);
    const steers = requests.filter((request) => request.method === "turn/steer");
    expect(steers[0]!.params.input).toHaveLength(1);
    expect(steers[1]!.params.input).toHaveLength(1);
  });

  test("an interrupt request completes the turn as interrupted", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("interrupted");
    expect(completed.turn_id).toBe("t1");
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.turnId).toBe("turn-fake-1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the turn timeout interrupts and reports the reason", async () => {
    const session = await startAndWait({ turnTimeoutMs: 400 });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toBe("turn-timeout");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a rejected interrupt leaves the turn's real completion standing", async () => {
    // Review live4, codex blocker 3: the interrupt's rejection did not
    // clear interruptPending, so the turn's own completion was re-labeled
    // "interrupted" — masking whatever actually happened, a failed turn
    // as much as a clean one.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refuseinterrupt hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the rejected-interrupt error"
    );
    expect(error.message).toContain("rejected the interrupt request");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end"); // not "interrupted"
    expect(completed.reason).toBeUndefined();
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a turn/start error fails the open turn without ending the session", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failstart nope" });
    // Review live15, trigger A: the caller saw t1 open BEFORE the harness
    // refused it — turn_started goes out at submit, so the failed
    // completion answers a start that is on the stream (§4.1's pairing),
    // not an orphan.
    const started = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(started.turn_id).toBe("t1");
    expect(started.raw).toBeNull();
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the turn was refused");
    expect(session.events.indexOf(started)).toBeLessThan(
      session.events.indexOf(completed)
    );
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

  test("a turn/completed with an unrecognized status completes the turn failed and the queue still runs", async () => {
    // Review live15: an unrecognized turn/completed status passed through
    // as tier-1 unknown, leaving the turn open forever — the queued input
    // below never ran and only a timeout or shutdown ended the session.
    // The recognized method names the open turn, so the outcome completes
    // failed with the status named, fail-closed, and the queue the
    // completion releases still runs.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:badstatus stale" });
    const started = await waitFor(session.events, of("turn_started"), "turn_started");
    // Queued while t1 is (still) open: it must run once the completion
    // frees the FSM — the discriminator the old open-turn hang failed.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const first = await waitFor(session.events, of("turn_completed"), "t1 completed");
    expect(first.turn_id).toBe("t1");
    expect(first.finish).toBe("failed");
    expect(first.reason).toBe("the turn completed with unrecognized status expired");
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "t2 completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");
    expect(session.events.filter((event) => event.type === "turn_started").map((t) => t.turn_id)).toEqual(["t1", "t2"]);
    expect(session.events.indexOf(started)).toBeLessThan(session.events.indexOf(first));
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the author prefix rides harness-bound text", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const turnStart = fakeRecord(session, "requests.jsonl").find((r) => r.method === "turn/start");
    expect(turnStart!.params.input[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - tools, files, usage", () => {
  test("commandExecution and fileChange items surface as tool and file events", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:tools edit" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.name).toBe("commandExecution");
    expect(call.input).toEqual({ command: "echo hi", cwd: session.workDir });
    expect(call.call_id).toBeTypeOf("string");
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.output).toBe("hi\n");
    expect(result.is_error).toBe(false);
    const changes = await waitFor(
      session.events,
      (events) => (events.filter((event) => event.type === "file_change").length >= 3 ? events : undefined),
      "file_change events"
    );
    const fileChanges = changes.filter((event) => event.type === "file_change");
    expect(fileChanges.map((change) => [change.path, change.action])).toEqual([
      [join(session.workDir, "new.txt"), "add"],
      [join(session.workDir, "file.txt"), "edit"],
      [join(session.workDir, "old.txt"), "delete"],
    ]);
    for (const change of fileChanges) {
      expect("derived" in change).toBe(false);
    }
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Two usage notifications accumulate into one turn usage: the deltas
    // sum field-wise (§4.2).
    expect(completed.usage).toEqual({
      input_tokens: 125,
      output_tokens: 15,
      cached_input_tokens: 25,
      total_tokens: 165,
      cost_usd: null,
    });
    const usageEvents = session.events.filter((event) => event.type === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]!.turn_id).toBe("t1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.usage).toEqual(completed.usage);
  });
});

describe("codex session e2e - approvals", () => {
  test("an allow decision answers accept and the turn continues", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("commandExecution");
    expect(request.input.command).toBe("rm -rf /");
    expect(request.options).toEqual(["allow", "deny"]);
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("allow");
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("gone\n");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "accept" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a deny decision answers decline and the tool reports the refusal", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "deny" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.is_error).toBe(true);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the permission timeout answers deny and resolves as timeout", async () => {
    const session = await startAndWait({ permissionTimeoutMs: 300 });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("timeout");
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.is_error).toBe(true);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a numeric approval id is answered numerically on the wire", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:asknumeric probe" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    // The caller-facing request_id is the id's string spelling; the wire
    // id must keep its type or the server cannot correlate the reply.
    expect(request.request_id).toBe("42");
    send(session.driver, { type: "permission_decision", request_id: "42", decision: "deny" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe(42);
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an interrupt declines a pending approval as superseded and the session continues", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "interrupt" });
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution"
    );
    expect(superseded.request_id).toBe("appr-1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live14: the wire's status is the verdict. The supersede
    // decline reaches the app-server before the interrupt, and its answer
    // completes the turn "completed" — recasting that as "interrupted"
    // because codemux's own interrupt was still in flight was the defect.
    expect(completed.finish).toBe("end");
    // The harness saw the decline keyed by the pending request's wire id,
    // before the interrupt closed the turn.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-1");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the turn timeout declines a pending approval as superseded too", async () => {
    const session = await startAndWait({ turnTimeoutMs: 400, permissionTimeoutMs: 300_000 });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution",
      5_000
    );
    expect(superseded.request_id).toBe("appr-1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live14, same shape as the caller-interrupt variant above: the
    // supersede decline's answer completes the turn "completed" on the
    // wire while the timeout's interrupt is still in flight, and the
    // wire's status stands — no "interrupted" recast, no "turn-timeout"
    // reason for a turn that delivered its answer.
    expect(completed.finish).toBe("end");
    expect(completed.reason).toBeUndefined();
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an allow above the autonomy ceiling is refused as an escalation", async () => {
    const session = await startAndWait({ autonomy: "medium" });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "the escalation rejection"
    );
    expect(rejected.input_seq).toBe(2);
    // The request was answered deny; the turn still completes.
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an allow on an approval that offers no accept decision is answered deny", async () => {
    // Review live15: availableDecisions ["acceptForSession","decline"]
    // made approvalAccept's pickApprovalDecision substitute "decline"
    // while the driver still resolved "allow" and acked accepted — the
    // caller told allow, the harness told decline, a success reported on
    // a failure path. codemux never answers acceptForSession (the pinned
    // per-request refusal rule), so allow is undeliverable: the request
    // advertises deny as its only option, an allow is rejected
    // `unsupported`, permission_resolved says deny, the harness receives
    // the decline, and a non-fatal error names what happened.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:acceptless probe" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.options).toEqual(["deny"]);
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "unsupported"),
      "the unsupported rejection"
    );
    expect(rejected.input_seq).toBe(2);
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the undeliverable-allow error"
    );
    expect(error.message).toContain("no accept decision");
    // The harness saw the decline, keyed to the request it denied, and
    // the turn completed on it.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.id).toBe("appr-nos");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an in-scope patch allow passes the medium ceiling", async () => {
    const session = await startAndWait({ autonomy: "medium" });
    send(session.driver, { type: "user", text: "scenario:askpatch patch" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("fileChange");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("allow");
    const changes = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change"),
      "the allowed file_change"
    );
    expect(changes.path).toBe(join(session.workDir, "file.txt"));
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "accept" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an unparsable approval is declined, reported non-fatally, and the session continues", async () => {    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:badapproval opaque" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the non-fatal approval error"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("could not be parsed");
    const unknown = session.events.find(
      (event) =>
        event.type === "unknown" &&
        typeof event.raw === "string" &&
        event.raw.includes("item/commandExecution/requestApproval")
    );
    expect(unknown).toBeDefined();
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]!.result).toEqual({ decision: "decline" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an unimplemented server request gets the -32601 answer and a non-fatal error", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:unknownreq probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the non-fatal unimplemented-request error"
    );
    expect(error.message).toContain("fs/readFileText");
    const answers = await waitForRecord(session, "decisions.jsonl");
    expect(answers[0]!.error).toEqual({ code: -32601, message: "codemux does not implement fs/readFileText" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startAndWait();
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
    expect(ended.resumable).toBe(true);
  });

  test("an event for a foreign thread is a tier-2 fatal with the raw preserved", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:badthread foreign" });
    // The raw passthrough: the specific unknown event carrying the
    // foreign frame (the turn/started notification also mirrors as
    // unknown now, review live15, so "first unknown" no longer finds it).
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "unknown" &&
            typeof event.raw === "string" &&
            event.raw.includes("ffffffff-eeee-dddd")
        ),
      "the raw passthrough"
    );
    expect(String(unknown.raw).includes("ffffffff-eeee-dddd")).toBe(true);
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("thread");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a second thread/started is a tier-2 fatal", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:secondthread dupe" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(await session.code).toBe(1);
  });

  test("a frame split by a raw newline rejoins and streams", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:rawnewline split" });
    const delta = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "assistant_delta"),
      "the rejoined delta"
    );
    expect(delta.delta).toBe("split\nline");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a fragment the stream ends inside is reported tier 3, never dropped (review live25)", async () => {
    // Review live25, correctness-2 minor 3: the parser buffered the
    // fragment waiting for its continuation, and nothing reported it when
    // the stream ended, so its output vanished without an event.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:fragment cut" });
    expect(await session.code).toBe(1);
    const fragment = session.events.find(
      (event) => event.type === "error" && String(event.message ?? "").includes("unterminated JSON fragment")
    ) as Event;
    expect(fragment).toBeDefined();
    expect(fragment.fatal).toBe(true);
    expect(fragment.source).toBe("harness");
    expect(String(fragment.message)).toContain('"delta":"cut off');
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
  });

  test("a harness crash ends the session through the crash path", async () => {
    // Extended review live11, minor 5: the crash path already told the
    // failure story, but the live9 verdict then added a second, false
    // "during the shutdown drain" fatal for the same exit, and the open
    // turn's turn_started was never answered — the synthesis only covered
    // exit codes null and 0. The crash end now exempts itself from the
    // drain verdict and the turn is synthesized failed with the crash as
    // its reason.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the crash error"
    );
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
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
    // usage never guessed.
    const completed = session.events.find(
      (event) => event.type === "turn_completed"
    ) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    // Review live17: the reason is the fatal that ended the session.
    expect(completed.reason).toContain("the codex process exited unexpectedly (code");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("a text whose turn/start frame cannot fit is rejected text_too_long before the ack", async () => {
    // The codex frame cannot be built at ack time (the JSON-RPC id and
    // thread id are assigned at send), so the check is the escaped
    // literal plus a wrapper margin: 16 MiB of quotes escapes to 32 MiB,
    // far past the 17 MiB write cap even with the margin's slack.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: '"'.repeat(16 * 1024 * 1024) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    // The line was never echoed and no turn opened for it.
    expect(of("user_message")(session.events)).toBeUndefined();
    expect(of("turn_started")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a harness-stdin write failure is a fatal codemux error, not a silent diagnostic", async () => {
    // M2's escalation: a refused write after the ack ends the session as
    // codemux's own failure instead of leaving the turn hanging open. The
    // turn is submitted from idle so the turn/start write happens now
    // (mid-turn input would queue in the FIFO instead of writing).
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic first" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.proc.writeLine = () => ({ ok: false, reason: "closed" });
    send(session.driver, { type: "user", text: "scenario:basic second" });
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

  test("signal handlers stay installed until cleanup completes", async () => {
    // Review live5, major 1: finish() used to dispose the signal gate
    // early, so a second SIGINT/SIGTERM during the shutdown grace hit
    // Node's default disposition and killed codemux mid-kill. The gate
    // must stay installed until the child has settled and session_ended
    // is out. Deterministic: send() runs finish()'s synchronous prefix
    // (the end-interrupt write, requestStop) while the awaits from
    // proc.settled onward resume only on a later event-loop turn.
    const count = () =>
      process.listenerCount("SIGINT") +
      process.listenerCount("SIGTERM") +
      process.listenerCount("SIGHUP");
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
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
    // flipped, so the app-server's answer to the end-interrupt — the
    // interrupted turn's completion and its last tokenUsage — vanished
    // during the grace window: no turn_completed, a null-usage
    // session_ended, exit 0. FAKE_SIGTERM_PERSIST keeps the fake alive
    // past the shutdown SIGTERM the way the real app-server survives
    // inside the grace window, so its last frames must reach the caller.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.usage).toEqual({
      input_tokens: 14,
      output_tokens: 2,
      cached_input_tokens: 0,
      total_tokens: 16,
      cost_usd: null,
    });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.usage).toEqual(completed.usage);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    // The end path's interrupt was a real correlated call: the fake
    // answered it, and the response was consumed — not an unknown-id
    // fatal — so no error event may sit on the stream.
    expect(of("error")(session.events)).toBeUndefined();
  });

  test("a fatal arriving during the shutdown drain costs success", async () => {
    // Review live7, major 2: once `finish` began, its re-entry guard
    // ignored every later failure call — the driver emitted the tier-3
    // fatal and still exited 0 with reason "shutdown". Cleanup stays
    // idempotent; the verdict does not freeze until the child settles: a
    // fatal line arriving inside the grace window raises the exit code
    // to 1. FAKE_SIGTERM_PERSIST=garbage keeps the fake app-server alive
    // past the shutdown SIGTERM and emits one non-JSON line before
    // dying.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "garbage" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    const fatal = session.events.find(
      (event) => event.type === "error" && event.fatal === true
    );
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("unusable harness output");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
  });

  test("an approval arriving during the shutdown drain is declined and resolved", async () => {
    // Review live8, major 2 (the codex sibling): an approval request
    // landing inside the grace window — after finish() declined
    // everything it found pending — used to register with an expiry
    // timer the end path had already cleared, while the caller's
    // decision channel was already closed: the app-server waited on an
    // answer that could never come, stalling the persistence the grace
    // window exists for. The request is now declined at once with the
    // supersede treatment. FAKE_SIGTERM_PERSIST=ask makes the fake
    // surface the approval from the end-interrupt (keeping the turn
    // open so the request classifies against the driver's open harness
    // turn), which the driver writes inside the end path —
    // deterministically inside the drain.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "ask" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const request = await waitFor(
      session.events,
      of("permission_request"),
      "drain permission_request"
    );
    expect(String(request.request_id)).toBe("appr-drain");
    const resolved = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "permission_resolved" && String(event.request_id) === "appr-drain"
        ),
      "drain permission_resolved"
    );
    expect(resolved.resolution).toBe("superseded");
    // The decline reached the app-server, keyed to the request it denied.
    const decisions = fakeRecord(session, "decisions.jsonl");
    const decline = decisions.find((entry) => String(entry.id) === "appr-drain");
    expect(decline?.result?.decision).toBe("decline");
    // The denial does not forfeit the drain: the held interrupt is
    // answered and the interrupted turn's completion still arrives.
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    expect(of("error")(session.events)).toBeUndefined();
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // Review live9, contracts: §4.1 and the README promise every input
    // line is acknowledged, but the driver's guard returned before
    // parsing once `finished` flipped — the documented `shutting_down`
    // reason was unreachable dead code. The drain window (`finished`,
    // not yet `settled`) now answers every line with the rejection; the
    // two sends are synchronous, so the second line deterministically
    // lands inside the drain.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
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
    // Review live9, correctness 2 (the codex sibling): finish() resolved
    // with the initiating end's success code and ignored the child's
    // exit — driver exit 0 while session_ended.exit_code said 42. The
    // verdict now reads the child: a turn still open at the drain's end
    // (no completion delivered) plus a nonzero exit is a failure, with
    // the error on the stream ahead of session_ended. A delivered
    // completion exempts (the drain test above, exit 0) and a signal
    // death exempts itself (code null).
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(42);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal).toBeDefined();
    expect(fatal!.source).toBe("harness");
    expect(fatal!.message).toContain("exited with code 42 during the shutdown drain");
    // Review live12: this exit class used to leave `turn_started t1`
    // unpaired — the failure verdict and the synthesis were mutually
    // exclusive. The open turn is now answered: a failed completion whose
    // reason mirrors the fatal, after the error and before session_ended.
    const completion = of("turn_completed")(session.events)!;
    expect(completion.turn_id).toBe("t1");
    expect(completion.finish).toBe("failed");
    expect(completion.reason).toContain("exited with code 42 during the shutdown drain");
    expect(completion.raw).toBeNull();
    expect(completion.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(1);
    // The end-interrupt call was delivered but died unanswered.
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
  });

  test("a wrapper exiting 143 during the drain is the signal's coded spelling, not a failure", async () => {
    // Review live11: the live9 verdict read any nonzero exit as failure,
    // so a wrapper that answers the shutdown SIGTERM with exit code 143
    // (the scode spelling, 128+SIGTERM) cost success while the signal
    // death it encodes (code null) did not. 143 now exempts itself like
    // the signal, and the still-open turn is synthesized interrupted —
    // the harness never answered the end-interrupt.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(143);
    // No false "during the shutdown drain" fatal: the coded signal death
    // is the kill the end path itself ordered.
    expect(of("error")(session.events)).toBeUndefined();
    // The open turn is still answered — synthesized interrupted,
    // codemux-originated, usage never guessed.
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.raw).toBeNull();
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(await session.code).toBe(0);
    // The end-interrupt was delivered but died unanswered.
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
  });

  test("a shutdown while turn/start is in flight still interrupts the open turn", async () => {
    // Review live11, major 1: the end path's interrupt was gated on the
    // harness turn id, which stays null until the turn/start response —
    // a shutdown in that window skipped the graceful interrupt entirely
    // and the turn ran until the kill. FAKE_HOLD_TURNSTART holds the
    // response until the shutdown SIGTERM, so it lands inside the drain
    // window, where the buffered end-interrupt must ride it.
    const session = await startAndWait({}, { FAKE_HOLD_TURNSTART: "1" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    // The fake must have READ the turn/start before the shutdown's
    // SIGTERM arrives, or the signal finds nothing held to release and
    // the hold would last forever (the request's write and the signal
    // race the fake's stdin read otherwise). Poll its request log.
    const seen = await waitFor(
      session.events,
      () =>
        fakeRecord(session, "requests.jsonl").some((r) => r.method === "turn/start")
          ? true
          : undefined,
      "the fake to hold the turn/start"
    );
    expect(seen).toBe(true);
    // turn_started for t1 is already on the stream — emitted at submit
    // (review live15, trigger B: it used to ride the turn/started
    // notification, so a shutdown in this window synthesized a completion
    // for a turn the caller never saw open). The shutdown begins while
    // the turn/start response is still in flight; the response can only
    // land inside the drain window.
    const started = of("turn_started")(session.events) as Event;
    expect(started).toBeDefined();
    expect(started.turn_id).toBe("t1");
    send(session.driver, { type: "shutdown" });

    // The regression: the end-interrupt reached the harness at all.
    const interrupts = await waitForRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    // The turn completed through the interrupt, inside the drain: the
    // harness's own completion frame, exactly one — no synthesis — and it
    // answers the t1 start the caller saw (§4.1's pairing).
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(
      session.events.filter((event) => event.type === "turn_completed")
    ).toHaveLength(1);
    expect(typeof completed.raw === "string" && completed.raw.includes("turn/completed")).toBe(true);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    expect(of("error")(session.events)).toBeUndefined();
  });

  test("approvals still pending when the turn completes by itself are superseded", async () => {
    // Review live11, major 2: completeTurn never closed the approval
    // channel, so an approval that lost its race with the turn's own
    // completion stayed pending — a later decision was acked accepted for
    // a request the harness no longer held, while the expiry timer
    // waited to write a stray decline into whatever turn ran next. The
    // completion now supersedes it: declined on the wire, resolved
    // "superseded" to the caller, and a later decision for it is
    // unknown_request.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:asklose race" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    // The app-server ends the turn by itself while the decision is out.
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const superseded = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "permission_resolved" && event.resolution === "superseded"
        ),
      "superseded resolution"
    );
    expect(String(superseded.request_id)).toBe("appr-lose");
    // The decline reached the app-server, keyed to the lost approval.
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions.find((entry) => String(entry.id) === "appr-lose")?.result?.decision).toBe(
      "decline"
    );
    // The session survives and a second turn runs clean.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    // A decision for the dead request is rejected, not applied — and no
    // second decline ever reaches the harness for it.
    send(session.driver, { type: "permission_decision", request_id: "appr-lose", decision: "allow" });
    const rejected = await waitFor(
      session.events,
      (events) =>
        events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "the unknown_request rejection"
    );
    expect(rejected.input_seq).toBe(3);
    expect(
      fakeRecord(session, "decisions.jsonl").filter((entry) => String(entry.id) === "appr-lose")
    ).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a turn that fails while its interrupt is pending completes failed with its own error", async () => {
    // Review live11, major 3: the interrupt override recast the
    // harness's own failed completion as "interrupted" (a rate limit
    // raced against a caller interrupt). The failure now outranks the
    // interrupt label and keeps its reason.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:failoninterrupt hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("rate limit exceeded");
    // The interrupt was accepted on the wire and its response consumed.
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    expect(interrupts).toHaveLength(1);
    expect(of("error")(session.events)).toBeUndefined();
    // The session continues: the interrupt flags died with the turn.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a stale interrupt rejection cannot clear the next turn's interrupt state", async () => {
    // Review live11, major 4: pendingCalls stored only "interrupt", so a
    // rejection whose turn had already completed cleared the interrupt
    // flags of whatever turn was interrupted next — a turn-timeout
    // completion lost its "turn-timeout" reason. t1's interrupt is held
    // unanswered while t1 completes on its own; the rejection flushes
    // only when t2's timeout interrupt arrives, and must clear nothing
    // but itself.
    const session = await startAndWait({ turnTimeoutMs: 800 });
    send(session.driver, { type: "user", text: "scenario:staleinterrupt one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "interrupt" });
    // t1 completes on its own with the interrupt still pending — the
    // driver's own honest label for the race.
    const first = await waitFor(session.events, of("turn_completed"), "t1 completed");
    expect(first.finish).toBe("interrupted");
    // t2 holds until its turn timeout interrupts it; that request is
    // what flushes t1's stale rejection ahead of its own answer.
    send(session.driver, { type: "user", text: "scenario:wait two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "t2 completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("interrupted");
    expect(second.reason).toBe("turn-timeout");
    // The stale rejection itself was reported non-fatally, exactly once,
    // and the session survived it.
    const staleErrors = session.events.filter(
      (event) =>
        event.type === "error" &&
        event.fatal === false &&
        String(event.message).includes("the turn cannot be interrupted")
    );
    expect(staleErrors).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a turn the wire completed is never recast interrupted by a racing timeout", async () => {
    // Review live14: completeTurn recast a wire "completed" as
    // "interrupted" (and, on the timeout path, reason "turn-timeout")
    // whenever its own interrupt was still in flight — a turn that
    // delivered its full answer was reported cut short, and the
    // interrupt's later rejection could not correct it. The latecomplete
    // scenario holds the interrupt's response while the turn completes
    // cleanly on its own, then rejects the interrupt: the wire's status
    // is the verdict. (The claude family's driver-owned label exists
    // because ITS wire never says interrupted — an interrupt arrives as
    // an error result there; codex's wire says it itself.)
    const session = await startAndWait({ turnTimeoutMs: 400 });
    send(session.driver, { type: "user", text: "scenario:latecomplete race" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.reason ?? null).toBe(null);
    // The too-late rejection is a separate driver event behind the
    // completion the fake wrote ahead of it: wait for it rather than
    // reading the array once (a load-slow event loop made that read race
    // under the full suite), then count after the session is fully over.
    await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "error" &&
            event.fatal === false &&
            String(event.message).includes("no longer running")
        ) ?? undefined,
      "the too-late rejection"
    );
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(
      session.events.filter((event) => event.type === "turn_completed")
    ).toHaveLength(1);
    expect(
      session.events.filter(
        (event) =>
          event.type === "error" &&
          event.fatal === false &&
          String(event.message).includes("no longer running")
      )
    ).toHaveLength(1);
  });

  test("a first late thread/started naming the resumed thread passes through", async () => {
    // Review live11's resume probe: the reference clients of the same
    // app-server adopt the resumed thread from the thread/resume
    // response (validating its thread.id) and none waits for — or, on
    // the real server, receives — a thread/started there. A server that
    // announces anyway (FAKE_RESUME_ANNOUNCES) lands the notification
    // after adoption: tier-1 passthrough, not a fatal — the parser's
    // second-thread/started guard cannot know the driver adopted ahead
    // of the notification, and this is the notification's first
    // sighting on the wire.
    const session = await startSession(
      { resumeThreadId: "0123456789abcdef" },
      { FAKE_RESUME_ANNOUNCES: "1" }
    );
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("0123456789abcdef");
    // Adopted from the response: codemux-originated, raw null — the
    // notification had not arrived when the session was announced.
    expect(started.raw).toBeNull();
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && String(event.raw).includes("thread/started")
        ),
      "the late thread/started passthrough"
    );
    expect(unknown).toBeDefined();
    expect(of("error")(session.events)).toBeUndefined();
    // The session works: a turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic again" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - review live17", () => {
  test("the end-interrupt is answered before the stop signal", async () => {
    // Correctness 3: the interrupt and the SIGTERM went out in one step,
    // so an app-server that dies on SIGTERM (the default fake) never
    // answered it and the turn was synthesized. The interrupt now gets
    // the grace first; the turn closes through the wire's own completion.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.raw).not.toBeNull();
    expect(await session.code).toBe(0);
  });

  test("a nonzero exit during an idle shutdown costs success", async () => {
    // Correctness 4: the drain verdict required an open turn.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(42);
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the codex process exited with code 42 during the shutdown drain");
  });

  test("--turn-timeout re-arms, and a turn that ignores its interrupt ends the session", async () => {
    // Correctness 5: the timer fired once; a turn whose interrupt was
    // accepted but never acted on ran uncapped.
    const session = await startAndWait({ turnTimeoutMs: 300 });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("timeout");
    expect(await session.code).toBe(1);
    // The timeout interrupt, its re-armed expiry, then the end-interrupt.
    expect(fakeRecord(session, "interrupts.jsonl")).toHaveLength(2);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("did not end within --turn-timeout");
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(1);
    // Review live22: an end that raised a fatal answers the open turn
    // failed, naming the fatal, never as an orderly interruption.
    expect(completions[0]!.finish).toBe("failed");
    expect(completions[0]!.reason).toContain("did not end within --turn-timeout");
  });

  test("an approval that offers no refusal is never forwarded or answered off-list", async () => {
    // Correctness 7: pickApprovalDecision answered "decline" to a request
    // whose availableDecisions named neither decline nor cancel, after
    // telling the caller deny. Such a request is now answered with a
    // JSON-RPC error, passed through raw, and its turn interrupted.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refusalless go" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(of("permission_request")(session.events)).toBeUndefined();
    expect(of("permission_resolved")(session.events)).toBeUndefined();
    const decisions = await waitForRecord(session, "decisions.jsonl");
    expect(decisions[0]?.id).toBe("appr-norefuse");
    expect(decisions[0]?.error).not.toBeNull();
    expect(decisions[0]?.result).toEqual({});
    await waitForRecord(session, "interrupts.jsonl");
    const notice = session.events.find((event) => event.type === "error");
    expect(notice?.fatal).toBe(false);
    expect(notice?.message).toContain("offered no refusal decision");
    expect(
      session.events.some(
        (event) => event.type === "unknown" && String(event.raw).includes("appr-norefuse")
      )
    ).toBe(true);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - review live18", () => {
  test("a usage update that lands after its turn completed is not charged to the next turn", async () => {
    // Correctness minor: a tokenUsage notification arriving with no turn
    // open accumulated into the next turn's total. It now folds into the
    // session cumulative alone, and its event carries a null turn_id.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:lateusage one" });
    const late = await waitFor(session.events, of("usage"), "late usage");
    expect(late.turn_id).toBeNull();
    const first = session.events.find((event) => event.type === "turn_completed");
    expect(first?.usage.total_tokens).toBeNull();
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.usage.total_tokens).toBe(18979);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(18979 + 1007);
    expect(await session.code).toBe(0);
  });

  test("a nonzero exit after the drained completion costs success", async () => {
    // Sibling of the claude-family correctness 6: a delivered completion
    // excused every nonzero exit, but no exit convention was ever recorded
    // for the app-server. The fake answers the end-interrupt, then exits 1.
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "exit1" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(1);
    expect(of("turn_completed")(session.events)?.finish).toBe("interrupted");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the codex process exited with code 1 during the shutdown drain");
  });
});

describe("codex session e2e - review live20", () => {
  test("a late usage update and delta from the previous turn do not end the session once the next turn is named", async () => {
    // Correctness major 2: a second user line queued behind turn 1 opens
    // turn 2 the moment turn 1 completes. When turn 1's tokenUsage (real
    // codex sends it after turn/completed) arrived after turn 2's id was
    // known, the parser called it a grammar error and the session ended
    // fatally. Stragglers of the closed turn are now accepted, carry no
    // turn id, and their usage folds into the session total only.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:laggard one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "turn_completed t2"
    );
    expect(second.finish).toBe("end");
    expect(second.usage.total_tokens).toBe(18979);
    expect(session.events.find((event) => event.type === "error")).toBeUndefined();
    const straggler = session.events.find((event) => event.type === "assistant_delta" && event.delta === "straggler");
    expect(straggler?.turn_id).toBeNull();
    const lateUsage = session.events.find(
      (event) => event.type === "usage" && event.usage.total_tokens === 2009
    );
    expect(lateUsage?.turn_id).toBeNull();
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(18979 + 2009);
    expect(await session.code).toBe(0);
  });

  test("a decision whose answer cannot be written is rejected, never acked accepted", async () => {
    // Correctness major 3: the refused write started the crash end, which
    // superseded the approval, and the decision was still acked accepted.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "deny" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = session.events.find(
      (event) => event.type.startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
    const resolved = session.events.filter((event) => event.type === "permission_resolved");
    expect(resolved.map((event) => event.resolution)).toEqual(["superseded"]);
  });

  test("a line the session state rejects still goes out raw before the fatal (review live21)", async () => {
    // The codex sibling of the claude-family tier-2 fix: a duplicate
    // approval id was reported but its line never mirrored.
    const session = await startSession();
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "user", text: "scenario:dupask" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("duplicate permission request id");
    const mirrored = session.events.filter(
      (event) => event.type === "unknown" && String(event.raw).includes("cmd-dup-2")
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]!.seq).toBe(fatal!.seq - 1);
  });

  test("a claimed resume the server refuses is not reported resumable (review live21)", async () => {
    // The codex sibling of correctness minor 1: `resumable` followed the
    // claim alone, so a resume the server answered with another thread
    // (FAKE_RESUME_WRONG_THREAD) ended on the crash path still reporting
    // `resumable: true`.
    const threadId = "0123456789abcdef";
    const session = await startSession(
      { resumeThreadId: threadId },
      { FAKE_RESUME_WRONG_THREAD: "1" }
    );
    expect(
      recordSessionStart(session.options.registryPath as string, {
        id: threadId,
        agent: "codex",
        cwd: session.options.cwd,
        hermetic: false,
        harness_home: session.options.harnessHome,
        provider_base_url: null,
        model: null,
        autonomy: "high",
        sandboxed: true,
        sandbox_trust: "standard",
        sandbox_no_net: false,
        sandbox_scrub_env: false,
        pass_env: [],
        playwright_mcp: false,
      }).ok
    ).toBe(true);
    session.driver.adoptResumeClaim();
    expect(await session.code).toBe(1);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    // The claim is still released.
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome === "ok" && read.file.sessions[0]?.ended !== null).toBe(true);
  });

  test("a claimed resume that ends during the handshake releases the claim and stays resumable", async () => {
    // The claude-family sibling of correctness major 1: the CLI claims
    // the record before the spawn, but the driver recorded ownership only
    // at the thread/resume response. An end before it skipped the end
    // stamp and reported resumable false.
    const threadId = "0123456789abcdef";
    const session = await startSession({ resumeThreadId: threadId }, { FAKE_STALL_INIT: "1" });
    expect(
      recordSessionStart(session.options.registryPath as string, {
        id: threadId,
        agent: "codex",
        cwd: session.options.cwd,
        hermetic: false,
        harness_home: session.options.harnessHome,
        provider_base_url: null,
        model: null,
        autonomy: "high",
        sandboxed: true,
        sandbox_trust: "standard",
        sandbox_no_net: false,
        sandbox_scrub_env: false,
        pass_env: [],
        playwright_mcp: false,
      }).ok
    ).toBe(true);
    session.driver.adoptResumeClaim();
    session.driver.handleCallerEnd();
    expect(await session.code).toBe(0);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.resumable).toBe(true);
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome === "ok" && read.file.sessions[0]?.ended !== null).toBe(true);
  });
});

describe("codex session e2e - review live22", () => {
  test("a session ending mid-turn keeps the open turn's reported usage", async () => {
    // Correctness major 1: usage for the open turn collected in turnUsage
    // and folded into the session total only at turn/completed. An end
    // with the turn still open synthesized a completion with all-null
    // usage and left those tokens out of session_ended.usage, though the
    // caller had already seen them as usage events.
    const session = await startAndWait({ turnTimeoutMs: null });
    send(session.driver, { type: "user", text: "scenario:usagewait hold" });
    const reported = await waitFor(session.events, of("usage"), "usage");
    expect(reported.usage.total_tokens).toBe(311);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = of("turn_completed")(session.events);
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.usage.total_tokens).toBe(311);
    expect(ended.usage.total_tokens).toBe(311);
  });

  test("usage reported before a refused turn/start reaches the session total", async () => {
    // Sibling of major 1: failOpenTurn reported the turn's usage on its
    // turn_completed but never folded it into the session total.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:usagefailstart go" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.usage.total_tokens).toBe(413);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(413);
    expect(await session.code).toBe(0);
  });

  test("a turn/start success that names no turn ends the session at once", async () => {
    // Correctness minor 6: the codemux turn was failed but the server's
    // turn could still be running, and the next queued turn/start went to
    // a busy thread. The session now ends on the crash path; with no
    // turn id there is nothing to interrupt, so no grace window is spent
    // waiting for an answer.
    const session = await startAndWait();
    const started = Date.now();
    send(session.driver, { type: "user", text: "scenario:noturnid one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("the turn/start response carries no turn id");
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.finish).toBe("failed");
    expect(fakeRecord(session, "interrupts.jsonl")).toHaveLength(0);
    // Only one turn/start ever reached the server.
    const turnStarts = fakeRecord(session, "requests.jsonl").filter(
      (request) => request.method === "turn/start"
    );
    expect(turnStarts).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a refused timeout interrupt ends the session once, without a re-armed second fatal", async () => {
    // Correctness minor 5 (the codex sibling): the refused write started
    // the crash end, and the timer re-armed anyway; a drain longer than
    // the timeout then raised a false "--turn-timeout" fatal.
    const session = await startAndWait({ turnTimeoutMs: 100 }, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("crash");
    const fatals = session.events.filter((event) => event.type === "error" && event.fatal === true);
    expect(fatals.map((event) => event.message)).toEqual([
      "could not deliver a line to the harness (backlog)",
    ]);
  });
});

describe("codex session e2e - review live22 audit siblings", () => {
  test("a caller-stdin read error during the drain does not fail an orderly end", async () => {
    const session = await startAndWait({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    session.driver.handleCallerEnd(new Error("EIO: i/o error, read"));
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(0);
    const errors = session.events.filter((event) => event.type === "error");
    expect(errors.filter((event) => event.fatal === true)).toHaveLength(0);
    expect(errors.some((event) => String(event.message).includes("EIO"))).toBe(true);
  });
});

describe("codex session e2e - review live23", () => {
  const ackFor = (events: Array<Record<string, any>>, inputSeq: number) =>
    events.find((event) => String(event.type).startsWith("input_") && event.input_seq === inputSeq);

  test("an interrupt whose write is refused is rejected, never acked accepted", async () => {
    // Correctness-2 minor 1: the interrupt was acked before it was
    // written, so a refused write left an accepted ack for an interrupt
    // the harness never got.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "interrupt" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = ackFor(session.events, 2);
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
  });

  test("a steer whose write is refused is rejected and never echoed", async () => {
    // The steer sibling of minor 1: it was acked and echoed as a
    // user_message on the turn before the write was attempted.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "steer", text: "lost" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(1);
    const ack = ackFor(session.events, 2);
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
    expect(
      session.events.some((event) => event.type === "user_message" && event.input_seq === 2)
    ).toBe(false);
  });

  test("a steer the app-server rejects is reported by its input_seq and turn", async () => {
    // Correctness-2 minor 2: the rejection was a bare non-fatal error, so
    // nothing told the caller which acked, echoed steer never arrived.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refusesteer hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    send(session.driver, { type: "steer", text: "too late" });
    const notice = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && String(event.message).includes("rejected the steer")),
      "steer rejection"
    );
    expect(notice.fatal).toBe(false);
    expect(notice.message).toContain("input_seq 2, turn t1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a straggler from two turns back is still late, not a grammar error", async () => {
    // Correctness-2 minor 3: only the last closed turn was remembered, so
    // turn 1's usage arriving once turn 3 was named ended the session.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:laggard2 one" });
    send(session.driver, { type: "user", text: "scenario:basic two" });
    send(session.driver, { type: "user", text: "scenario:basic three" });
    const third = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t3"),
      "turn_completed t3"
    );
    expect(third.finish).toBe("end");
    expect(session.events.filter((event) => event.type === "error")).toEqual([]);
    const lateUsage = session.events.find(
      (event) => event.type === "usage" && event.usage.total_tokens === 2009
    );
    expect(lateUsage?.turn_id).toBeNull();
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage.total_tokens).toBe(2 * 18979 + 2009);
    expect(await session.code).toBe(0);
  });
});

describe("codex session e2e - review live23 contracts", () => {
  test("response-side violations mirror the raw line before the fatal", async () => {
    // Contracts major 1 (second half): an unknown response id, a thread
    // response with a bad id, a turn/start success with no turn id, and a
    // thread/started naming another thread ended with the fatal alone,
    // though design §4.2 mirrors the line wherever a violation is caught.
    const stringId = await startSession({}, { FAKE_STRING_ID_RESPONSE: "1" });
    expect(await stringId.code).toBe(1);
    const idFatal = stringId.events.find((event) => event.type === "error" && event.fatal === true);
    expect(idFatal?.message).toContain("unknown request id 1");
    const idMirror = stringId.events.find((event) => event.seq === idFatal!.seq - 1);
    expect(idMirror?.type).toBe("unknown");
    expect(String(idMirror?.raw)).toContain('"id":"1"');

    const noTurn = await startAndWait();
    send(noTurn.driver, { type: "user", text: "scenario:noturnid hold" });
    expect(await noTurn.code).toBe(1);
    const turnFatal = noTurn.events.find((event) => event.type === "error" && event.fatal === true);
    expect(turnFatal?.message).toContain("carries no turn id");
    const turnMirror = noTurn.events.find((event) => event.seq === turnFatal!.seq - 1);
    expect(turnMirror?.type).toBe("unknown");
    expect(String(turnMirror?.raw)).toContain('"status":"inProgress"');
  });
});

/** Refuse the harness writes `refuse` picks, the way a harness that
 * stopped reading refuses them (the backlog cap); pass the rest through. */
function refuseWrites(proc: SessionProcess, refuse: (line: string) => boolean): void {
  const real = proc.writeLine.bind(proc);
  proc.writeLine = (line: string) => (refuse(line) ? { ok: false, reason: "backlog" } : real(line));
}

describe("codex session e2e - review live23 audit siblings", () => {
  test("a server request whose answer is refused mirrors first and claims no answer", async () => {
    // The answer was written before the raw mirror, so a refused write put
    // the fatal ahead of the line and an "answered with an error" notice
    // after it.
    const session = await startAndWait();
    refuseWrites(session.proc, (line) => line.includes("-32601"));
    send(session.driver, { type: "user", text: "scenario:unknownreq go" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    const mirror = session.events.find(
      (event) => event.type === "unknown" && String(event.raw).includes("fs/readFileText")
    );
    expect(mirror!.seq).toBeLessThan(fatal!.seq);
    expect(
      session.events.some((event) => event.type === "error" && String(event.message).includes("answered with an error"))
    ).toBe(false);
  });

  test("a rejected end-path interrupt stops the grace wait", async () => {
    // The end path's wait had no rejection term, so a refused interrupt
    // held the full grace window before the stop signal.
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:refusehold hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    const started = Date.now();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(Date.now() - started).toBeLessThan(400);
    expect(
      session.events.some((event) => event.type === "error" && String(event.message).includes("rejected the interrupt"))
    ).toBe(true);
  });

  test("an interrupt queued behind turn/start names its input_seq when delivery is refused", async () => {
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "300" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_accepted" && event.input_seq === 2),
      "the ack"
    );
    refuseWrites(session.proc, (line) => line.includes("turn/interrupt"));
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(
      session.events.some(
        (event) => event.type === "error" && String(event.message).includes("(input_seq 2) could not be delivered")
      )
    ).toBe(true);
  });

  test("a steer buffered behind turn/start names its input_seq when delivery is refused", async () => {
    const session = await startAndWait({}, { FAKE_TURNSTART_DELAY: "300" });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "steer", text: "later" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_accepted" && event.input_seq === 2),
      "the ack"
    );
    refuseWrites(session.proc, (line) => line.includes("turn/steer"));
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(
      session.events.some(
        (event) =>
          event.type === "error" &&
          String(event.message).includes("steering input could not be delivered to the harness (input_seq 2)")
      )
    ).toBe(true);
  });

  test("a timeout interrupt that was never written does not label the end's interrupt turn-timeout", async () => {
    const session = await startAndWait({ turnTimeoutMs: 100 });
    // Installed before the turn opens, so the timer cannot win the race.
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes("turn/interrupt")) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.reason).not.toBe("turn-timeout");
  });

  test("a refused turn/start write ends at once, without waiting the grace for its response (review live25)", async () => {
    // Review live25, correctness-2 minor 4: call() registered the
    // turn/start before writing it, so the crash end the refused write
    // started saw a turn/start in flight, queued its interrupt behind the
    // response, and waited the full 500 ms grace for an answer that could
    // not come.
    const session = await startAndWait();
    refuseWrites(session.proc, (line) => line.includes("turn/start"));
    const started = Date.now();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    expect(await session.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(400);
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
  });

  test("an orderly end whose interrupt the app-server will not take exits 1, not 0 (review live25 sibling)", async () => {
    const session = await startAndWait();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("msg-wait")),
      "the turn's first item"
    );
    refuseWrites(session.proc, (line) => line.includes("turn/interrupt"));
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(String(fatal?.message)).toContain("could not deliver the end-path interrupt");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
  });

  test("a refused initialized notification sends no thread request", async () => {
    const attempted: string[] = [];
    const session = await startSession({}, {}, (_driver, proc) => {
      refuseWrites(proc, (line) => {
        attempted.push(line);
        return line.includes("notifications/initialized");
      });
    });
    expect(await session.code).toBe(1);
    expect(attempted.some((line) => line.includes("notifications/initialized"))).toBe(true);
    expect(attempted.some((line) => line.includes("thread/start"))).toBe(false);
  });

  test("an early harness line that ends the session starts no handshake", async () => {
    const attempted: string[] = [];
    const session = await startSession({}, {}, (driver, proc) => {
      refuseWrites(proc, (line) => {
        attempted.push(line);
        return false;
      });
      driver.handleHarnessLine("not json");
    });
    expect(await session.code).toBe(1);
    expect(attempted.some((line) => line.includes('"initialize"'))).toBe(false);
  });
});
