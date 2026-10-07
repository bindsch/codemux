import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSessionDriver, type SessionDriverOptions } from "../src/session/driver.js";
import { SessionProcess } from "../src/session/process.js";
import {
  claimForResume,
  lookupForResume,
  readRegistry,
} from "../src/session/registry.js";
import { buildClaudeSessionCommand } from "../src/session/claude-session.js";
import { acquireLock, resolveRegistryPath } from "../src/session/registry-io.js";
import type { AutonomyLevel } from "../src/types.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));

type Event = Record<string, any>;

interface Session {
  driver: ClaudeSessionDriver;
  proc: SessionProcess;
  events: Event[];
  rawLines: string[];
  code: Promise<number>;
  options: SessionDriverOptions;
  stateDir: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

let root: string | null = null;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-session-e2e-"));
  return root;
}

/** One driver over the fake harness; `overrides` may bend any option and
 * `extraEnv` reaches the fake's environment (scenario switches). */
async function startSession(
  overrides: Partial<SessionDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  harnessArgs?: string[]
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const sessionId = crypto.randomUUID();
  const events: Event[] = [];
  const rawLines: string[] = [];
  const options: SessionDriverOptions = {
    agent: "claude",
    sessionId,
    autonomy: "high",
    cwd: workDir,
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
    registryPath: join(registryDir, "live-sessions.json"),
    harnessHome: join(dir, "home"),
    sink: (line) => {
      rawLines.push(line);
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  const driver = new ClaudeSessionDriver(options);
  // Spawn the fake the way the real builder spawns the harness: the
  // session-id flag is what the driver's grammar check expects it to echo.
  const proc = new SessionProcess({
    command: ["bun", FAKE, ...(harnessArgs ?? ["-p", "--verbose", "--session-id", options.sessionId])],
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
  driver.attach(proc);
  const code = driver.run();
  cleanups.push(async () => {
    driver.dispose();
    proc.requestStop();
    await proc.settled;
  });
  return { driver, proc, events, rawLines, code, options, stateDir };
}

/** What the fake harness recorded, re-read so late appends are visible. */
function fakeRecord(session: Session, name: string): unknown[] {
  const path = join(session.stateDir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** Wait until the fake recorded `count` entries in `name`, re-reading so
 * late appends are visible. Needed wherever the awaited event is emitted
 * by codemux (not the fake): the deny write and the permission_resolved
 * emit are one synchronous step, but the fake records the line only on
 * its own event-loop turn, so a single read races the pipe. */
async function waitForRecord(
  session: Session,
  name: string,
  count = 1,
  timeoutMs = 8_000
): Promise<Event[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = fakeRecord(session, name) as Event[];
    if (records.length >= count) return records;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} record(s) in ${name}; saw ${records.length}`);
    }
    await Bun.sleep(10);
  }
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

const of = (type: string) => (events: Event[]) =>
  events.find((event) => event.type === type);

const send = (driver: ClaudeSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

describe("claude session driver e2e", () => {
  test("full lifecycle: pre-init input opens the first turn, shutdown, registry end", async () => {
    const session = await startSession();
    // The CLI relays caller stdin the moment the harness spawns, so the
    // first user line regularly arrives before system/init: accepting it,
    // echoing it, and opening its turn at the init frame is the driver's
    // job (the fake emits init per turn, as the real wire does).
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(session.options.sessionId);
    expect(started.agent).toBe("claude");
    expect(started.autonomy).toBe("high");
    expect(started.cwd).toBe(session.options.cwd);
    expect(started.protocol).toBe("codemux-live-session/1");
    expect(started.capabilities.user_during_turn).toBe(false);
    // Honest flags on the wire: no steering carrier (a steer line is
    // rejected `unsupported` below), no standalone usage stream.
    expect(started.capabilities.steer).toBe(false);
    expect(started.capabilities.usage_stream).toBe(false);
    // The envelope's key order is fixed and raw is null on codemux events;
    // the echo and its ack precede session_started on this path, so the
    // line is located by the event's own seq.
    expect(session.rawLines[started.seq - 1]).toMatch(
      /^\{"seq":\d+,"ts":"[^"]+","session_id":"[^"]+","type":"session_started","raw":null,/
    );

    const turn = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turn.turn_id).toBe("t1");
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic hello");
    expect(echo.input_seq).toBe(1);
    // Accepted before the session announced itself: the turn was not yet
    // known, so the field is absent (§4.2's `turn_id?` once known).
    expect(echo.turn_id).toBeUndefined();
    expect(
      session.events.map((event) => event.type).indexOf("user_message")
    ).toBeLessThan(session.events.map((event) => event.type).indexOf("session_started"));
    const delta = await waitFor(session.events, of("assistant_delta"), "assistant_delta");
    expect(delta.delta).toBe("Hel");
    expect(typeof delta.raw).toBe("string");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 3,
      total_tokens: 18,
      // No per-turn cost (review live10): the wire's only cost figure is
      // session-lifetime; it rides session_ended below.
      cost_usd: null,
    });

    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(ended.usage.total_tokens).toBe(18);
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);

    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions.find((record) => record.id === started.session_id);
      expect(entry?.ended).not.toBe(null);
    }
  });

  test("a mid-turn user line is rejected busy and never reaches the harness (review live21)", async () => {
    // Contracts major: the driver forwarded a mid-turn line and opened a
    // turn for it at the next result, but print mode folds such a line
    // into the running turn when that turn makes another model request
    // (fixture zai-session-a.ndjson: one result answers both), so the
    // rolled turn waited on a result that never came and every later
    // result answered the turn before it. `user_during_turn` is false
    // now: the line is rejected `busy`, before init as well as after.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait first" });
    // Before init: the first line is forwarded and its turn is pending.
    send(session.driver, { type: "user", text: "scenario:basic early" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    // Mid-turn.
    send(session.driver, { type: "user", text: "scenario:tools second" });
    const rejections = await waitFor(
      session.events,
      (events) => {
        const found = events.filter((event) => event.type === "input_rejected");
        return found.length === 2 ? found : undefined;
      },
      "two busy rejections"
    );
    expect(rejections.map((event: Event) => [event.input_seq, event.reason])).toEqual([
      [2, "busy"],
      [3, "busy"],
    ]);
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    // Idle again: the next line opens t2 at once and its result answers it.
    send(session.driver, { type: "user", text: "scenario:tools second" });
    const second = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(2);
    // The harness saw exactly the two accepted lines.
    const lines = fakeRecord(session, "input-lines.jsonl") as Array<{ text: string }>;
    expect(lines.map((line) => line.text)).toEqual([
      "scenario:wait first",
      "scenario:tools second",
    ]);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a denied edit derives no file_change", async () => {
    // Review live10, correctness 5: the derived change used to fire at
    // the tool_use frame — before the permission round-trip — so a call
    // the caller then denied had already reported its edit. The
    // candidate now waits for the tool's own result: a denied or failed
    // call changed nothing and derives nothing.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:askedit please" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Edit");
    // The tool_use frame is already on the stream: the candidate exists,
    // held back by the driver.
    await waitFor(session.events, of("tool_call"), "tool_call");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "deny",
    });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "the denied tool_result"
    );
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(of("file_change")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("the Write add/edit split reads the workspace at the call, and the change follows the result", async () => {
    // The other half of review live10, correctness 5: the confirming
    // event fires only after the successful tool_result, and a Write's
    // action is the pre-write state of its target — an existing file is
    // an edit, a fresh one an add. The parser cannot know either (it
    // never touches the filesystem); the driver's existsSync at the
    // tool_use frame is what settles it, before the tool runs (it
    // follows symlinks — a dangling link's missing target is an add,
    // review live14).
    const session = await startSession();
    // The target of the second turn's Write pre-exists.
    writeFileSync(join(session.options.cwd, "file.txt"), "old");
    send(session.driver, { type: "user", text: "scenario:write made.txt" });
    await waitFor(session.events, of("session_started"), "session_started");
    const added = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change" && event.action === "add"),
      "the add change"
    );
    expect(added.derived).toBe(true);
    expect(added.path).toBe(join(session.options.cwd, "made.txt"));
    // The confirming result came first: the change is reported when the
    // tool succeeded, never at the tool_use frame.
    expect(
      session.events.map((event) => event.type).indexOf("tool_result")
    ).toBeLessThan(session.events.indexOf(added));
    await waitFor(session.events, of("turn_completed"), "turn_completed");

    send(session.driver, { type: "user", text: "scenario:write file.txt" });
    const edited = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "file_change" && event.action === "edit"),
      "the edit change"
    );
    expect(edited.path).toBe(join(session.options.cwd, "file.txt"));
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a relative Write target resolves against the session cwd, not codemux's own", async () => {
    // Review live15: the add/edit split's existsSync resolved a relative
    // file_path against codemux's process working directory — here the
    // repo root, which does contain a package.json the session's fresh
    // workspace does not. A relative target must resolve against the
    // session cwd the harness runs in: package.json is an add (missing
    // there), and a file that exists only in the session workspace is an
    // edit.
    const session = await startSession();
    writeFileSync(join(session.options.cwd, "session-only.txt"), "old");
    send(session.driver, { type: "user", text: "scenario:write rel:package.json" });
    await waitFor(session.events, of("session_started"), "session_started");
    const added = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "file_change" && event.action === "add" && event.path === "package.json"
        ),
      "the relative add"
    );
    expect(added.derived).toBe(true);
    await waitFor(session.events, of("turn_completed"), "turn_completed");

    send(session.driver, { type: "user", text: "scenario:write rel:session-only.txt" });
    const edited = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "file_change" && event.action === "edit" && event.path === "session-only.txt"
        ),
      "the relative edit"
    );
    expect(edited.path).toBe("session-only.txt");
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("steer is rejected unsupported; the held turn still closes on interrupt", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    // The claude-family capability is honestly false (review live3): the
    // wire has no carrier that shapes the running turn on demand, so a
    // steer line is rejected by name and nothing reaches the harness or
    // opens a turn.
    send(session.driver, { type: "steer", text: "scenario:basic go", author: "alice" });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "steer rejection"
    );
    expect(rejected.reason).toBe("unsupported");
    // The held turn still closes on interrupt; the next line, sent from
    // idle, opens the next turn (a mid-turn `user` is rejected `busy`,
    // review live21).
    send(session.driver, { type: "interrupt" });
    const interrupted = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.finish === "interrupted"),
      "interrupted turn"
    );
    expect(interrupted.turn_id).toBe("t1");
    send(session.driver, { type: "user", text: "scenario:basic go" });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
      "next turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("permission allow round-trips, with updated_input substituted", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask bash please" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Bash");
    expect(request.input).toEqual({ command: "echo hi", description: "say hi" });
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
      updated_input: { command: "echo rewritten" },
    });
    const resolved = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "allow"),
      "permission_resolved allow"
    );
    expect(resolved.request_id).toBe(request.request_id);
    const result = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.output === "allowed:echo rewritten"),
      "tool_result with the substituted command"
    );
    expect(result.is_error).toBe(false);
    // The harness saw the substituted input, not the requested one.
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
      updatedInput: Record<string, unknown> | null;
      message: string | null;
    }>;
    expect(responses[responses.length - 1]).toEqual({
      request_id: "toolu_ask_1",
      behavior: "allow",
      updatedInput: { command: "echo rewritten" },
      message: expect.any(String),
    });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("permission deny round-trips and fails the tool", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ask deny me" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "deny",
    });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "deny"),
      "permission_resolved deny"
    );
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "failed tool_result"
    );
    const responses = fakeRecord(session, "responses.jsonl") as Array<{ behavior: string }>;
    expect(responses[responses.length - 1]?.behavior).toBe("deny");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("an allow above the ceiling is answered deny and rejected as escalation", async () => {
    // Medium grants only scoped edits: Bash is out of reach, so the
    // caller's allow cannot stand (§4.1).
    const session = await startSession({ autonomy: "medium" });
    send(session.driver, { type: "user", text: "scenario:ask escalate" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.autonomy).toBe("medium");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
    });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "autonomy_escalation rejection"
    );
    expect(rejected.input_seq).toBe(2);
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "deny"),
      "deny resolution"
    );
    // The harness saw deny, not the caller's allow.
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "denied tool_result"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("read-only denies every allow at the ceiling", async () => {
    const session = await startSession({ autonomy: "read-only" });
    send(session.driver, { type: "user", text: "scenario:ask ro" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: "toolu_ask_1",
      decision: "allow",
    });
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "autonomy_escalation"),
      "read-only escalation rejection"
    );
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("an unparsable can_use_tool is answered deny, reported, and never fatal", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:badask opaque" });
    await waitFor(session.events, of("session_started"), "session_started");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === false),
      "the non-fatal parse error"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("could not be parsed");
    // The raw frame passes through so the caller can see what was denied.
    const unknown = session.events.find(
      (event) =>
        event.type === "unknown" && typeof event.raw === "string" && event.raw.includes("toolu_bad_1")
    );
    expect(unknown).toBeDefined();
    // No permission ever surfaced, so nothing is pending to time out later.
    expect(of("permission_request")(session.events)).toBeUndefined();
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
    }>;
    expect(responses[responses.length - 1]).toMatchObject({
      request_id: "toolu_bad_1",
      behavior: "deny",
    });
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("an interrupt denies a pending request as superseded and the session continues", async () => {
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask dangerous" });
    await waitFor(session.events, of("session_started"), "session_started");
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "interrupt" });
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution"
    );
    expect(superseded.request_id).toBe(request.request_id);
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live12: the supersede-deny ends the ask's turn CLEANLY — the
    // fake answers the deny synchronously, so the interrupt that follows
    // finds no open turn and is bare-acked (nothing queued). The turn
    // genuinely ended; an interrupt label belongs to the error result an
    // interrupt produces (the wait-scenario tests below), never to a
    // clean completion that raced one.
    expect(completed.finish).toBe("end");
    // The harness saw the deny before the turn closed — keyed by the
    // pending request's id, so the harness never hangs on it.
    const responses = fakeRecord(session, "responses.jsonl") as Array<{
      request_id: string;
      behavior: string;
    }>;
    expect(responses[responses.length - 1]).toMatchObject({
      request_id: "toolu_ask_1",
      behavior: "deny",
    });
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("the turn timeout denies a pending request as superseded too", async () => {
    const session = await startSession({
      permissionTimeoutMs: 300_000,
      turnTimeoutMs: 200,
    });
    send(session.driver, { type: "user", text: "scenario:ask slow" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("permission_request"), "permission_request");
    const superseded = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "superseded"),
      "superseded resolution",
      5_000
    );
    expect(superseded.request_id).toBe("toolu_ask_1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Review live12: same shape as the interrupt test above — the
    // supersede-deny completes the turn cleanly before the timeout's
    // interrupt lands, so the label is the wire's own ("end"; the
    // interrupt missed). The timeout-interrupt labeling itself keeps
    // coverage in the wait variant below.
    expect(completed.finish).toBe("end");
    const responses = fakeRecord(session, "responses.jsonl") as Array<{ behavior: string }>;
    expect(responses[responses.length - 1]?.behavior).toBe("deny");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a stale interrupt is spent on the clean turn it missed; the next turn is not relabeled", async () => {
    // Review live12: the interrupt was written while t1's result was
    // already in flight, and t1 — a clean success — was labeled
    // interrupted. A clean result with an interrupt outstanding ends
    // honestly. Review live21: the missed interrupt is spent with it. The
    // harness reads it idle and drops it, because t2's line is written
    // only after t1's result (a mid-turn `user` is rejected `busy`), so
    // the live12/live20 roll that kept it pending for t2 relabeled a turn
    // the interrupt never reached.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:race one" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_started"), "turn_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "interrupt" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    // An error result on t2 with the interrupted shape and no interrupt
    // behind it: pre-fix the rolled interrupt struck it.
    send(session.driver, { type: "user", text: "scenario:ede two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions.map((event) => [event.turn_id, event.finish])).toEqual([
      ["t1", "end"],
      ["t2", "failed"],
    ]);
    expect(completions[0]!.usage.input_tokens).toBe(11);
    expect(completions[1]!.reason).toBe("error_during_execution");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    // The one caller interrupt, which the harness dropped.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-1"]);
  });

  test("a permission request times out to deny when no decision comes", async () => {
    const session = await startSession({ permissionTimeoutMs: 150 });
    send(session.driver, { type: "user", text: "scenario:ask silence" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("permission_request"), "permission_request");
    const timedOut = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "permission_resolved" && event.resolution === "timeout"),
      "permission_resolved timeout",
      5_000
    );
    expect(timedOut.resolution).toBe("timeout");
    await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "tool_result" && event.is_error === true),
      "denied tool_result after timeout"
    );
    // A late decision for the timed-out request is rejected, not applied.
    send(session.driver, { type: "permission_decision", request_id: "toolu_ask_1", decision: "allow" });
    const late = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "late decision rejection"
    );
    expect(late.input_seq).toBe(2);
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("turn timeout interrupts the turn and the session continues", async () => {
    const session = await startSession({ turnTimeoutMs: 200 });
    send(session.driver, { type: "user", text: "scenario:wait slow turn" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "timed-out turn_completed",
      5_000
    );
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toBe("turn-timeout");
    // The session survives: another turn runs to completion.
    send(session.driver, { type: "user", text: "scenario:basic still alive" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("stdin close ends the session cleanly with exit 0", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait open turn" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.driver.handleCallerEnd();
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(await session.code).toBe(0);
  });

  test("the session timeout ends the session with reason timeout and exit 1", async () => {
    const session = await startSession({ sessionTimeoutMs: 250 });
    send(session.driver, { type: "user", text: "scenario:wait long" });
    const ended = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "session_ended" && event.reason === "timeout"),
      "session_ended timeout",
      5_000
    );
    expect(ended.reason).toBe("timeout");
    expect(await session.code).toBe(1);
  });

  test("a harness crash is a fatal error and exit 1, resumable", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    await waitFor(session.events, of("session_started"), "session_started");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("harness");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(1);
  });

  test("a registry start-write failure ends the session as a codemux failure, not a harness one", async () => {
    // A regular file where the registry's directory chain needs one: the
    // record fails, and §4.8 says an untracked live session must not run.
    // The failure is codemux's (an EPERM'd home behaves the same way) and
    // must never be recast as unusable harness output — the record runs
    // from inside the harness-line handler (found live on 2026-10-05,
    // where a denied ~/Library produced "invalid-utf8" for a valid line).
    const blocker = join(workRoot(), "registry-blocker");
    writeFileSync(blocker, "not a directory");
    const session = await startSession({
      registryPath: join(blocker, "reg", "live-sessions.json"),
    });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("cannot record the session in the registry");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    // The session never started, so nothing was vouchable.
    expect(session.events.some((event) => event.type === "session_started")).toBe(false);
  });

  test("a driver exception on a harness line is a codemux fatal, never unusable harness output", async () => {
    // The class the handler fatal exists for: an unexpected throw while
    // processing a harness line (injected here through the private
    // recordStart — the seam the live EPERM actually threw from) must end
    // the session as codemux's own failure with the real message, and
    // the end path must still run.
    const session = await startSession();
    (session.driver as unknown as { recordStart: () => void }).recordStart = () => {
      throw new Error("driver bug");
    };
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("internal error while processing a harness line");
    expect(error.message).toContain("driver bug");
    expect(error.message).not.toContain("unusable harness output");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a non-JSON harness line is a tier-3 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    await waitFor(session.events, of("session_started"), "session_started");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "tier-3 fatal"
    );
    expect(error.message).toContain("unusable harness output");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a grammar violation preserves the raw event, then ends fatally (tier 2)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wrongsession drift" });
    await waitFor(session.events, of("session_started"), "session_started");
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find((event) => event.type === "unknown" && String(event.raw).includes("wrong session")),
      "unknown passthrough"
    );
    expect(unknown.raw).toContain("wrong session");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "tier-2 fatal"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("session id");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
  });

  test("a second system/init is a tier-1 unknown and the session continues", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:badinit replay" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(session.options.sessionId);
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) => event.type === "unknown" && typeof event.raw === "string" && event.raw.includes("init")
        ),
      "the duplicate init passthrough"
    );
    expect(unknown.session_id).toBe(session.options.sessionId);
    // The turn the duplicate init rode still completes...
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    // ...and the session survives to run another one.
    send(session.driver, { type: "user", text: "scenario:basic still alive" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    expect(
      session.events.find((event) => event.type === "error" && event.fatal)
    ).toBeUndefined();
  });

  test("malformed and unsupported caller lines are rejected, never dropped", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic warm" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "warm-up turn_completed");
    session.driver.handleCallerLine("{not json");
    session.driver.handleCallerLine(JSON.stringify({ type: "mystery" }));
    session.driver.handleCallerLine(JSON.stringify({ type: "user", text: "x", extra: 1 }));
    session.driver.handleCallerLine(
      JSON.stringify({ type: "permission_decision", request_id: "nope", decision: "allow" })
    );
    // Delivery to the sink is queued, so the four rejections are awaited,
    // not assumed present the instant the calls return.
    const rejected = await waitFor(
      session.events,
      (events) =>
        events.filter((event) => event.type === "input_rejected").length >= 4
          ? events.filter((event) => event.type === "input_rejected")
          : undefined,
      "four input_rejected events"
    );
    expect(rejected.map((event) => event.reason)).toEqual([
      "malformed",
      "unknown_type",
      "malformed",
      "unknown_request",
    ]);
    expect(rejected.every((event) => typeof event.input_seq === "number")).toBe(true);
    // An interrupt with no active turn is an acknowledged no-op (the
    // warm-up turn's input was seq 1, the four rejects 2 through 5).
    send(session.driver, { type: "interrupt" });
    const accepted = session.events.find(
      (event) => event.type === "input_accepted" && event.input_seq === 6
    );
    expect(accepted).toBeDefined();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("the registry guards resume: live owner, autonomy reach, agent match", async () => {
    const session = await startSession({ autonomy: "read-only" });
    send(session.driver, { type: "user", text: "scenario:basic warm" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    const probe = {
      agent: "claude",
      harnessHome: session.options.harnessHome,
      autonomy: "read-only" as AutonomyLevel,
      sandboxed: false,
      sandboxTrust: "standard" as const,
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      cwd: session.options.cwd,
      passEnv: [],
      playwrightMcp: false,
      hermetic: false,
    };
    // Live owner: this test process owns the session, recorded unended.
    // Its own pid is never a rival owner (review live25, the
    // recordSessionStart rule), so the busy refusal for a foreign live
    // owner is pinned in tests/session-registry.test.ts.
    const live = readRegistry(session.options.registryPath as string);
    expect(live.outcome).toBe("ok");
    if (live.outcome === "ok") {
      const entry = live.file.sessions.find((candidate) => candidate.id === started.session_id);
      expect(entry?.owner_pid).toBe(process.pid);
      expect(entry?.ended).toBeNull();
    }

    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    await session.code;

    const ok = lookupForResume(session.options.registryPath as string, started.session_id, probe);
    expect(ok.outcome).toBe("ok");
    const narrowed = lookupForResume(session.options.registryPath as string, started.session_id, {
      ...probe,
      autonomy: "low",
    });
    expect(narrowed.outcome).toBe("refused");
    if (narrowed.outcome === "refused") expect(narrowed.reason).toContain("autonomy");
    const crossAgent = lookupForResume(session.options.registryPath as string, started.session_id, {
      ...probe,
      agent: "zai",
    });
    expect(crossAgent.outcome).toBe("refused");
  });

  test("the author prefix rides the harness-bound text, not the echo", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "alice" });
    await waitFor(session.events, of("session_started"), "session_started");
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.author === "alice"),
      "attributed echo"
    );
    expect(echo.text).toBe("scenario:basic hi");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const inputs = fakeRecord(session, "input-lines.jsonl") as Array<{ text: string }>;
    expect(inputs[inputs.length - 1]?.text).toBe("[alice] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("--no-author-prefix leaves the harness text unprefixed", async () => {
    const session = await startSession({ authorPrefix: false });
    send(session.driver, { type: "user", text: "scenario:basic plain", author: "bob" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const inputs = fakeRecord(session, "input-lines.jsonl") as Array<{ text: string }>;
    expect(inputs[inputs.length - 1]?.text).toBe("scenario:basic plain");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("seq stays monotonic across the whole stream", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic seq" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const seqs = session.events.map((event) => event.seq as number);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

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

  test("the sandbox trust is reported and recorded as given", async () => {
    const session = await startSession({ sandboxTrust: "trusted" });
    send(session.driver, { type: "user", text: "scenario:basic trust" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.sandbox_trust).toBe("trusted");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") {
      const entry = read.file.sessions.find((record) => record.id === started.session_id);
      expect(entry?.sandbox_trust).toBe("trusted");
    }
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

  test("the shutdown drain delivers the harness's final output", async () => {
    // Review live5, major 2: handleHarnessLine used to return early on
    // `finished`, so the harness's last frames — the end-interrupt's
    // answer, the interrupted turn's result, its usage — vanished during
    // the grace window: no turn_completed, a null-usage session_ended,
    // exit 0. FAKE_SIGTERM_PERSIST keeps the fake alive past the
    // shutdown SIGTERM the way the real harness survives inside the
    // grace window, so its answer must reach the caller.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    // The drain: the fake answers the end-interrupt and completes the
    // turn while the end path is already running — those events must
    // still reach the caller, before session_ended.
    const completed = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "turn_completed"),
      "drained turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.usage).toEqual({
      input_tokens: 4,
      output_tokens: 2,
      cached_input_tokens: 0,
      total_tokens: 6,
      cost_usd: null, // no per-turn cost (review live10)
    });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    // The fake now exits 1 — the real claude convention for an
    // interrupted turn (step-0 probe 4). Review live9: the child's
    // nonzero exit does NOT cost success here, because the turn's
    // completion was delivered during the drain — this test is the
    // companion regression for that exemption.
    expect(ended.exit_code).toBe(1);
    // The drained result's usage folded into the session cumulative; the
    // cost adopted there (the per-turn event carries none — live10).
    expect(ended.usage).toEqual({
      input_tokens: 4,
      output_tokens: 2,
      cached_input_tokens: 0,
      total_tokens: 6,
      cost_usd: 0.001,
    });
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
    // The interrupt the end path sent was the one the fake answered.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  });

  test("a harness exiting nonzero during the drain with its turn open costs success", async () => {
    // Review live9, correctness 2: finish() resolved with the initiating
    // end's success code and ignored the child's exit — an injected
    // child exiting 42 reproduced driver exit 0 while
    // session_ended.exit_code said 42. The verdict now reads the child:
    // a turn still open at the drain's end (no completion delivered)
    // plus a nonzero exit is a failure, with the error on the stream
    // ahead of session_ended. The exempt cases are pinned beside it: a
    // delivered completion (the drain test above, exit 1 by convention)
    // and a signal death (code null — the normal kill path when the
    // harness ignores the interrupt).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
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
    // Review live12: the failure verdict and the pairing synthesis used to
    // be mutually exclusive — this exit class left `turn_started t1`
    // unpaired, exactly when the fatal fired. The open turn is now
    // answered: a failed completion whose reason mirrors the fatal, after
    // the error and before session_ended.
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
    // The end-interrupt was delivered but died unanswered.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  });

  test("a fatal arriving during the shutdown drain costs success", async () => {
    // Review live7, major 2: once `finish` began, its re-entry guard
    // ignored every later failure call — the driver emitted the tier-3
    // fatal and still exited 0 with reason "shutdown". Cleanup stays
    // idempotent; the verdict does not freeze until the child settles: a
    // fatal line arriving inside the grace window raises the exit code
    // to 1. FAKE_SIGTERM_PERSIST=garbage keeps the fake alive past the
    // shutdown SIGTERM and emits one non-JSON line before dying.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "garbage" });
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

  test("the session cost adopts the harness's running figure, never summing turns", async () => {
    // Review live8, major 1: the result's total_cost_usd is a
    // session-lifetime figure on the real wire (pinned by
    // tests/fixtures/live/zai-session-a.ndjson), so the cumulative used
    // to sum reports that already included the earlier turns — two turns
    // at $0.01 and $0.015 reported $0.025. The fake models the real
    // counter (each result reports the running total), so the session
    // cost must adopt the second turn's figure while the tokens still
    // sum. Review live10, correctness 3: the per-turn events carry no
    // cost at all — mirroring the lifetime figure beside per-turn token
    // counts invited callers to sum overlapping figures (the fixture
    // shows 0.101124 → 0.1066152 → 0.118512 across three turns). The
    // ask/badask results carry no cost, and their keep-semantics are
    // unit-pinned in tests/session-usage.test.ts.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[0],
      "first turn_completed"
    );
    expect(first.usage.cost_usd).toBe(null);
    send(session.driver, { type: "user", text: "scenario:tools two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.usage.cost_usd).toBe(null);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.usage).toEqual({
      input_tokens: 22,
      output_tokens: 8,
      cached_input_tokens: 3,
      total_tokens: 33,
      // The harness's running total after turn 2 — not the $0.005
      // delta, and not a sum of the per-turn events (which carry none).
      cost_usd: 0.015,
    });
    expect(await session.code).toBe(0);
  });

  test("a permission request arriving during the shutdown drain is denied and resolved", async () => {
    // Review live8, major 2: a can_use_tool landing inside the grace
    // window — after finish() denied everything it found pending — used
    // to register with an expiry timer the end path had already cleared
    // (and `finished` short-circuits expiry besides), while the caller's
    // decision channel was already closed: the harness waited on an
    // answer that could never come, stalling the very persistence the
    // grace window exists for. The request is now denied at once with
    // the supersede treatment. FAKE_SIGTERM_PERSIST=ask makes the fake
    // surface the ask from the end-interrupt, which the driver writes
    // inside the end path — deterministically inside the drain.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "ask" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const request = await waitFor(
      session.events,
      of("permission_request"),
      "drain permission_request"
    );
    expect(request.request_id).toBe("toolu_drain_1");
    expect(request.tool).toBe("Bash");
    const resolved = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "permission_resolved" && event.request_id === "toolu_drain_1"
        ),
      "drain permission_resolved"
    );
    expect(resolved.resolution).toBe("superseded");
    // The deny reached the harness, keyed to the request it denied.
    const responses = fakeRecord(session, "responses.jsonl") as Event[];
    const deny = responses.find((entry) => entry.request_id === "toolu_drain_1");
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message)).toContain("the session is ending");
    // The denial does not forfeit the drain: the interrupted turn's
    // completion still arrives, then the end.
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
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // Review live9, contracts: §4.1 and the README promise every input
    // line is acknowledged, but the driver's guard returned before
    // parsing once `finished` flipped, so a line landing inside the
    // grace window vanished unacknowledged — and the documented
    // `shutting_down` reason was unreachable dead code. The drain
    // window (`finished`, not yet `settled`) now answers every line
    // with the rejection. The two sends are synchronous: the CLI keeps
    // relaying caller stdin through the whole grace window, so the
    // second line deterministically lands inside the drain.
    const session = await startSession();
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
    // The line was never echoed or turned: only rejection, then the end.
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(session.events[session.events.length - 1]).toBe(ended);
    expect(await session.code).toBe(0);
  });

  test("a wrapper exiting 143 during the drain is the signal's coded spelling, not a failure", async () => {
    // Review live11: the live9 verdict read any nonzero exit as failure,
    // so a wrapper that answers the shutdown SIGTERM with exit code 143
    // (the scode spelling, 128+SIGTERM) cost success while the signal
    // death it encodes (code null) did not. 143 now exempts itself like
    // the signal, and the still-open turn is synthesized interrupted —
    // the harness never answered the end-interrupt.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:wait held" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(143);
    // No false "during the shutdown drain" fatal.
    expect(of("error")(session.events)).toBeUndefined();
    // The open turn is still answered — synthesized interrupted,
    // codemux-originated, usage never guessed.
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toBe("the session ended (shutdown) before the turn completed");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    expect(await session.code).toBe(0);
    // The end-interrupt was delivered but died unanswered.
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  });

  test("a crash mid-turn reports one fatal and still answers the open turn", async () => {
    // Review live11, minor 5 (the claude sibling): the crash path already
    // told the failure story, but the live9 verdict then added a second,
    // false "during the shutdown drain" fatal for the same exit — and the
    // open turn's turn_started was never answered. The crash end now
    // exempts itself from the drain verdict and the turn is synthesized
    // failed with the crash as its reason.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash boom" });
    await waitFor(session.events, of("session_started"), "session_started");
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
    // usage never guessed.
    const completed = of("turn_completed")(session.events) as Event;
    expect(completed).toBeDefined();
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    // Review live17: the reason is the fatal that ended the session.
    expect(completed.reason).toContain("the claude process exited unexpectedly (code");
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

  test("permissions still pending when the turn completes by itself are superseded", async () => {
    // Review live11, major 2 (the claude sibling): completeTurn never
    // closed the permission channel, so a can_use_tool that lost its
    // race with the turn's own result stayed pending — a later decision
    // was acked accepted for a request the harness no longer held, while
    // the expiry timer waited to write a stray deny into whatever turn
    // ran next. The completion now supersedes it: denied on the wire,
    // resolved "superseded" to the caller, and a later decision for it
    // is unknown_request.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:asklose race" });
    const request = await waitFor(
      session.events,
      of("permission_request"),
      "permission_request"
    );
    expect(request.request_id).toBe("toolu_lose_1");
    // The harness completes the turn by itself while the decision is out.
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const superseded = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "permission_resolved" && event.resolution === "superseded"
        ),
      "superseded resolution"
    );
    expect(superseded.request_id).toBe("toolu_lose_1");
    // The deny reached the harness, keyed to the lost request, with the
    // completion as its stated reason. Polled, not read once: the emit
    // above is codemux's, so the fake's record follows a pipe turn later.
    const responses = await waitForRecord(session, "responses.jsonl");
    const deny = responses.find((entry) => entry.request_id === "toolu_lose_1");
    expect(deny?.behavior).toBe("deny");
    expect(String(deny?.message)).toContain("the turn completed before the decision");
    // The session survives and a second turn runs clean.
    send(session.driver, { type: "user", text: "scenario:basic after" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    // A decision for the dead request is rejected, not applied — and no
    // second deny ever reaches the harness for it.
    send(session.driver, {
      type: "permission_decision",
      request_id: "toolu_lose_1",
      decision: "allow",
    });
    const rejected = await waitFor(
      session.events,
      (events) =>
        events.find((event) => event.type === "input_rejected" && event.reason === "unknown_request"),
      "the unknown_request rejection"
    );
    expect(rejected.input_seq).toBe(3);
    expect(
      (fakeRecord(session, "responses.jsonl") as Event[]).filter(
        (entry) => entry.request_id === "toolu_lose_1"
      )
    ).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the turn-path registry stamp never waits behind another writer, and says so once (review live13)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Hold the writer lock the way a concurrent codemux registry write
    // would: this (live) process's own held file.
    const lockPath = `${resolveRegistryPath(session.options.registryPath as string)}.lock`;
    const handle = acquireLock(lockPath, { attempts: 1 });
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const began = Date.now();
      send(session.driver, { type: "user", text: "scenario:basic again" });
      const second = await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[1],
        "second turn_completed under a held registry lock"
      );
      expect(second.finish).toBe("end");
      // Pre-fix, this one turn's stamp waited out the lock's full budget
      // (~10 s of synchronous Atomics.wait with the event loop — stdout
      // reads, caller events, signal handlers — frozen) before failing.
      expect(Date.now() - began).toBeLessThan(5_000);
    } finally {
      console.error = original;
      handle.release();
    }
    // The failed stamp is reported, once for the session, not per turn.
    const stamps = lines.filter((line) => line.includes("cannot stamp the session registry"));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toContain(session.options.sessionId);
    expect(lines.filter((line) => line.includes("cannot stamp the session end"))).toHaveLength(0);
    // The end stamp keeps the full lock budget, and the lock is free
    // again: the session ends clean and the registry stays readable.
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    expect(readRegistry(session.options.registryPath as string).outcome).toBe("ok");
  });

  test("a lost end stamp reports on stderr instead of vanishing (review live13)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // Break the registry so the end stamp must fail: a mode other than
    // 0600 makes every read untrusted (the fail-closed placement check).
    chmodSync(session.options.registryPath as string, 0o644);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      send(session.driver, { type: "shutdown" });
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(ended.reason).toBe("shutdown");
      expect(await session.code).toBe(0);
    } finally {
      console.error = original;
    }
    // The stamp's loss is the one consequence the caller cannot see in
    // the event stream (a later resume may answer session_busy because
    // the record still names a live owner), so it rides stderr — the
    // pre-fix code swallowed the outcome and said nothing.
    const stamps = lines.filter((line) => line.includes("cannot stamp the session end"));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toContain(session.options.sessionId);
    expect(stamps[0]).toContain("session_busy");
  });
  test("a claimed resume that times out before its init frame is not resumable (review live21)", async () => {
    // The lifecycle sibling of correctness minor 1: a resume the harness
    // never confirmed is resumable only when its end did not fail. A
    // harness that hangs before init until --session-timeout ends with
    // exit 1 and proves nothing about the transcript.
    const session = await startSession({ sessionTimeoutMs: 200 });
    session.driver.adoptResumeClaim();
    expect(await session.code).toBe(1);
    const ended = session.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
    expect(ended.resumable).toBe(false);
  });

  test("a line the session state rejects still goes out raw before the fatal (review live21)", async () => {
    // Tier 2 keeps the raw event (§4.2). The FSM-rejected lines — a
    // duplicate permission request id here, a refused resume's early
    // result in the CLI test — were reported but never mirrored.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:dupask" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe("duplicate permission request id toolu_dup_1");
    const mirrored = session.events.filter(
      (event) => event.type === "unknown" && String(event.raw).includes("echo two")
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]!.seq).toBe(fatal!.seq - 1);
  });

  test("a forwarded pre-init input the harness runs during the drain is mirrored, not fatal (review live16)", async () => {
    // Review live16, correctness major: a user line accepted before the
    // init frame is forwarded at once, so a shutdown cannot drop it. The
    // shutdown here lands before any harness line; the fake keeps running
    // after the SIGTERM, runs the line, and emits its result
    // while no turn is open. Pre-fix that result hit an idle FSM, raised
    // a fatal, and turned a clean shutdown into exit 1 while the caller
    // was told the input dropped. (Mid-turn lines are rejected `busy`
    // since review live21, so the pre-init line is the one forwarded
    // input that can lack a turn.)
    // exit143: the fake survives the SIGTERM for 300 ms, then exits the
    // way a signal-killed wrapper reports (no interrupted turn exists to
    // carry the exit-1 convention).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    // The fake must be up (its SIGTERM survival installed) before the
    // shutdown, or the signal kills it before it reads the line.
    await waitForRecord(session, "argv.jsonl", 1);
    await Bun.sleep(100);
    send(session.driver, { type: "user", text: "scenario:basic early" });
    send(session.driver, { type: "shutdown" });

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(0);
    const errors = session.events.filter((event) => event.type === "error");
    expect(errors.filter((event) => event.fatal === true)).toHaveLength(0);
    // The notice says the harness may still run it, never that it dropped.
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.message)).toContain("may still run it");
    // No turn opened during the drain; the line's result is mirrored.
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    const mirrored = session.events.filter(
      (event) => event.type === "unknown" && String(event.raw).includes('"type":"result"')
    );
    expect(mirrored).toHaveLength(1);
    // Review live22 (audit sibling of the codex usage loss): the mirrored
    // result's usage reaches the session total; it used to be dropped.
    const mirroredUsage = JSON.parse(String(mirrored[0]!.raw)).usage;
    expect(ended.usage.input_tokens).not.toBeNull();
    expect(ended.usage.output_tokens).toBe(mirroredUsage.output_tokens);
  });
});

describe("claude session driver e2e - review live17", () => {
  test("the end-interrupt is answered before the stop signal", async () => {
    // Correctness 3: finish wrote the end-interrupt and sent SIGTERM in
    // the same synchronous step, so a harness that dies on SIGTERM (the
    // default fake, and claude itself in the live16 check) never answered
    // it: the turn was the synthesized `interrupted` with null usage. The
    // interrupt now gets the grace before any signal, so the turn closes
    // through its own drained result.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed).toBeDefined();
    expect(completed!.finish).toBe("interrupted");
    expect(completed!.raw).not.toBeNull();
    expect(completed!.usage.input_tokens).not.toBeNull();
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(0);
  });

  test("a nonzero exit during an idle shutdown costs success", async () => {
    // Correctness 4: the drain verdict required a turn open at finish, so
    // a harness that failed while persisting after an idle `shutdown`
    // exited 1 with codemux reporting 0 and no error. The idle exit now
    // counts the same way; there is no turn to synthesize.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit42" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(42);
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toBe(
      "the claude process exited with code 42 during the shutdown drain"
    );
    expect(session.events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  });

  test("a caller stdin read error ends the session as a failure", async () => {
    // Correctness 2: a read error ran the clean-close handler and exited
    // 0. The driver now reports it fatal and costs success.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    session.driver.handleCallerEnd(new Error("EIO: i/o error, read"));
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.source).toBe("codemux");
    expect(fatal?.message).toContain("reading the caller's stdin failed (EIO: i/o error, read)");
  });

  test("--turn-timeout re-arms, and a turn that ignores its interrupt ends the session", async () => {
    // Correctness 5: the timer fired once and never re-armed, so a turn
    // whose interrupt was refused or ignored ran uncapped. The first
    // expiry interrupts; the second ends the session (reason timeout,
    // exit 1) with the open turn answered.
    const session = await startSession({ turnTimeoutMs: 300 });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("timeout");
    expect(await session.code).toBe(1);
    const interrupts = fakeRecord(session, "interrupts.jsonl");
    // One timeout interrupt, then the end-interrupt.
    expect(interrupts).toHaveLength(2);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("did not end within --turn-timeout");
    const completed = session.events.find((event) => event.type === "turn_completed");
    // Review live22: the end raised a fatal, so the synthesized answer is
    // a failure naming it, not an orderly interruption.
    expect(completed?.finish).toBe("failed");
    expect(completed?.reason).toContain("did not end within --turn-timeout");
  });

  test("a harness that stops reading stdin ends the session at the backlog bound (review live19)", async () => {
    // The class of the codex pre-handshake buffer: Bun buffered every
    // line the harness had not read, so a caller writing into a harness
    // that stopped reading grew codemux's memory without limit. Past
    // 64 MiB unread the process layer refuses the write (pinned in
    // session-process.test.ts), and the driver ends the session with a
    // codemux fatal. Since review live21 a mid-turn `user` line is
    // rejected `busy`, so the caller's lines into a running claude turn
    // are small control lines; the refusal is injected at the process
    // seam and carried by an interrupt.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:nostdin hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "interrupt" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("could not deliver a line to the harness (backlog)");
  }, 30_000);

  test("a plain allow carries the request's own input as updatedInput (review live18)", async () => {
    // Correctness 1: an allow without `updated_input` reached the harness
    // as {behavior, message} only. The harness runs the tool with the
    // answer's updatedInput (the recorded zai-permission3 allow carries
    // the full input), so the plain allow now sends the request's input.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask plain" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const responses = (await waitForRecord(session, "responses.jsonl")) as Array<{
      behavior: string;
      updatedInput: Record<string, unknown> | null;
    }>;
    expect(responses[0]?.behavior).toBe("allow");
    expect(responses[0]?.updatedInput).toEqual({ command: "echo hi", description: "say hi" });
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an unimplemented control request is answered with an error, not left hanging (review live18)", async () => {
    // Correctness 5: a control_request other than can_use_tool passed
    // through as unknown and got no reply, so the harness blocked until
    // --turn-timeout or the end. It is now answered with the control
    // protocol's error response, mirrored raw, and reported non-fatal.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ctlreq go" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const answers = (await waitForRecord(session, "control-errors.jsonl")) as Event[];
    expect(answers[0]?.request_id).toBe("ctl_1");
    expect(answers[0]?.error).toContain("hook_callback");
    const mirrored = session.events.find(
      (event) => event.type === "unknown" && String(event.raw).includes("hook_callback")
    );
    expect(mirrored).toBeDefined();
    const warning = session.events.find((event) => event.type === "error");
    expect(warning?.fatal).toBe(false);
    expect(warning?.message).toContain("hook_callback");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an interrupt sent before init is delivered once the forwarded turn opens (review live18)", async () => {
    // Correctness 4: the user line was forwarded at once, but the
    // interrupt that followed it before system/init found no active turn
    // and was an acknowledged no-op, so the turn ran to completion.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(session.events.filter((event) => event.type === "input_accepted")).toHaveLength(2);
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-1"]);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("only exit 1 after an interrupted drained turn is excused (review live18)", async () => {
    // Correctness 6: any drained completion excused every nonzero exit.
    // The convention is exit 1 after an INTERRUPTED turn; exit 1 after a
    // clean completion, and exit 2 after an interrupted one, both cost
    // success now.
    const clean = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(clean.driver, { type: "user", text: "scenario:race go" });
    await waitFor(clean.events, of("assistant_message"), "assistant_message");
    send(clean.driver, { type: "shutdown" });
    const cleanEnded = await waitFor(clean.events, of("session_ended"), "session_ended");
    expect(cleanEnded.exit_code).toBe(1);
    expect(of("turn_completed")(clean.events)?.finish).toBe("end");
    expect(await clean.code).toBe(1);
    expect(clean.events.find((event) => event.type === "error" && event.fatal)?.message).toBe(
      "the claude process exited with code 1 during the shutdown drain"
    );

    const two = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit2" });
    send(two.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(two.events, of("assistant_message"), "assistant_message");
    send(two.driver, { type: "shutdown" });
    const twoEnded = await waitFor(two.events, of("session_ended"), "session_ended");
    expect(twoEnded.exit_code).toBe(2);
    expect(of("turn_completed")(two.events)?.finish).toBe("interrupted");
    expect(await two.code).toBe(1);
  });

  test("an allow whose frame cannot fit is rejected before the ack and stays pending (review live18)", async () => {
    // Minor: the allow frame's size was never checked, so an
    // updated_input near the line cap was acked accepted and then refused
    // by the write, crashing the session.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask big" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    send(session.driver, {
      type: "permission_decision",
      request_id: request.request_id,
      decision: "allow",
      updated_input: { command: "x".repeat(17 * 1024 * 1024) },
    });
    const rejected = await waitFor(session.events, of("input_rejected"), "input_rejected");
    expect(rejected.reason).toBe("text_too_long");
    expect(session.events.find((event) => event.type === "permission_resolved")).toBeUndefined();
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "deny" });
    const resolved = await waitFor(session.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a stdin error after session_ended adds no event after it (review live18)", async () => {
    // Minor: handleCallerEnd had no settled guard, so a read error during
    // the final flush emitted an error event after session_ended.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const count = session.events.length;
    session.driver.handleCallerEnd(new Error("EIO: late"));
    await Bun.sleep(50);
    expect(session.events).toHaveLength(count);
    expect(session.events[count - 1]?.type).toBe("session_ended");
  });
});

describe("claude session driver e2e - review live20", () => {
  test("an interrupt that missed its turn does not relabel the next turn's API failure", async () => {
    // Correctness minor 4: the missed interrupt rolls to the next turn,
    // and any error result there was labeled interrupted. A harness with
    // no turn to interrupt drops the request, so only an error result of
    // the interrupted shape (error_during_execution) is the interrupt
    // striking; an API error (is_error under subtype success) fails.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:race one" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "interrupt" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:apierror two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "both turn_completed"
    );
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions.map((event) => [event.turn_id, event.finish])).toEqual([
      ["t1", "end"],
      ["t2", "failed"],
    ]);
    expect(completions[1]!.reason).toBe("success");
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
  });

  test("a decision whose answer cannot be written is rejected, never acked accepted", async () => {
    // The codex correctness major 3, on the claude family: the refused
    // write started the crash end, which superseded the request, and the
    // decision was still acked accepted.
    const session = await startSession({ permissionTimeoutMs: 60_000 });
    send(session.driver, { type: "user", text: "scenario:ask plain" });
    const request = await waitFor(session.events, of("permission_request"), "permission_request");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
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

  test("a session created at high and resumed read-only enforces read-only's ceiling", async () => {
    // Contracts minor 2: design §4.6 names this behavioral pin next to
    // the argv assert in session-claude.test.ts. A high session runs a
    // turn and ends; the resume is claimed at read-only, the harness gets
    // the real resume argv, and an allow for Bash is refused by the
    // read-only ceiling, which writes the deny itself.
    const created = await startSession({ autonomy: "high" });
    send(created.driver, { type: "user", text: "scenario:basic hi" });
    await waitFor(created.events, of("turn_completed"), "turn_completed");
    send(created.driver, { type: "shutdown" });
    expect(await created.code).toBe(0);
    expect(of("session_ended")(created.events)?.resumable).toBe(true);

    const id = created.options.sessionId;
    const registryPath = created.options.registryPath as string;
    const claim = claimForResume(registryPath, id, {
      agent: "claude",
      harnessHome: created.options.harnessHome,
      cwd: created.options.cwd,
      passEnv: [],
      playwrightMcp: false,
      autonomy: "read-only",
      sandboxed: false,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      hermetic: false,
    });
    expect(claim.outcome).toBe("ok");
    const argv = buildClaudeSessionCommand({
      agent: "claude",
      resumeId: id,
      autonomy: "read-only",
      cwd: created.options.cwd,
    }).argv;
    const resumed = await startSession(
      {
        sessionId: id,
        autonomy: "read-only",
        cwd: created.options.cwd,
        registryPath,
        harnessHome: created.options.harnessHome,
        permissionTimeoutMs: 60_000,
      },
      {},
      argv.slice(1)
    );
    resumed.driver.adoptResumeClaim();
    send(resumed.driver, { type: "user", text: "scenario:ask run it" });
    const request = await waitFor(resumed.events, of("permission_request"), "permission_request");
    expect(request.tool).toBe("Bash");
    send(resumed.driver, { type: "permission_decision", request_id: request.request_id, decision: "allow" });
    const rejected = await waitFor(resumed.events, of("input_rejected"), "input_rejected");
    expect(rejected.reason).toBe("autonomy_escalation");
    const resolved = await waitFor(resumed.events, of("permission_resolved"), "permission_resolved");
    expect(resolved.resolution).toBe("deny");
    await waitFor(resumed.events, of("turn_completed"), "turn_completed");
    const responses = (await waitForRecord(resumed, "responses.jsonl")) as Array<{ behavior: string }>;
    expect(responses.map((response) => response.behavior)).toEqual(["deny"]);
    const spawned = fakeRecord(resumed, "argv.jsonl") as Array<{ args: string[] }>;
    expect(spawned[0]?.args).toEqual(argv.slice(1));
    expect(spawned[0]?.args.join(" ")).not.toContain("--allowedTools");
    send(resumed.driver, { type: "shutdown" });
    expect(await resumed.code).toBe(0);
    expect(of("session_ended")(resumed.events)?.resumable).toBe(true);
  });
});

describe("claude session driver e2e - review live22", () => {
  test("a refused timeout interrupt ends the session once, without a re-armed second fatal", async () => {
    // Correctness minor 5: the refused interrupt write started the crash
    // end, which cleared the timers, and the callback then re-armed the
    // turn timer with no check on `finished`. A drain longer than the
    // timeout (here the fake survives SIGTERM for 300 ms) raised a second,
    // false "--turn-timeout" fatal.
    const session = await startSession({ turnTimeoutMs: 100 }, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const fatals = session.events.filter((event) => event.type === "error" && event.fatal === true);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]!.message).toContain("could not deliver a line to the harness (backlog)");
  }, 30_000);
});

describe("claude session driver e2e - review live22 audit siblings", () => {
  test("a refused interrupt is cleared: the turn's own API error stays failed", async () => {
    // Every control_response fell through to `unknown`, so an interrupt
    // the harness refused stayed pending and labeled the turn's next
    // error result `interrupted`. The codex driver already cleared it.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:refuseint hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "interrupt" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    const notice = session.events.find(
      (event) => event.type === "error" && String(event.message).includes("rejected the interrupt")
    );
    expect(notice?.fatal).toBe(false);
    expect(
      session.events.some(
        (event) => event.type === "unknown" && String(event.raw).includes("cannot interrupt now")
      )
    ).toBe(true);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a caller-stdin read error during the drain does not fail an orderly end", async () => {
    // handleCallerEnd guarded on `settled`, not `finished`: an error on
    // stdin after an acked shutdown added a fatal and turned exit 0 into
    // exit 1, though the session no longer reads stdin.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
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

describe("claude session driver e2e - review live23", () => {
  test("a refused end-path interrupt is cleared: the turn stays failed and the drain exit 1 counts", async () => {
    // Contracts major 1: the refusal matched only the caller spelling
    // `interrupt-N`, so the end path's `interrupt-end-N` stayed pending.
    // The turn's own error result was labeled `interrupted`, which
    // excused the child's exit 1, and the session ended 0.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:refuseint hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
    const notice = session.events.find(
      (event) => event.type === "error" && String(event.message).includes("rejected the interrupt")
    );
    expect(notice?.fatal).toBe(false);
    expect(ended.reason).toBe("shutdown");
    expect(await session.code).toBe(1);
  }, 30_000);
});

describe("claude session driver e2e - review live23 siblings", () => {
  test("an interrupt whose write is refused is rejected, never acked accepted", async () => {
    // The claude-family sibling of correctness-2 minor 1 (codex): the
    // interrupt was acked first, and the refused write also left it
    // pending, so the crash end could label a drained error result
    // interrupted.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:deaf hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    session.proc.writeLine = () => ({ ok: false, reason: "backlog" });
    send(session.driver, { type: "interrupt" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(ended.reason).toBe("crash");
    expect(await session.code).toBe(1);
    const ack = session.events.find(
      (event) => String(event.type).startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    expect(ack?.reason).toBe("shutting_down");
  }, 30_000);
});

describe("claude fake fidelity - review live23", () => {
  test("the fake's interrupt answer has the recorded wire's shape", async () => {
    // Contracts minor 8: the fake's interrupt echo carried an inner
    // `subtype: "success"` the recorded wire never has, so a byte-level
    // pin against the fake would have validated a shape the harness
    // never sends.
    const recorded = readFileSync(
      fileURLToPath(new URL("./fixtures/live/zai-session-a.ndjson", import.meta.url)),
      "utf8"
    )
      .split("\n")
      .filter((line) => line.includes("still_queued"))
      .map((line) => JSON.parse(JSON.parse(line).line).response.response);
    expect(recorded.length).toBeGreaterThan(0);
    const shapeOf = (value: Record<string, unknown>) => Object.keys(value).sort();
    for (const scenario of ["wait", "deaf"]) {
      const session = await startSession();
      send(session.driver, { type: "user", text: `scenario:${scenario} hold` });
      await waitFor(session.events, of("assistant_message"), "assistant_message");
      send(session.driver, { type: "interrupt" });
      const answer = await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "unknown" && String(event.raw).includes("still_queued")),
        "interrupt answer"
      );
      expect(shapeOf(JSON.parse(answer.raw).response.response)).toEqual(shapeOf(recorded[0]));
      send(session.driver, { type: "shutdown" });
      await session.code;
    }
  }, 30_000);
});

/** Refuse the harness writes `refuse` picks, the way a harness that
 * stopped reading refuses them (the backlog cap); pass the rest through. */
function refuseWrites(proc: SessionProcess, refuse: (line: string) => boolean): void {
  const real = proc.writeLine.bind(proc);
  proc.writeLine = (line: string) => (refuse(line) ? { ok: false, reason: "backlog" } : real(line));
}

describe("claude session driver e2e - review live25", () => {
  test("an orderly end whose interrupt the harness will not take exits 1, not 0", async () => {
    // Review live25, correctness-2 minor 5: a harness that stopped reading
    // stdin refused the end-path interrupt silently, died by SIGTERM (code
    // null, so no drain failure), and the synthesized "interrupted" turn
    // let the shutdown end 0.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("assistant_message"), "assistant_message");
    refuseWrites(session.proc, (line) => line.includes('"interrupt"'));
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(String(fatal?.message)).toContain("could not deliver the end-path interrupt");
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("failed");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  }, 30_000);
});

describe("claude session driver e2e - review live23 audit siblings", () => {
  test("a control request whose answer is refused mirrors first and claims no answer", async () => {
    const session = await startSession();
    refuseWrites(session.proc, (line) => line.includes("does not implement"));
    send(session.driver, { type: "user", text: "scenario:ctlreq go" });
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    const mirror = session.events.find(
      (event) => event.type === "unknown" && String(event.raw).includes("hook_callback")
    );
    expect(mirror!.seq).toBeLessThan(fatal!.seq);
    expect(
      session.events.some((event) => event.type === "error" && String(event.message).includes("answered with an error"))
    ).toBe(false);
  }, 30_000);

  test("a caller interrupt after a refused supersede writes no second interrupt", async () => {
    // The refused deny started the crash end, which wrote its own
    // interrupt; the handler then wrote another and overwrote the id a
    // refusal is matched against.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:ask go" });
    await waitFor(session.events, of("permission_request"), "permission_request");
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes('"deny"')) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "interrupt" });
    await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    const ack = session.events.find(
      (event) => String(event.type).startsWith("input_") && event.input_seq === 2
    );
    expect(ack?.type).toBe("input_rejected");
    await Bun.sleep(100);
    const interrupts = fakeRecord(session, "interrupts.jsonl") as Event[];
    expect(interrupts.map((entry) => entry.request_id)).toEqual(["interrupt-end-1"]);
  }, 30_000);

  test("a timeout interrupt that was never written does not label the end's interrupt turn-timeout", async () => {
    const session = await startSession({ turnTimeoutMs: 100 });
    // Installed before the turn opens, so the timer cannot win the race.
    let refused = false;
    refuseWrites(session.proc, (line) => {
      if (refused || !line.includes('"interrupt"')) return false;
      refused = true;
      return true;
    });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    const completed = session.events.find((event) => event.type === "turn_completed");
    expect(completed?.finish).toBe("interrupted");
    expect(completed?.reason).not.toBe("turn-timeout");
  }, 30_000);

  test("an interrupt held for init names its input_seq when delivery is refused", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    send(session.driver, { type: "interrupt" });
    refuseWrites(session.proc, (line) => line.includes('"interrupt"'));
    await waitFor(session.events, of("session_ended"), "session_ended", 8_000);
    expect(
      session.events.some(
        (event) => event.type === "error" && String(event.message).includes("(input_seq 2) could not be delivered")
      )
    ).toBe(true);
  }, 30_000);
});
