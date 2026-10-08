/**
 * Driver e2e tests for the opencode session (design §4.7, plan step 8):
 * the real OpenCodeSessionDriver over the scenario-driven fake
 * `opencode run --format json` (tests/fixtures/live/fake-opencode-run.ts),
 * whose wire shapes are pinned against the installed 1.18.18 binary. The
 * session is turn-per-process — the driver's spawnTurn closure spawns one
 * fake per caller input — so every round-trip is live: the deferred
 * identity model (session_started waits for the first run-output line's
 * session id), the prompt-on-stdin wire, --session resume, the honest-false
 * input rejections, the exit-code turn verdicts, and the three tiers' end
 * paths including the shutdown drain.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenCodeSessionDriver,
  type OpenCodeDriverOptions,
} from "../src/session/opencode-driver.js";
import { SessionProcess } from "../src/session/process.js";
import { readRegistry } from "../src/session/registry.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-opencode-run.ts", import.meta.url));

type Event = Record<string, any>;

interface Session {
  driver: OpenCodeSessionDriver;
  events: Event[];
  code: Promise<number>;
  options: OpenCodeDriverOptions;
  stateDir: string;
  workDir: string;
  /** Lifecycle milestones from the turn children and the session's done
   * promise, in the order they happened ("spawned", "settled", "done"). */
  order: string[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups) await clean();
});

let root: string | null = null;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-opencode-e2e-"));
  return root;
}

/** One driver whose spawnTurn spawns the fake per turn, exactly the way
 * the CLI's closure spawns one `opencode run` per caller input. A nonzero
 * spawnDelayMs holds the spawn in flight first — the review D5 late-child
 * window, where the end path begins while the turn's process has not
 * landed yet. */
