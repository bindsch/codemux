/**
 * Driver e2e tests for the aider session (design §4.7, plan step 8): the
 * real AiderSessionDriver over the scenario-driven fake headless aider
 * (tests/fixtures/live/fake-aider-run.ts), whose wire shapes are pinned
 * against the installed 0.86.2 binary. The session is turn-per-process
 * with codemux-owned state — one `aider --message=<prompt>` process per
 * caller input, replaying and appending the per-session chat history file
 * — so every round-trip is live: the minted-UUID identity announced at
 * run() start, the argv prompt with the canned negatives on stdin, the
 * history-delta verdicts, the multi-line-prompt anchoring, and the end
 * paths including the shutdown drain.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AiderSessionDriver, type AiderDriverOptions } from "../src/session/aider-driver.js";
import { MAX_HISTORY_BYTES } from "../src/aider-history.js";
import { aiderSessionHistoryPath } from "../src/session/aider-session.js";
import { SessionProcess } from "../src/session/process.js";
import { readRegistry } from "../src/session/registry.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-aider-run.ts", import.meta.url));

type Event = Record<string, any>;

interface Session {
  driver: AiderSessionDriver;
  events: Event[];
  code: Promise<number>;
  options: AiderDriverOptions;
  stateDir: string;
  historyPath: string;
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
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-aider-e2e-"));
  return root;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One driver whose spawnTurn spawns the fake per turn, exactly the way
 * the CLI's closure spawns one headless aider per caller input. A nonzero
 * spawnDelayMs holds the spawn in flight first — the review D5 late-child
 * window, where the end path begins while the turn's process has not
 * landed yet. */