async function startSession(
  overrides: Partial<OpenCodeDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  spawnDelayMs = 0
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const events: Event[] = [];
  const order: string[] = [];
  let driver!: OpenCodeSessionDriver;
  const procs: SessionProcess[] = [];
  const options: OpenCodeDriverOptions = {
    resumeSessionId: null,
    autonomy: "high",
    cwd: workDir,
    hermetic: false,
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
    spawnTurn: async (argv) => {
      if (spawnDelayMs > 0) await Bun.sleep(spawnDelayMs);
      // The fake replaces the binary name and keeps every flag, so the
      // recorded argv is the argv the driver built.
      const proc = new SessionProcess({
        command: ["bun", FAKE, ...argv.slice(1)],
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
      procs.push(proc);
      order.push("spawned");
      void proc.settled.then(() => order.push("settled"));
      return proc;
    },
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  driver = new OpenCodeSessionDriver(options);
  const code = driver.run();
  void code.then(() => order.push("done"));
  cleanups.push(async () => {
    driver.dispose();
    for (const proc of procs) {
      proc.requestStop();
      await proc.settled;
    }
  });
  return { driver, events, code, options, stateDir, workDir, order };
}

/** What the fake recorded, re-read so late appends are visible. */
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

const send = (driver: OpenCodeSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

describe("opencode session e2e - lifecycle", () => {
  test("a fresh session runs a two-turn exchange with the identity deferred to the first line", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });

    // Before the first run-output line, the session does not exist yet:
    // the input is answered and echoed with an empty session id, and the
    // turn opens codemux-side.
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic one");
    expect(echo.turn_id).toBe("t1");
    expect(echo.session_id).toBe("");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    expect(turnStarted.raw).toBeNull();

    // The first line of output adopts the native session id.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.agent).toBe("opencode");
    expect(started.session_id).toBe("ses_fake1234567890");
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
    expect(message.session_id).toBe("ses_fake1234567890");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    // usage_stream: false means usage rides ONLY the per-turn completion;
    // no standalone usage event may appear.
    expect(of("usage")(session.events)).toBeUndefined();
    expect(completed.finish).toBe("end");
    expect(completed.turn_id).toBe("t1");
    expect(completed.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 50,
      total_tokens: 120,
      cost_usd: 0.01,
    });
    // Identity ordering: turn_started precedes session_started, and the
    // turn's mapped events follow it.
    const order = session.events.map((event) => event.type);
    expect(order.indexOf("session_started")).toBeGreaterThan(order.indexOf("turn_started"));
    expect(order.indexOf("session_started")).toBeLessThan(order.indexOf("assistant_message"));

    // The prompt reached the process as raw stdin text, and the fresh
    // turn's argv carried no --session while the second turn resumes the
    // native id the first adopted.
    const prompts = fakeRecord(session, "prompts.jsonl");
    expect(prompts[0]!.text).toBe("scenario:basic one");
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs[0]!.args).toEqual([
      "--pure",
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "--auto",
    ]);

    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");
    const argvsAfter = fakeRecord(session, "argv.jsonl");
    expect(argvsAfter[1]!.args[argvsAfter[1]!.args.indexOf("--session") + 1]).toBe(
      "ses_fake1234567890"
    );

    send(session.driver, { type: "shutdown" });
    const code = await session.code;
    expect(code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    // Two identical turns under the cumulative rules (a plain addUsage
    // sum, review D2 contracts 2): the token parts sum, total_tokens is
    // recomputed by the input+cached+output identity, and cost SUMS the
    // per-turn figures — each step_finish part's cost is that step's own
    // (the binary runs `assistantMessage.cost += step.cost`), never a
    // session-lifetime figure to adopt.
    expect(ended.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cached_input_tokens: 100,
      total_tokens: 340,
      cost_usd: 0.02,
    });

    // The registry recorded the session under the native id (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "ses_fake1234567890")
        : undefined;
    expect(entry?.agent).toBe("opencode");
    expect(entry?.ended).not.toBe(null);
  });

  test("a resumed session adopts its id at run start and resumes by --session", async () => {
    const session = await startSession({ resumeSessionId: "ses_resume00001" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe("ses_resume00001");
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    send(session.driver, { type: "user", text: "scenario:basic hi" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.session_id).toBe("ses_resume00001");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs[0]!.args[argvs[0]!.args.indexOf("--session") + 1]).toBe("ses_resume00001");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a resumed session the harness never confirms: clean end resumable, failure end not (review live21)", async () => {
    // The resume claims the registry record at spawn from the vouched id;
    // whether opencode actually holds that id is the harness's fact. A
    // turn whose process dies before any line named the session fails the
    // turn but not the session — a clean end after it keeps the claimed
    // record resumable (the agy rule), while a failure end without any
    // confirmation does not.
    const clean = await startSession({ resumeSessionId: "ses_resume00002" });
    await waitFor(clean.events, of("session_started"), "session_started");
    send(clean.driver, { type: "user", text: "scenario:crash" });
    const failed = await waitFor(clean.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the opencode process exited with code 1");
    send(clean.driver, { type: "shutdown" });
    expect(await clean.code).toBe(0);
    const cleanEnded = clean.events.at(-1) as Event;
    expect(cleanEnded.type).toBe("session_ended");
    expect(cleanEnded.resumable).toBe(true);

    const crashing = await startSession({ resumeSessionId: "ses_resume00003" });
    await waitFor(crashing.events, of("session_started"), "session_started");
    send(crashing.driver, { type: "user", text: "scenario:garbage" });
    expect(await crashing.code).toBe(1);
    const crashEnded = crashing.events.at(-1) as Event;
    expect(crashEnded.type).toBe("session_ended");
    expect(crashEnded.reason).toBe("crash");
    expect(crashEnded.resumable).toBe(false);
  });

  test("a tool_use line maps to tool_call and tool_result events", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:tools list" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.call_id).toBe("tu_1");
    expect(call.name).toBe("bash");
    expect(call.input).toEqual({ command: "ls" });
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.call_id).toBe("tu_1");
    expect(result.output).toBe("file-a\nfile-b");
    expect(result.is_error).toBe(false);
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("an error line plus a nonzero exit fails the turn with the error as reason; the session survives", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorturn" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error"),
      "the non-fatal error"
    );
    expect(error.fatal).toBe(false);
    expect(error.message).toBe("the model refused the turn");
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the model refused the turn");
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

  test("a silent nonzero exit mid-session fails the turn on the exit code alone", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:silentfail" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the opencode process exited with code 1");
    // A failed turn is not a failed session.
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
  });

  test("a first turn that never names a session id ends the untrackable session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:crash" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe(
      "the opencode process exited with code 1 and named no session id"
    );
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("the first turn named no session id");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    // Never identified, never announced.
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
  });

  test("the author prefix rides the prompt stdin", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const prompts = fakeRecord(session, "prompts.jsonl");
    expect(prompts[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a text past the 16 MiB bound is rejected text_too_long before the ack", async () => {
    // The protocol's text bound (MAX_INPUT_TEXT_BYTES) rejects the text
    // during parse, before the ack — an accepted line the turn process
    // cannot be handed would hang its turn open. The raw write's own cap
    // (17 MiB) is the second gate; this text never reaches it.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "x".repeat(16 * 1024 * 1024 + 1) });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the text_too_long rejection"
    );
    expect(rejected.reason).toBe("text_too_long");
    expect(session.events.filter((event) => event.type === "user_message")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a spawn failure is a fatal codemux error, never an unhandled rejection", async () => {
    const session = await startSession({
      spawnTurn: () => Promise.reject(new Error("the binary is gone")),
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal),
      "fatal error"
    );
    expect(error.source).toBe("codemux");
    expect(error.message).toContain("could not spawn the opencode turn process");
    expect(error.message).toContain("the binary is gone");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });
});

describe("opencode session e2e - honest false capabilities", () => {
  test("mid-turn and unsupported inputs are rejected by name, never silently ignored", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
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

describe("opencode session e2e - stream tiers", () => {
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

  test("a line naming a foreign session is a tier-2 fatal with the raw preserved", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wrongid two" });
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "unknown" &&
            typeof event.raw === "string" &&
            event.raw.includes("ses_other123456789")
        ),
      "the raw passthrough"
    );
    expect(unknown.session_id).toBe("ses_fake1234567890");
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("ses_other123456789");
    expect(await session.code).toBe(1);
  });

  test("a line without a sessionID is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:nosession probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("carries no sessionID");
    expect(await session.code).toBe(1);
  });

  test("a line without a type is a tier-2 fatal", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:notype probe" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("carries no type");
    expect(await session.code).toBe(1);
  });
});

describe("opencode session e2e - end paths", () => {
  test("stdin close mid-turn ends cleanly, with the open turn answered interrupted", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    // The wait scenario's step_start already named the session, so the
    // identity landed and the session is recorded.
    await waitFor(session.events, of("session_started"), "session_started");
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
    // The signal death (exit_code null) is the normal kill path, not a
    // failure — and the confirmed session stays resumable.
    expect(ended.exit_code).toBeNull();
    expect(ended.resumable).toBe(true);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  });

  test("the shutdown drain delivers the open turn's final output", async () => {
    // The end path gives the turn's process the grace to finish on its
    // own; FAKE_SIGTERM_PERSIST=1 answers the shutdown SIGTERM with the
    // turn's remaining lines before exiting 0, and that drained output
    // must reach the caller (review live5's rule, the turn-per-process
    // shape: no end carrier exists, the signal is the only thing left).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    const secondTurn = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    expect(secondTurn.turn_id).toBe("t2");
    send(session.driver, { type: "shutdown" });

    const message = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "assistant_message")[1],
      "the drained assistant_message"
    );
    expect(message.text).toBe("drained after the shutdown signal");
    expect(message.turn_id).toBe("t2");
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
    expect(await session.code).toBe(0);
  });

  test("a process exiting 42 during the drain with its turn open costs success", async () => {
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
    expect(fatal!.message).toContain("exited with code 42 during the shutdown drain");
    // The child's real exit completed the open turn before the synthesis
    // was needed: its verdict carries the exit code it died with, and the
    // drain fatal rides on top as the session-level verdict.
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toBe("the opencode process exited with code 42");
    expect(await session.code).toBe(1);
  });

  test("a wrapper exiting 143 during the drain is the signal's coded spelling, not a failure", async () => {
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
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second.finish).toBe("interrupted");
    expect(second.reason).toBe("the session ended (shutdown) before the turn completed");
    expect(await session.code).toBe(0);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // The drain window exists only while a turn is open (an idle session
    // settles at once), so the late input must land inside one.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("session_started"), "session_started");
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
    expect(await session.code).toBe(0);
  });

  test("a confirmed session whose start was never recorded is not resumable", async () => {
    // Review live22's agy sibling: the first line adopts the id and
    // confirms it; when the record write fails, the crash end must not
    // report the session resumable (a --resume would exit 66).
    const blockerRoot = mkdtempSync(join(workRoot(), "blocker-"));
    const blocker = join(blockerRoot, "blocker");
    const { writeFileSync } = await import("node:fs");
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

  test("a turn child landing after a hard end is settled before done resolves (review D5, correctness 2)", async () => {
    // A timeout while the turn's spawn is still in flight (the 250 ms
    // hold): finish sees no turn process yet, and the late child must be
    // stopped and its tree settled BEFORE done resolves — the CLI's
    // cleanup removes the turn's provider config the moment done does,
    // and an opencode process must never run past that with an
    // OPENCODE_CONFIG pointing at a deleted file. Its exit is codemux's
    // own kill, not a turn verdict: session_ended reports exit_code
    // null, exactly as an idle session does. A graceful end no longer
    // takes this arm (review D11): stdin-close and shutdown run the late
    // child instead, pinned by the next test, so the kill arm is pinned
    // here on a timeout.
    const session = await startSession({ sessionTimeoutMs: 100 }, {}, 250);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("the session ended (timeout)");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
    expect(ended.exit_code).toBeNull();
    expect(await session.code).toBe(1);
    // The ordering the finding named, and exactly one child for the
    // turn: the late child settled before the session's done resolved.
    // (The kill can land before the fake's startup line records argv, so
    // the argv record itself is not asserted here.)
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a stdin close while the turn's spawn is still in flight runs that turn to completion (review D11, correctness 2 1)", async () => {
    // The exact trigger: one prompt, then immediate EOF — `printf one
    // user line | codemux session -a opencode -s` — where the scode
    // gate holds the turn's spawn when the close arrives (the 250 ms
    // hold models that window). A graceful end owes that pending turn
    // its run: pre-D11 the late child was killed on arrival, so the
    // prompt never ran and the turn was reported interrupted while the
    // session still ended exit 0. Now the end path delivers the prompt
    // itself and runs the child through the landed path's drain, inside
    // the end, settled before done resolves.
    const session = await startSession({}, {}, 250);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the turn's own completion"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    const assistant = await waitFor(
      session.events,
      of("assistant_message"),
      "assistant_message"
    );
    expect(assistant.text).toBe("Done: scenario:basic one");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    // The harness confirmed the session (its lines named the id inside
    // the drain), so the graceful end stays resumable.
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    // The prompt actually reached the late child — the regression's
    // core — and it settled before done resolved.
    expect(fakeRecord(session, "prompts.jsonl")).toEqual([
      { text: "scenario:basic one" },
    ]);
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });
});