async function startSession(
  overrides: Partial<AiderDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  beforeRun?: (historyPath: string) => void,
  spawnDelayMs = 0
): Promise<Session> {
  const dir = mkdtempSync(join(workRoot(), "s-"));
  const workDir = join(dir, "work");
  const stateDir = join(dir, "state");
  const registryDir = join(dir, "registry");
  mkdirSync(workDir);
  mkdirSync(stateDir);
  mkdirSync(registryDir, { mode: 0o700 });
  const harnessHome = join(dir, "aider-home");
  const sessionId = overrides.sessionId ?? crypto.randomUUID();
  const historyPath = overrides.historyPath ?? aiderSessionHistoryPath(harnessHome, sessionId);
  const events: Event[] = [];
  const order: string[] = [];
  let driver!: AiderSessionDriver;
  const procs: SessionProcess[] = [];
  const options: AiderDriverOptions = {
    sessionId,
    resume: false,
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
    harnessHome,
    providerBaseUrl: null,
    historyPath,
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
  driver = new AiderSessionDriver(options);
  // The CLI's order: the pre-spawn step (fresh history + start record),
  // any pre-run state setup, then the main wait.
  expect(driver.recordBeforeSpawn()).toBeNull();
  beforeRun?.(historyPath);
  const code = driver.run();
  void code.then(() => order.push("done"));
  cleanups.push(async () => {
    driver.dispose();
    for (const proc of procs) {
      proc.requestStop();
      await proc.settled;
    }
  });
  return { driver, events, code, options, stateDir, historyPath, order };
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

const send = (driver: AiderSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

/** The argv entry starting with --message=, if the turn spawned. */
const messageArg = (session: Session, turn: number): string | undefined =>
  fakeRecord(session, "argv.jsonl")[turn]?.args.find((arg: string) =>
    arg.startsWith("--message=")
  );

describe("aider session e2e - lifecycle", () => {
  test("a fresh session announces itself before any input, then runs a two-turn exchange through the history file", async () => {
    const session = await startSession();
    // Codemux owns the identity: the minted UUID and the capability
    // matrix arrive at run() start, before any caller input.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(UUID.test(started.session_id)).toBe(true);
    expect(started.agent).toBe("aider");
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
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);

    send(session.driver, { type: "user", text: "scenario:basic one" });
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic one");
    expect(echo.turn_id).toBe("t1");
    expect(echo.session_id).toBe(started.session_id);
    // The banner is a human transcript: tier-1 unknown passthrough, raw
    // preserved, under the session's id.
    const banner = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "unknown"),
      "the banner passthrough"
    );
    expect(banner.raw).toBe("Aider v0.86.2");
    expect(banner.session_id).toBe(started.session_id);
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic one");
    expect(message.turn_id).toBe("t1");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    expect(completed.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
    // The exchange landed in the per-session history file, and the prompt
    // rode argv while the canned negatives rode stdin.
    expect(readFileSync(session.historyPath, "utf8")).toContain("#### scenario:basic one");
    expect(messageArg(session, 0)).toBe("--message=scenario:basic one");
    expect(fakeRecord(session, "stdin.jsonl")[0]?.bytes).toBe(128);
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs[0]!.args).toContain("--restore-chat-history");
    expect(argvs[0]!.args).toContain("--chat-history-file");
    expect(argvs[0]!.args[argvs[0]!.args.indexOf("--chat-history-file") + 1]).toBe(
      session.historyPath
    );

    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.turn_id).toBe("t2");
    expect(second.finish).toBe("end");
    // The state carried: turn 1 replayed an empty file (fresh) while
    // turn 2's process replayed turn 1's exchange before appending its
    // own (--restore-chat-history read the file).
    expect(fakeRecord(session, "prehistory.jsonl")[0]?.length).toBe(0);
    expect(fakeRecord(session, "prehistory.jsonl")[1]?.length).toBeGreaterThan(0);
    expect(readFileSync(session.historyPath, "utf8")).toContain("#### scenario:basic two");

    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(ended.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });

    // The registry recorded the session under the minted UUID (§4.8).
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === started.session_id)
        : undefined;
    expect(entry?.agent).toBe("aider");
    expect(entry?.ended).not.toBe(null);
  });

  test("a resume adopts the recorded id and replays the prior conversation", async () => {
    const id = crypto.randomUUID();
    // The prior session's exchange is already in the file before run()
    // reads it — a resume never creates the file (that would wipe the
    // conversation), it verifies and replays it.
    const session = await startSession({ sessionId: id, resume: true }, {}, (historyPath) => {
      // The original session's recordBeforeSpawn created the directory
      // and file; seed the prior exchange the resume must replay, in the
      // shape codemux creates (0700 directory, 0600 file — the pre-turn
      // check's contract, review D7).
      mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
      writeFileSync(historyPath, "#### prior turn\n\nprior reply\n\n", { mode: 0o600 });
    });
    // The CLI claims the resume record before anything spawns.
    session.driver.adoptResumeClaim();
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(id);
    send(session.driver, { type: "user", text: "scenario:basic next" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    // The replay read the PRIOR exchange (not this turn's), so the state
    // carried from before the resume.
    expect(fakeRecord(session, "prehistory.jsonl")[0]?.length).toBe(
      "#### prior turn\n\nprior reply\n\n".length
    );
    const history = readFileSync(session.historyPath, "utf8");
    expect(history.startsWith("#### prior turn")).toBe(true);
    expect(history).toContain("#### scenario:basic next");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a session whose history outgrew the run path's whole-file bound still completes turns (review D8, correctness 2)", async () => {
    // The run read's 32 MiB cap is sized for one exchange; a session's
    // history accumulates every exchange for the session's whole life.
    // The driver used to read the whole file after every turn, so once
    // it crossed the cap every finished turn came back "unreadable or
    // truncated", the session ended, and every later --resume was
    // refused the same way — though nothing was corrupt. The reads are
    // a content-free size baseline and each turn's bounded delta past a
    // byte offset now, so a history past the cap resumes and runs.
    const id = crypto.randomUUID();
    const session = await startSession({ sessionId: id, resume: true }, {}, (historyPath) => {
      // The prior conversation, grown past the run bound: a real
      // exchange first (what turns before the cap wrote), then filler
      // exchanges of plain lines — no `#### `, so this turn's header is
      // the delta's first. The shape codemux creates: 0700 directory,
      // 0600 file (the pre-turn check's contract, review D7).
      mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
      const prior = Buffer.from("#### prior turn\n\nprior reply\n\n");
      const filler = Buffer.alloc(
        MAX_HISTORY_BYTES + 1024 - prior.length,
        0x78
      );
      writeFileSync(historyPath, Buffer.concat([prior, filler]), { mode: 0o600 });
    });
    session.driver.adoptResumeClaim();
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(id);
    send(session.driver, { type: "user", text: "scenario:basic next" });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:basic next");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    // The exchange landed past the bound-sized prefix, and the file
    // (still growing) ends with this turn's exchange.
    const history = readFileSync(session.historyPath, "utf8");
    expect(history.length).toBeGreaterThan(MAX_HISTORY_BYTES);
    expect(history.endsWith("#### scenario:basic next  \n\nDone: scenario:basic next\n\n")).toBe(
      true
    );
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
  });

  test("a resume whose history file is gone fails before any turn runs", async () => {
    const broken = await startSession({
      resume: true,
      historyPath: join(workRoot(), "missing-history", "history.md"),
    });
    broken.driver.adoptResumeClaim();
    expect(await broken.code).toBe(1);
    const error = broken.events.find(
      (event) => event.type === "error" && event.fatal === true
    ) as Event;
    expect(error.message).toContain("the resumed conversation is not recoverable");
    expect(broken.events.some((event) => event.type === "turn_started")).toBe(false);
    const ended = broken.events.at(-1) as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });

  test("the author prefix rides the argv prompt", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(messageArg(session, 0)).toBe("--message=[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a tool-chatter blockquote never reaches the assistant message", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:toolreply edit" });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:toolreply edit");
    expect(message.text).not.toContain("Adding file main.py");
    // The chatter IS in the history file (aider wrote it); only the
    // extraction skips it.
    expect(readFileSync(session.historyPath, "utf8")).toContain("> Adding file main.py");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a multi-line prompt's continuation lines never leak into the reply", async () => {
    // The regression this pins: the reply used to be extracted past the
    // first `#### ` header alone, so a prompt with newlines leaked its
    // own continuation lines into the assistant message.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:multiline line1\nline2" });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:multiline line1\nline2");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a multi-line prompt ending in a line break anchors the same block (review D4)", async () => {
    // Python's splitlines drops the trailing empty element the JS split
    // kept, so aider writes no `#### ` line for the final break; a header
    // that kept it missed the block, the extraction fell back to the
    // first-`#### `-line anchor, and the reply began with the prompt's
    // own continuation lines.
    const session = await startSession();
    send(session.driver, {
      type: "user",
      text: "scenario:multiline line1\nline2\n",
    });
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Done: scenario:multiline line1\nline2");
    expect(message.text).not.toContain("#### line2");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a prompt past the 32 KiB argv bound is rejected text_too_long before the ack", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "x".repeat(32 * 1024 + 1) });
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
});

describe("aider session e2e - turn verdicts", () => {
  test("a nonzero exit with no history delta fails the turn; the session survives", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:errorturn" });
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the aider process exited with code 1");
    expect(of("assistant_message")(session.events)).toBeUndefined();
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

  test("a clean exit that records no exchange fails the turn; the session survives", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:noexchange" });
    const failed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the chat history records no exchange for this turn");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    // The turn failed but the end is clean: the history file (the
    // resumable state) is intact.
    expect(ended.resumable).toBe(true);
  });

  test("a history file replaced by a symlink between turns fails the next turn before any spawn (review D7, security)", async () => {
    // The finding's window: the creation-time check is one-shot and the
    // O_NOFOLLOW read runs only after a turn's process exits, so between
    // turns nothing guarded the file — a sandboxed child that can write
    // `~/.aider` could replace it with a symlink to a file outside its
    // sandbox, and the next turn's aider would follow it: read the
    // target into the model context and append to it. The pre-turn check
    // trips first, fails the TURN (never the session), and no aider
    // process ever runs against the link.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // What turn 1's child could have planted between turns.
    const canary = join(dirname(session.historyPath), "authorized_keys");
    writeFileSync(canary, "ssh-ed25519 AAAA canary");
    rmSync(session.historyPath);
    symlinkSync(canary, session.historyPath);

    send(session.driver, { type: "user", text: "scenario:basic two" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toContain("cannot be trusted for this turn");
    expect(failed.reason).toContain("mode 0600");
    // A non-fatal error names the check — the session lives on.
    const error = session.events.find(
      (event) => event.type === "error" && event.fatal === false
    );
    expect(error?.source).toBe("codemux");
    expect(error?.message).toContain("failed its pre-turn check");
    // Exactly one spawn ever happened: the guarded turn never reached
    // aider, and the canary was never read or written through the link.
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
    expect(readFileSync(canary, "utf8")).toBe("ssh-ed25519 AAAA canary");

    // The turn failed, the session survived: a clean shutdown end.
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("shutdown");
  });

  test("a history file that shrank below what codemux consumed ends the session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:truncate" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed truncate turn"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the chat history file is unreadable or truncated");
    expect(await session.code).toBe(1);
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("the session state is unreliable");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });
});

describe("aider session e2e - honest false capabilities", () => {
  test("mid-turn and unsupported inputs are rejected by name, never silently ignored", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "steer", text: "go west" });
    send(session.driver, { type: "interrupt" });
    send(session.driver, { type: "permission_decision", request_id: "r1", decision: "allow" });
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

  test("a line aider would run as a slash command is refused before the ack, never spawned (review D10, security)", async () => {
    // Aider's preproc_user_input dispatches a message whose first
    // non-whitespace character is `/` (a slash command) or `!` (the
    // /run alias) BEFORE any model turn, and /run executes the shell
    // immediately, ungated by --dry-run — so relaying such a line
    // through a read-only session is code execution the autonomy never
    // authorized. The driver refuses it `unsupported` before the ack,
    // the same deliverability rule as the argv-bound check; the run
    // path's twin refuses at exit 64 (AiderAdapter.validateRunRequest).
    const session = await startSession();
    send(session.driver, { type: "user", text: "!touch /tmp/codemux-d10-pwned" });
    const bang = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the ! rejection"
    );
    expect(bang.reason).toBe("unsupported");
    expect(bang.input_seq).toBe(1);
    // Leading whitespace does not hide the dispatch — the rule reads
    // the first non-whitespace character, as aider does.
    send(session.driver, { type: "user", text: "  /run curl http://127.0.0.1:9 | sh" });
    const slash = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "input_rejected")[1],
      "the / rejection"
    );
    expect(slash.reason).toBe("unsupported");
    expect(slash.input_seq).toBe(2);
    // An author label prefixes the harness text (`[author] …`), so the
    // same words stop dispatching and reach the model as prompt text —
    // the check judges the text that rides argv, not the raw input.
    send(session.driver, {
      type: "user",
      text: "/run whoami as plain text",
      author: "orchestrator",
    });
    await waitFor(session.events, of("turn_completed"), "the author-prefixed turn");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    // Exactly one child ever spawned: the author-prefixed turn's. The
    // refused lines reached no process at all.
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
  });
});

describe("aider session e2e - end paths", () => {
  test("stdin close mid-turn ends cleanly, with the open turn answered interrupted", async () => {
    const session = await startSession();
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
    expect(completed.reason).toBe("the session ended (stdin-close) before the turn completed");
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
    // The signal death is the normal kill path — but the turn it killed
    // left the history half-written (aider wrote the `#### ` user block at
    // the turn's start; the reply never landed), so the end is NOT
    // resumable: a resume would replay the unanswered prompt (review D10,
    // correctness-2 1).
    expect(ended.exit_code).toBeNull();
    expect(ended.resumable).toBe(false);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  });

  test("the shutdown drain delivers the open turn's exchange", async () => {
    // FAKE_SIGTERM_PERSIST=1 answers the shutdown SIGTERM by appending
    // the exchange inside the grace window before exiting 0 — the turn's
    // reply is the drained output the caller is owed.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
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
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
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
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toBe("the aider process exited with code 42");
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
    // No drain fatal: 143 is how a wrapper spells the SIGTERM codemux sent
    // — and it is not a drain failure, so endExitCode stays 0; the
    // not-resumable verdict rests on the interrupted open turn, which
    // left the history with turn 2's unanswered prompt (review D10,
    // correctness-2 1).
    expect(of("error")(session.events)).toBeUndefined();
    expect(ended.resumable).toBe(false);
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second.finish).toBe("interrupted");
    expect(second.reason).toBe("the session ended (shutdown) before the turn completed");
    expect(await session.code).toBe(0);
    // The half-written state the verdict answers for: turn 2's user block
    // is in the history, its reply never landed (the `wait` scenario
    // writes the block at the turn's start — io.user_input parity).
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:wait two");
    expect(history).not.toContain("Done: scenario:wait two");
  });

  test("a turn killed partway leaves the history half-written and the session not resumable (review D10, correctness-2 1)", async () => {
    // The regression this pins: a killed turn exited 143 (not a drain
    // failure) with no turn failure recorded, so the end's verdict said
    // resumable — though aider had already written the turn's `#### `
    // user block to the history file and would never write its reply,
    // leaving exactly the mid-exchange state a resume must refuse:
    // --restore-chat-history replays the unanswered prompt as if the
    // caller had sent it again.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "exit143" });
    send(session.driver, { type: "user", text: "scenario:wait interrupted" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    send(session.driver, { type: "shutdown" });

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the interrupted turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(143);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(0);
    // The half-written history: the user block landed at the turn's
    // start, the reply never did.
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:wait interrupted");
    expect(history).not.toContain("Done: scenario:wait interrupted");
  });

  test("the session timeout ends the session", async () => {
    const session = await startSession({ sessionTimeoutMs: 300 });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
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
    expect(error.message).toContain("could not spawn the aider turn process");
    expect(error.message).toContain("the binary is gone");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a turn child landing after a hard end is settled before done resolves (review D5, correctness 2)", async () => {
    // A timeout while the turn's spawn is still in flight (the 250 ms
    // hold): finish sees no turn process yet, and the late child must be
    // stopped and its tree settled BEFORE done resolves — the CLI's
    // cleanup runs the moment done does, and an aider process must never
    // run past the session it was spawned for (review D5, correctness 2,
    // the opencode twin names the provider-config deletion; aider's
    // child holds nothing codemux deletes, but the ordering rule is one).
    // Its exit is codemux's own kill, not a turn verdict: session_ended
    // reports exit_code null, exactly as an idle session does. A
    // graceful end no longer takes this arm (review D11): stdin-close
    // and shutdown run the late child instead, pinned by the next test,
    // so the kill arm is pinned here on a timeout.
    const session = await startSession({ sessionTimeoutMs: 100 }, {}, undefined, 250);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toBe("the session ended (timeout) before the turn completed");
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("timeout");
    expect(ended.exit_code).toBeNull();
    expect(await session.code).toBe(1);
    // The ordering the finding named, and exactly one child for the
    // turn: the late child settled before the session's done resolved.
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a stdin close while the turn's spawn is still in flight runs that turn to completion (review D11, correctness 2 1)", async () => {
    // The aider twin of the opencode trigger — `printf one user line |
    // codemux session -a aider -s` — where the scode gate holds the
    // turn's spawn when the close arrives (the 250 ms hold models that
    // window). The prompt rides argv (written before the spawn); what
    // the late child misses is its stdin negatives, so the end path
    // writes those itself and runs the turn through the landed path's
    // drain. The history file then holds the full exchange, and the
    // graceful end stays resumable — pre-D11 the child was killed on
    // arrival, the prompt never ran, and the turn was reported
    // interrupted.
    const session = await startSession({}, {}, undefined, 250);
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
    const message = await waitFor(
      session.events,
      of("assistant_message"),
      "assistant_message"
    );
    expect(message.text).toBe("Done: scenario:basic one");
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(0);
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    // The negatives reached the late child and the prompt rode argv —
    // the regression's core — and the history holds the full exchange
    // (the resumable state), settled before done resolved.
    expect(fakeRecord(session, "stdin.jsonl")[0]?.bytes).toBe(128);
    expect(messageArg(session, 0)).toBe("--message=scenario:basic one");
    const history = readFileSync(session.historyPath, "utf8");
    expect(history).toContain("#### scenario:basic one");
    expect(history).toContain("Done: scenario:basic one");
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a history file the start record cannot record into ends the session before any turn", async () => {
    // The registry write fails (the registry path's parent is a file):
    // recordBeforeSpawn reports it, and the CLI refuses to run a session
    // it cannot track (§4.8).
    const blockerRoot = mkdtempSync(join(workRoot(), "blocker-"));
    const blocker = join(blockerRoot, "blocker");
    writeFileSync(blocker, "not a directory");
    const harnessHome = join(blockerRoot, "home");
    const id = crypto.randomUUID();
    const driver = new AiderSessionDriver({
      sessionId: id,
      resume: false,
      autonomy: "high",
      cwd: blockerRoot,
      hermetic: false,
      sandboxed: true,
      sandboxTrust: "standard",
      sandboxNoNet: false,
      sandboxScrubEnv: false,
      passEnv: [],
      authorPrefix: true,
      sessionTimeoutMs: null,
      registryPath: join(blocker, "reg", "live-sessions.json"),
      harnessHome,
      providerBaseUrl: null,
      historyPath: aiderSessionHistoryPath(harnessHome, id),
      spawnTurn: () => Promise.reject(new Error("never reached")),
    });
    expect(driver.recordBeforeSpawn()).toContain("cannot update the session registry");
    driver.dispose();
  });
});
