/**
 * Driver e2e tests for the kimi session (design §4.7): the real
 * KimiSessionDriver over the scenario-driven fake headless kimi
 * (tests/fixtures/live/fake-kimi-run.ts), whose wire shapes are pinned
 * against the installed 0.31.1 binary. The session is turn-per-process —
 * the driver's spawnTurn closure spawns one fake per caller input — so
 * every round-trip is live: the deferred identity model (session_started
 * waits for the first turn's resume hint), the prompt-on-argv wire, the
 * --session resume, the honest-false input rejections, the exit-code
 * turn verdicts (empty output included), and the three tiers' end paths
 * including the shutdown drain.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KimiSessionDriver,
  type KimiDriverOptions,
} from "../src/session/kimi-driver.js";
import { SessionProcess, SESSION_SIGNAL_EXIT_CODE } from "../src/session/process.js";
import { readRegistry } from "../src/session/registry.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-kimi-run.ts", import.meta.url));

/** The fake's default minted id (fixtures/live/fake-kimi-run.ts). */
const ID = "session_11111111-2222-3333-4444-555555555555";
const OTHER = "session_99999999-8888-7777-6666-555555555555";

const NULL_USAGE = {
  input_tokens: null,
  output_tokens: null,
  cached_input_tokens: null,
  total_tokens: null,
  cost_usd: null,
};

type Event = Record<string, any>;

interface Session {
  driver: KimiSessionDriver;
  events: Event[];
  code: Promise<number>;
  options: KimiDriverOptions;
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
// Positive late-spawn checks allow interpreter startup under full-suite load.
const STARTUP_GRACE_MS = 5_000;
function workRoot(): string {
  if (root === null) root = mkdtempSync(join(tmpdir(), "codemux-kimi-e2e-"));
  return root;
}

/** One driver whose spawnTurn spawns the fake per turn, exactly the way
 * the CLI's closure spawns one headless `kimi` per caller input. A
 * nonzero spawnDelayMs holds the spawn in flight first — the review D5
 * late-child window, where the end path begins while the turn's process
 * has not landed yet — from turn `delayFromTurn` on (default 1: every
 * turn; 2 leaves the first turn prompt so a record exists before the
 * hold opens, round al27). */
async function startSession(
  overrides: Partial<KimiDriverOptions> = {},
  extraEnv: Record<string, string> = {},
  spawnDelayMs = 0,
  delayFromTurn = 1,
  graceMs = 500
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
  let driver!: KimiSessionDriver;
  const procs: SessionProcess[] = [];
  let turnCount = 0;
  const options: KimiDriverOptions = {
    resumeSessionId: null,
    autonomy: "high",
    model: undefined,
    wireModel: undefined,
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
      turnCount++;
      if (spawnDelayMs > 0 && turnCount >= delayFromTurn) await Bun.sleep(spawnDelayMs);
      // The fake replaces the binary name and keeps every flag, so the
      // recorded argv is the argv the driver built.
      const proc = new SessionProcess({
        command: ["bun", FAKE, ...argv.slice(1)],
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FAKE_STATE_DIR: stateDir,
          FAKE_TURN_NUMBER: String(turnCount),
          HOME: dir,
          ...extraEnv,
        },
        onLine: (line) => driver.handleHarnessLine(line),
        onFatal: (fatal) => driver.handleFatal(fatal),
        graceMs,
      });
      procs.push(proc);
      order.push("spawned");
      void proc.settled.then(() => order.push("settled"));
      const prompt = argv[argv.indexOf("--prompt") + 1] ?? "";
      if (/\bscenario:wait\b/.test(prompt) &&
          (extraEnv.FAKE_DRAIN_SELFKILL === "1" || extraEnv.FAKE_DRAIN_EXIT143 === "1")) {
        // Start the drain only after the fake has installed its EOF handler.
        // Interpreter startup must not consume the drain's 500 ms budget.
        const readyPath = join(stateDir, "drain-ready.jsonl");
        await waitFor(events, () => {
          if (!existsSync(readyPath)) return undefined;
          const ready = readFileSync(readyPath, "utf8").trim().split("\n");
          return ready.some((line) => JSON.parse(line).turn === String(turnCount)) ? true : undefined;
        }, "the fake's drain handler");
      }
      return proc;
    },
    sink: (line) => {
      events.push(JSON.parse(line) as Event);
    },
    ...overrides,
  };
  driver = new KimiSessionDriver(options);
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

const send = (driver: KimiSessionDriver, message: unknown): void => {
  driver.handleCallerLine(JSON.stringify(message));
};

describe("kimi session e2e - lifecycle", () => {
  test("a fresh session runs a two-turn exchange with the identity deferred to the first resume hint", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });

    // Before the first resume hint, the session does not exist yet: the
    // input is answered and echoed with an empty session id, and the
    // turn opens codemux-side.
    const echo = await waitFor(session.events, of("user_message"), "user_message");
    expect(echo.text).toBe("scenario:basic one");
    expect(echo.turn_id).toBe("t1");
    expect(echo.session_id).toBe("");
    const turnStarted = await waitFor(session.events, of("turn_started"), "turn_started");
    expect(turnStarted.turn_id).toBe("t1");
    expect(turnStarted.raw).toBeNull();

    // The closing resume hint adopts the native session id.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.agent).toBe("kimi");
    expect(started.session_id).toBe(ID);
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

    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("end");
    expect(completed.usage).toEqual(NULL_USAGE);
    // The hint passes through raw after adopting the id.
    const unknowns = session.events.filter(
      (event) => event.type === "unknown" && typeof event.raw === "string"
    );
    expect(unknowns.at(-1)!.raw).toContain("session.resume_hint");
    expect(unknowns.at(-1)!.session_id).toBe(ID);

    // The second turn resumes the native store by id.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs).toHaveLength(2);
    expect(argvs[0]!.args).not.toContain("--session");
    expect(argvs[1]!.args[argvs[1]!.args.indexOf("--session") + 1]).toBe(ID);
    // The prompt rides argv, the run path's flag order.
    expect(argvs[0]!.args[argvs[0]!.args.indexOf("--prompt") + 1]).toBe(
      "scenario:basic one"
    );
    expect(argvs[0]!.args).toContain("--output-format");
    expect(argvs[0]!.args[argvs[0]!.args.indexOf("--output-format") + 1]).toBe(
      "stream-json"
    );

    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(true);
    expect(ended.usage).toEqual(NULL_USAGE);

    const announcementIndex = session.events.findIndex((event) => event.type === "session_started");
    expect(session.events.slice(0, announcementIndex).every((event) => event.session_id === "")).toBe(true);
    const hintIndex = session.events.findIndex((event) => event.raw?.includes("session.resume_hint"));
    expect(hintIndex).toBeGreaterThan(announcementIndex);

    // The registry holds the record under the native id.
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const entry =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === ID)
        : undefined;
    expect(entry?.agent).toBe("kimi");
    expect(entry?.cwd).toBe(session.workDir);
    expect(entry?.harness_home).toBe(session.options.harnessHome);
    expect(entry?.autonomy).toBe("high");
    expect(entry?.sandboxed).toBe(true);
  });

  test("a resumed session knows its identity at run start, and its first hint only has to agree", async () => {
    const session = await startSession({ resumeSessionId: ID });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(ID);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    const argv = fakeRecord(session, "argv.jsonl")[0] as Record<string, any>;
    expect(argv.args[argv.args.indexOf("--session") + 1]).toBe(ID);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
  });

  test("a resumed session whose store refused the id is not resumable, though the end stays clean (al11 re-review)", async () => {
    // kimi answers an unknown --session id with the turn's exit, not the
    // session's: the process dies before any hint, the turn fails, and
    // an orderly shutdown after it still exits 0. Before the fix that
    // clean end exit advertised resumable:true — the record said one
    // more --resume could work, and every retry would hit the same
    // refusal. The turn's failure while no hint confirmed the id this
    // run is the evidence, and the end now reads it.
    const session = await startSession({ resumeSessionId: ID });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(ID);
    send(session.driver, { type: "user", text: "scenario:crash one" });
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited with code 1");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
  });

  test("a session-load refusal on a later turn withdraws the earlier turn's confirmation (al12)", async () => {
    // Turn 1 completes and its hint confirms the id; turn 2's process is
    // the store's refusal shape (exit 1, no hint — a moved store answers
    // the turn, not the session). Before the fix harnessConfirmed was a
    // run-lifetime flag: turn 2's failure skipped the unconfirmed-turn
    // evidence and the clean shutdown end still advertised resumable:true
    // on the strength of turn 1's hint, directing a retrying caller at a
    // session the harness refused to load. The confirmation is per-turn
    // now, and a later turn that confirms again restores it.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:errorturn two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the refused turn_completed"
    );
    expect(second.finish).toBe("failed");
    expect(second.reason).toBe("the kimi process exited with code 1");
    // The failed turn is a turn fact, not a session fatal.
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);

    // The withdrawal is not permanent: a later turn whose hint names the
    // session again re-earns the confirmation, and that session ends
    // resumable.
    const later = await startSession();
    send(later.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(later.events, of("turn_completed"), "first turn_completed");
    send(later.driver, { type: "user", text: "scenario:errorturn two" });
    await waitFor(
      later.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the refused turn_completed"
    );
    send(later.driver, { type: "user", text: "scenario:basic three" });
    const third = await waitFor(
      later.events,
      (events) => events.filter((event) => event.type === "turn_completed")[2],
      "third turn_completed"
    );
    expect(third.finish).toBe("end");
    send(later.driver, { type: "shutdown" });
    expect(await later.code).toBe(1);
    const laterEnded = later.events[later.events.length - 1] as Event;
    expect(laterEnded.resumable).toBe(true);
  });

  test("a turn that ends exit 0 with assistant output but no resume hint fails, unconfirmed (al13)", async () => {
    // The edges-1 finding: the writer pins the closing hint to every
    // completed turn, so a turn of an identified session that ends with
    // no hint — truncated or drifted output — is not successful
    // whatever its exit and output say. Before al13 the verdict read
    // exit and output alone: a resumed turn that printed assistant
    // text, skipped the hint, and exited 0 completed as `end`, and only
    // a LATER failure (or nothing at all) set the unconfirmed-turn
    // evidence, so a clean shutdown after such a turn still advertised
    // resumable:true. The turn fails on its own now, every time, and
    // the end is not resumable.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:nohint two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the unconfirmed turn_completed"
    );
    expect(second.finish).toBe("failed");
    expect(second.reason).toBe(
      "the kimi process exited 0 without the resume hint that closes every completed turn, " +
        "so the session is unconfirmed"
    );
    // A turn fact, not a session fatal: no error event, the session
    // survives, and the shutdown end stays clean.
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("shutdown");
    expect(ended.resumable).toBe(false);

    // The verdict is not a scar on the session either: a later turn
    // whose hint closes it confirms again, and that session ends
    // resumable.
    const later = await startSession();
    send(later.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(later.events, of("turn_completed"), "first turn_completed");
    send(later.driver, { type: "user", text: "scenario:nohint two" });
    const unconfirmed = await waitFor(
      later.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the unconfirmed turn_completed"
    );
    expect(unconfirmed.finish).toBe("failed");
    send(later.driver, { type: "user", text: "scenario:basic three" });
    const third = await waitFor(
      later.events,
      (events) => events.filter((event) => event.type === "turn_completed")[2],
      "third turn_completed"
    );
    expect(third.finish).toBe("end");
    send(later.driver, { type: "shutdown" });
    expect(await later.code).toBe(0);
    const laterEnded = later.events[later.events.length - 1] as Event;
    expect(laterEnded.resumable).toBe(true);
  });

  test("output after the turn's closing resume hint fails the turn, whatever the child's clean exit (al14)", async () => {
    // The wire pin: runPrompt runs the turn body, then writes the hint,
    // then the process exits — the hint is the stream's FINAL line. A
    // hint followed by further assistant output is a malformed or
    // concatenated stream, never a longer turn: before al14 the trailing
    // line parsed as one more assistant message and the turn completed
    // `end` on the child's clean exit. The fatal owns the verdict (the
    // al11 edges-2 rule), and the confirmation the hint earned is
    // withdrawn — a stream this broken does not vouch for the store's
    // state — so the crash ends non-resumable.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    send(session.driver, { type: "user", text: "scenario:trailing two" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.source).toBe("harness");
    expect(error.message).toContain("harness output followed the turn's closing resume hint");
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure");
    expect(completed.reason).toContain(
      "harness output followed the turn's closing resume hint"
    );
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });

  test("the model rides the per-turn command when one applies", async () => {
    const session = await startSession({ model: "kimi-k2.5", wireModel: "kimi-k2.5" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.model).toBe("kimi-k2.5");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    const argv = fakeRecord(session, "argv.jsonl")[0] as Record<string, any>;
    expect(argv.args[argv.args.indexOf("--model") + 1]).toBe("kimi-k2.5");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome === "ok" && registry.file.sessions.find((r) => r.id === ID)?.model).toBe(
      "kimi-k2.5"
    );
  });

  test("a fresh session adopts whatever id its first hint names, even a foreign one", async () => {
    // Nothing vouches for a fresh session's id except its own hint, so
    // the wrongid defect is a resumed-session fact (below); here the
    // adoption itself is pinned: the hint names OTHER, so OTHER is the
    // session, the registry key included.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wrongid one" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(OTHER);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    const argvs = fakeRecord(session, "argv.jsonl");
    expect(argvs[1]!.args[argvs[1]!.args.indexOf("--session") + 1]).toBe(OTHER);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const registry = readRegistry(session.options.registryPath as string);
    expect(
      registry.outcome === "ok" && registry.file.sessions.some((r) => r.id === OTHER)
    ).toBe(true);
  });

  test("a tool-calling turn maps its calls and results, arguments parsed", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:tools one" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.call_id).toBe("call_1");
    expect(call.name).toBe("bash");
    expect(call.input).toEqual({ command: "ls" });
    const result = await waitFor(session.events, of("tool_result"), "tool_result");
    expect(result.call_id).toBe("call_1");
    expect(result.output).toBe("file-a\nfile-b");
    expect(result.is_error).toBe(false);
    const message = await waitFor(session.events, of("assistant_message"), "assistant_message");
    expect(message.text).toBe("Listed: scenario:tools one");
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a stream that ends with an unanswered tool call and no final text fails the turn (al33)", async () => {
    // Round al33, edges major 2: an assistant frame carrying only tool
    // calls is a request for work, not a reply, so it may not mark the
    // turn as having produced one. The danglingtool fake cuts the tool
    // loop mid-flight — the call opens, its result never arrives, no
    // final assistant text follows, the closing hint lands, and the
    // child exits 0 — and before this round exactly that shape
    // completed as `end`: the tool-call frame set sawAssistant, and
    // nothing tracked the call it left open.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:danglingtool one" });
    const call = await waitFor(session.events, of("tool_call"), "tool_call");
    expect(call.call_id).toBe("call_1");
    // No assistant_message ever arrives: the turn produced no reply.
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe(
      "the kimi process exited 0 with 1 tool call that never received a result and no final assistant reply"
    );
    // A turn fact, not a session fatal: the session survives, and a
    // later whole turn still completes.
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "user", text: "scenario:basic two" });
    const second = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(second.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("informational meta (retrying, version) passes through raw and the turn still completes", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:retrying one" });
    const unknown = await waitFor(
      session.events,
      (events) =>
        events.find(
          (event) =>
            event.type === "unknown" &&
            typeof event.raw === "string" &&
            event.raw.includes("turn.step.retrying")
        ),
      "the retrying passthrough"
    );
    expect(unknown.raw).toContain('"failed_attempt":1');
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a thrown turn fails its turn and the session survives; the same exit on the first turn ends the untrackable session", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:errorturn two" });
    const failed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(failed.finish).toBe("failed");
    expect(failed.reason).toBe("the kimi process exited with code 1");
    // No fatal: the session carries on.
    expect(of("error")(session.events)).toBeUndefined();
    send(session.driver, { type: "user", text: "scenario:basic three" });
    const third = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[2],
      "third turn_completed"
    );
    expect(third.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(1);

    // The same exit before any hint: §4.8's untracked rule.
    const early = await startSession();
    send(early.driver, { type: "user", text: "scenario:crash one" });
    const fatal = await waitFor(
      early.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the untracked fatal"
    );
    expect(fatal.message).toContain("named no session id");
    const completed = await waitFor(early.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("named no session id");
    expect(await early.code).toBe(1);
    const ended = early.events[early.events.length - 1] as Event;
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
    // session_started never happened: nothing was ever identified.
    expect(of("session_started")(early.events)).toBeUndefined();
  });

  test("an exit 0 that printed no assistant output fails the turn on the empty verdict", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:silent one" });
    // The silent scenario still writes its hint, so the session exists.
    await waitFor(session.events, of("session_started"), "session_started");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited 0 and printed no assistant output");
    expect(of("error")(session.events)).toBeUndefined();
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
    expect(error.message).toContain("could not spawn the kimi turn process");
    expect(error.message).toContain("the binary is gone");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("an overflow raised mid-effect-list queues behind it: the spawn runs, the crash ends, the child is reaped (al11, al29)", async () => {
    // The reviewer's trigger, one level down: 1,023 rejected inputs under
    // a blocked sink park the outbound queue one short of its event bound,
    // the valid line's ack lands the 1,024th entry, and the turn_started
    // emission is the enqueue that trips the bound. Round al29's rule
    // changed what happens next: the overflow's fatal event is QUEUED —
    // a nested event may not abort the effect list that raised it — so
    // the transition's own effects complete first (the spawn IS
    // requested), and the crash end dispatches after them, stopping the
    // child it now owns before done resolves. The pre-al29 order this
    // test pinned (no spawn at all) was the aborted-effect-list design
    // al29 replaced: an aborted list leaves effects half-run by
    // construction.
    const session = await startSession({
      sink: () => new Promise<void>(() => {}),
    });
    for (let i = 0; i < 1023; i++) {
      send(session.driver, { type: "interrupt" });
    }
    send(session.driver, { type: "user", text: "scenario:basic one" });
    expect(await session.code).toBe(1);
    // The effect list completed before the crash event dispatched: one
    // spawn was requested, and its child settled BEFORE done — the end
    // path stopped it, so nothing lands after cleanup. The fake writes
    // its argv and prompt records synchronously at startup, but the
    // killing end can stop the child before its first line runs — the
    // stop races the interpreter's own startup — so the records are not
    // guaranteed to land and the milestones are the spawn evidence;
    // asserting the records here would pin that race.
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a synchronous spawn throw under a blocked, near-full queue still completes the hold (al37)", async () => {
    // Round al37, edges major 1 — the opencode repro at this rig's queue
    // arithmetic: a caller that stopped reading parks the outbound queue
    // one short of its ordinary bound (1,023 rejected acks; the deferred
    // identity means no session_started entry yet), the valid line's ack
    // lands the 1,024th entry, and the next turn-opening emit's refusal
    // trips the bound — the overflow fatal parks behind the effect list
    // (the al29 rule) while the spawn effect still has to run. The CLI's
    // real closure can throw SYNCHRONOUSLY (validateRunRequest refuses
    // the per-turn request before any promise exists), and the killing
    // end the parked fatal dispatches then abandons the in-flight spawn:
    // finishDone waits on the hold past done before releasing the record
    // and taking the signal handlers down. No continuation exists to
    // release that hold — the throw arm itself completes it; before al37
    // the wait hung forever, signalsDisposed stayed false, and the
    // registry record never released.
    const session = await startSession({
      sink: () => new Promise<void>(() => {}),
      spawnTurn: () => {
        throw new Error("the per-turn validation failed");
      },
    });
    for (let i = 0; i < 1023; i++) {
      send(session.driver, { type: "interrupt" });
    }
    send(session.driver, { type: "user", text: "scenario:basic one" });
    // The parked fatal's crash end: code 1, resolved once the stopped
    // sink's flush give-up lands — not held behind the abandoned spawn.
    expect(await session.code).toBe(1);
    // The two facts the hung wait could never reach, read off the driver
    // (the blocked sink delivers nothing to wait on): the hold completed
    // and the signal handlers came down.
    const internals = session.driver as unknown as {
      holdDone: boolean;
      signalsDisposed: boolean;
    };
    const deadline = Date.now() + 5_000;
    while (!internals.holdDone || !internals.signalsDisposed) {
      if (Date.now() > deadline) {
        throw new Error(
          `the hold never completed (holdDone ${internals.holdDone}, ` +
            `signalsDisposed ${internals.signalsDisposed})`
        );
      }
      await Bun.sleep(5);
    }
    expect(internals.holdDone).toBe(true);
    expect(internals.signalsDisposed).toBe(true);
  }, 10_000);
});

describe("kimi session e2e - honest false capabilities", () => {
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
    expect(await session.code).toBe(1);
  });

  test("the /goal command and ! shape are rejected unsupported before the ack; every other /-leading text runs (al17)", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "/goal create ship it" });
    send(session.driver, { type: "user", text: "  !ls" });
    const rejections = await waitFor(
      session.events,
      (events) =>
        events.filter(
          (event) =>
            event.type === "input_rejected" && event.reason === "unsupported"
        ).length >= 2
          ? events.filter(
              (event) =>
                event.type === "input_rejected" && event.reason === "unsupported"
            )
          : undefined,
      "the two unsupported rejections"
    );
    expect(rejections.map((event) => event.input_seq)).toEqual([1, 2]);
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(0);

    // Every other /-leading text is model text in 0.31.1 (the al17
    // major: the al11 rule refused a path-like prompt outright), so it
    // runs its turn like any prompt.
    send(session.driver, { type: "user", text: "/tmp/notes.md please summarize" });
    const pathEcho = await waitFor(session.events, of("user_message"), "user_message");
    expect(pathEcho.text).toBe("/tmp/notes.md please summarize");
    const pathTurn = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(pathTurn.finish).toBe("end");
    expect(fakeRecord(session, "prompts.jsonl")[0]!.text).toBe(
      "/tmp/notes.md please summarize"
    );

    // The author prefix sits ahead of the shape, so the same text under
    // one is model prompt text and runs.
    send(session.driver, { type: "user", text: "/goal here", author: "ana" });
    const echo = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "user_message" && event.text === "/goal here"),
      "user_message"
    );
    expect(echo).toBeDefined();
    const completed = await waitFor(
      session.events,
      (events) =>
        events.filter((event) => event.type === "turn_completed").length >= 2
          ? events.filter((event) => event.type === "turn_completed")[1]
          : undefined,
      "the second turn_completed"
    );
    expect(completed.finish).toBe("end");
    expect(fakeRecord(session, "prompts.jsonl")[1]!.text).toBe("[ana] /goal here");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a text past the argv bound is rejected text_too_long before the ack", async () => {
    // The prompt rides `--prompt` on argv, so the run path's 32 KiB argv
    // bound — not the protocol's 16 MiB text bound — is the per-turn
    // cap, checked before the ack: an accepted line the turn process
    // cannot be handed would hang its turn open.
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
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("a whitespace-only user text is rejected unsupported before the ack, so kimi's own refusal never runs (al22)", async () => {
    // The correctness major: the driver accepted a whitespace-only prompt
    // and launched its turn, but kimi's headless entry validates the
    // prompt before anything runs and refuses a blank one before a
    // session exists — no resume hint can close the turn, so a fresh
    // session died on the missing-id fatal (mocked repro: exit 1) instead
    // of telling the caller the line was refused. The refusal sits beside
    // the command-shape one now, judged before the ack: no turn is
    // launched for text the harness itself would refuse.
    const session = await startSession();
    send(session.driver, { type: "user", text: "   " });
    const rejected = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "input_rejected"),
      "the unsupported rejection"
    );
    expect(rejected.reason).toBe("unsupported");
    expect(rejected.input_seq).toBe(1);
    // Nothing launched: no spawn record, no prompt, and no turn or session
    // announcement exists to answer.
    expect(fakeRecord(session, "argv.jsonl")).toHaveLength(0);
    expect(fakeRecord(session, "prompts.jsonl")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    expect(session.events.filter((event) => event.type === "session_started")).toHaveLength(0);

    // The session is untouched by the refusal: a real prompt still
    // identifies the session through its closing hint and ends clean.
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("session_started"), "session_started");
    const completed = await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(completed.finish).toBe("end");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the author prefix rides the prompt argv", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic hi", author: "ana" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(fakeRecord(session, "prompts.jsonl")[0]!.text).toBe("[ana] scenario:basic hi");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});

describe("kimi session e2e - stream tiers", () => {
  test("a non-JSON line is a tier-3 fatal crash", async () => {
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:garbage junk" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("unusable harness output (not JSON");
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
  });

  test("a hint naming a foreign session on a fresh session's second turn is a tier-2 fatal with the raw preserved", async () => {
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
            event.raw.includes(OTHER)
        ),
      "the raw passthrough"
    );
    expect(unknown.session_id).toBe(ID);
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain(OTHER);
    expect(error.message).toContain(ID);
    expect(await session.code).toBe(1);
    // The foreign hint withdraws the confirmation the first turn's hint
    // earned (round al11's re-review, edges 3): the store that answered
    // named another session, so the crash must not end resumable —
    // before the fix the stale confirmation kept resumable:true, telling
    // a retrying caller one more --resume could work.
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
  });

  test("a resumed session whose first hint names a foreign id is fatal and never rebound (al2)", async () => {
    // The seam this pins: a session resumed with a registry-vouched id
    // must not adopt a different id from a resume hint — kimi starting a
    // fresh session instead of resuming would otherwise rebind the record
    // and every later turn to an id the caller never chose. In this
    // resumed-session shape the refusal is the PARSER's mismatch check
    // (parseKimiStreamLine's knownSessionId: a hint naming another id is
    // a grammar_error, fatal on arrival); the driver's adoptSessionId is
    // the checked-invariant backup for the fresh-session arm and never
    // runs here (round al23 corrects this comment's earlier credit).
    // End to end: fatal naming both ids, exit 1, one session_started
    // carrying the resumed id throughout.
    const session = await startSession({ resumeSessionId: ID });
    // The resumed identity is announced before any turn.
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect(started.session_id).toBe(ID);
    send(session.driver, { type: "user", text: "scenario:wrongid one" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain(OTHER);
    expect(error.message).toContain(ID);
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    // Never rebound: the one session_started is the resumed id, and no
    // second announcement ever carried the foreign one.
    const starts = session.events.filter((event) => event.type === "session_started");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.session_id).toBe(ID);
  });

  test("a malformed hint, a tool line without an id, and an empty assistant line are tier-2 fatals", async () => {
    for (const [scenario, phrase] of [
      ["badhint", "a resume hint carries an invalid session id"],
      ["notoolid", "a tool line carries no tool_call_id"],
      ["emptyassistant", "an assistant line carries neither content nor tool calls"],
    ] as const) {
      const session = await startSession();
      send(session.driver, { type: "user", text: `scenario:${scenario} probe` });
      const error = await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "error" && event.fatal === true),
        `the ${scenario} fatal`
      );
      expect(error.message).toContain(phrase);
      expect(await session.code).toBe(1);
    }
  });

  test("a tier-2 fatal that fires mid-turn fails the turn, whatever the child's clean exit (al11 re-review)", async () => {
    // The reviewer's shape: an identified session, a second turn that
    // prints its assistant text and then a malformed hint, and a process
    // that exits 0 — the fatal ends the session while the child drains,
    // and before the fix completeTurn read that exit alone (0 with
    // assistant output) and reported the turn `end` after the caller had
    // just been told the harness output was fatally broken. The synthesis
    // owns the turn now: `failed`, carrying the fatal's own story.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:badhint two" });
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure");
    expect(completed.reason).toContain("a resume hint carries an invalid session id");
    expect(await session.code).toBe(1);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.reason).toBe("crash");
  });

  test("a fatal after a valid resume hint is never resumable, every fatal kind (round al20)", async () => {
    // Edges 1: handleFatal withdrew nothing, so a framing or I/O failure
    // that landed after the turn's hint confirmed the session kept the
    // confirmation standing and the crash ended resumable:true — a
    // retrying caller would be sent back into a store whose stream just
    // broke. Every fatal kind clears it now, the same withdrawal parsed
    // drift after a closing hint already earns (round al14) and a
    // foreign-id hint earns with it. "Every" means all four of
    // SessionFatalKind (process.ts): the claim covered only two until
    // round al21's trivial added invalid-utf8 and handler.
    const hint = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: ID,
      command: `kimi -r ${ID}`,
      content: `To resume this session: kimi -r ${ID}`,
    });
    for (const [label, fatal, phrase] of [
      ["line-overflow", { kind: "line-overflow", excerpt: "giant line", bytes: 17_000_000 }, "unusable harness output (line-overflow"],
      ["invalid-utf8", { kind: "invalid-utf8", excerpt: "lossy \u{FFFD}", bytes: 3 }, "unusable harness output (invalid-utf8"],
      ["handler", { kind: "handler", error: new Error("boom in a line handler"), bytes: 40 }, "internal error while processing a harness line"],
      ["read-error", { kind: "read-error", error: new Error("EPIPE: broken pipe"), bytes: 0 }, "reading the harness's stdout failed"],
    ] as const) {
      const session = await startSession();
      send(session.driver, { type: "user", text: "scenario:basic one" });
      await waitFor(session.events, of("turn_completed"), "first turn_completed");
      send(session.driver, { type: "user", text: "scenario:wait hold" });
      await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_started")[1],
        "second turn_started"
      );
      // The turn's own closing hint, delivered the way the process layer
      // would deliver it: it confirms the session for this turn.
      session.driver.handleHarnessLine(hint);
      session.driver.handleFatal(fatal);

      const completed = await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[1],
        `the failed turn_completed (${label})`
      );
      expect(completed.turn_id).toBe("t2");
      expect(completed.finish).toBe("failed");
      expect(completed.reason).toContain("the session ended on a failure before the turn completed");
      expect(completed.reason).toContain(phrase);
      expect(await session.code).toBe(1);
      // session_ended arrives asynchronously after the events awaited above.
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(ended.reason).toBe("harness_failed");
      // The regression's core: the hint had confirmed the session, and the
      // fatal must withdraw that confirmation — before the fix this read
      // true, vouching for a store whose stream just broke.
      expect(ended.resumable).toBe(false);
    }
  });

  test("harness output after a fatal's crash end began is never parsed (round al22)", async () => {
    // Edges 2: a tier-2 fatal's finish("crash") runs asynchronously, so
    // `settled` alone could not tell the drain window — where output is
    // owed — from the window between the fatal and its crash end
    // settling. Output parsed in that window emitted a post-fatal
    // assistant message and re-confirmed the session through a late hint,
    // and the crash ended resumable:true. The reviewer's repro exactly: a
    // malformed assistant frame, then a valid one, then the resume hint.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:postfatal two" });
    const error = await waitFor(
      session.events,
      (events) => events.find((event) => event.type === "error" && event.fatal === true),
      "the fatal error"
    );
    expect(error.message).toContain("an assistant line carries neither content nor tool calls");
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure");
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    // The regression's core, both halves: no assistant message the fatal
    // already disowned (turn one's is the only one), and no late hint
    // re-confirming a session the fatal ended — before the fix both read
    // the other way.
    const texts = session.events
      .filter((event) => event.type === "assistant_message")
      .map((event) => event.text);
    expect(texts).toEqual(["Done: scenario:basic one"]);
    expect(ended.resumable).toBe(false);
  });
});

describe("kimi session e2e - end paths", () => {
  test("stdin close mid-turn reports a non-complying child's signal exit as failed", async () => {
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
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the kimi process exited with signal SIGTERM and named no session id");
    expect(completed.raw).toBeNull();
    expect(completed.usage).toEqual(NULL_USAGE);
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // exit_code is the end path's own code (the stdin-close cause at 0,
    // the same code the process exits with) — the killed child's signal
    // death is the normal kill path and reports nothing of its own (round
    // al29: the code is the cause log's, never a child's stale exit). And
    // the hint never arrived, so nothing was ever identified or recorded,
    // and the unidentified session is not resumable.
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(of("session_started")(session.events)).toBeUndefined();
  });

  test("the shutdown drain delivers the open turn's final output", async () => {
    // The end path gives the turn's process the grace to finish on its
    // own; FAKE_SIGTERM_PERSIST=1 answers the shutdown SIGTERM with the
    // turn's remaining lines before exiting 0, and that drained output
    // must reach the caller (review live5's rule, the turn-per-process
    // shape: no end carrier exists, the signal is the only thing left).
    // Code 0 completes normally even after a recorded stop (al39). The
    // drained reply and hint complete the turn, and the raw outcome
    // rides harness_exit.
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
    // The harness delivered its answer and exited 0 during cleanup.
    expect(completed.finish).toBe("end");
    expect(completed.reason).toBeUndefined();
    expect(completed.usage).toEqual(first.usage);
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("shutdown");
    expect(ended.exit_code).toBe(0);
    expect(ended.harness_exit).toEqual({ code: 0, signal: null });
    // The drained hint confirmed the turn's session, so the store is
    // vouchable.
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
  });

  test("an exit 42 after the drain's recorded stop remains a harness failure (al38)", async () => {
    // The handler exits 42 after SIGTERM. That code matches neither a
    // clean exit nor the recorded signal's coded form, so shutdown fails.
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
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: 42, signal: null });
    expect(of("error")(session.events)?.fatal).toBe(true);
    const completions = session.events.filter((event) => event.type === "turn_completed");
    expect(completions).toHaveLength(2);
    expect(completions[1]!.turn_id).toBe("t2");
    expect(completions[1]!.finish).toBe("failed");
    expect(completions[1]!.reason).toContain("42");
    // The interrupted turn's hint never came: not resumable (al21's rule).
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("an exit 143 after the drain's stop fails the session (al41)", async () => {
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
    expect(ended.reason).toBe("harness_failed");
    // Shutdown intent and the raw child outcome remain separate.
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: 143, signal: null });
    expect(of("error")(session.events)?.fatal).toBe(true);
    const second = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(second.finish).toBe("failed");
    expect(second.reason).toContain("exited with code 143");
    expect(await session.code).toBe(1);
    // The interrupted turn never closed, so its hint never came: not
    // resumable on the FIRST turn's confirmation (round al21, edges 2 —
    // before, this read true).
    expect(ended.resumable).toBe(false);
  });

  test("an idle end after a failed child reports failure on the event, process, and ledger (al41)", async () => {
    // A child failure remains a session failure even after an idle end.
    // The event, process exit, and closing ledger record must agree.
    const ledgerPath = join(mkdtempSync(join(workRoot(), "ledger-")), "calls.jsonl");
    const previousLog = process.env.CODEMUX_CALL_LOG;
    process.env.CODEMUX_CALL_LOG = ledgerPath;
    try {
      const session = await startSession();
      send(session.driver, { type: "user", text: "scenario:basic one" });
      const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
      expect(first.finish).toBe("end");
      send(session.driver, { type: "user", text: "scenario:errorturn" });
      const second = await waitFor(
        session.events,
        (events) => events.filter((event) => event.type === "turn_completed")[1],
        "second turn_completed"
      );
      expect(second.finish).toBe("failed");
      // The session survives the turn's own failure; the shutdown below
      // ends it idle.
      send(session.driver, { type: "shutdown" });
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(ended.reason).toBe("harness_failed");
      expect(ended.exit_code).toBe(1);
      expect(await session.code).toBe(1);
      const records = readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      const closing = records.filter((record) => record.kind === "session");
      expect(closing).toHaveLength(1);
      expect(closing[0]!.exit_code).toBe(1);
      expect(closing[0]!.finish).toBe("harness_failed");
      expect(closing[0]!.session_id).toBe(ID);
    } finally {
      if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
      else process.env.CODEMUX_CALL_LOG = previousLog;
    }
  });

  test("a signaled death during the drain that cleanup did not cause is reported, not swallowed (al25)", async () => {
    // The edges major's drain half: any signaled child exit inside a
    // graceful end used to be read as cleanup's own kill — exit_code
    // null, turn "interrupted", session exit 0 — so a child killed by
    // anyone else (an operator, an OOM killer) vanished from the verdict
    // entirely. FAKE_DRAIN_SELFKILL models it: turn one identifies the
    // session, turn two stays open, and the child SIGKILLs itself 100 ms
    // after its stdin closed — while the drain is still awaiting the
    // turn's answer, before cleanup has signaled anything. The death
    // belongs to the turn's verdict and raises the session's code; only
    // a signal cleanup itself sent stays the suppressed kill (the
    // wrapper-143 test above, and the normal kill path).
    const session = await startSession({}, { FAKE_DRAIN_SELFKILL: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited with signal SIGKILL");
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("the kimi process exited with signal SIGKILL");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The external death recorded a crash cause at 1: exit_code is that
    // raised code, matching the process exit (round al29; the child's
    // signal death itself carries no code of its own).
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("an external SIGTERM's coded 143 during the drain is reported, not exempted (al26)", async () => {
    // Exit 143 fails the session regardless of who requested shutdown.
    // FAKE_DRAIN_EXIT143: the child exits 143 on its own 100 ms
    // after its stdin closed, inside the drain's answer wait — before
    // requestStop ever runs.
    const session = await startSession({}, { FAKE_DRAIN_EXIT143: "1" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    // The turn's own verdict fails on the exit code the child chose.
    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the failed turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toBe("the kimi process exited with code 143");
    // The drain fatal names the coded spelling and whose death it was.
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("the kimi process exited with code 143");
    expect(fatal?.fatal).toBe(true);
    // session_ended follows the failed turn_completed asynchronously, so
    // it is awaited rather than assumed to be the last event already.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The external coded 143 recorded a crash cause at 1: exit_code is
    // that raised code, matching the process exit (round al29; the
    // child's own 143 is the turn's verdict above).
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a SIGKILL after only a recorded SIGTERM remains a harness failure (al38)", async () => {
    // The child kills itself before cleanup's SIGKILL timer fires.
    // Its signal does not match the recorded SIGTERM.
    // FAKE_SIGTERM_PERSIST=selfkill: the wait-scenario child survives the
    // grace without answering, takes the drain's SIGTERM, and dies to its
    // own SIGKILL.
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "selfkill" });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.exit_code).toBe(1);
    expect(ended.harness_exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(session.events.find((event) => event.type === "error")?.fatal).toBe(true);
    const completed = session.events.filter((event) => event.type === "turn_completed")[1] as Event;
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("SIGKILL");
    // The last turn never confirmed (no hint), so the store is not
    // vouchable (al21's rule).
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a confirmed session whose open turn is cut by EOF with the drain expired ends not resumable (al21)", async () => {
    // The finding's shape: turn one confirms the session (hint adopted,
    // registry recorded), turn two opens, and the caller's stdin closes
    // before the turn completes. The drain expires without an answer —
    // the child dies to the stop signal, no hint is written — and the
    // session ends clean: exit 0, the turn interrupted. Before al21 the
    // synthesized completion left sawUnconfirmedTurnFailure unset, so
    // the clean-end fallback reported resumable on the strength of an
    // earlier turn's hint, vouching for a store whose LAST turn may
    // never have persisted.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const first = await waitFor(session.events, of("turn_completed"), "first turn_completed");
    expect(first.finish).toBe("end");
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t2");
    // The faithful verdict: interrupted, the real cause named — never a
    // synthesized success.
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the kimi process exited with signal SIGTERM");
    expect(completed.usage).toEqual(NULL_USAGE);
    expect(await session.code).toBe(1);
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    // The clean end's own code: the child's signal death was observed
    // after the drain's recorded stop, so by ordering it is the
    // shutdown's and costs nothing (rounds al29, al37).
    expect(ended.exit_code).toBe(1);
    // Recorded and once confirmed, but the last turn supplied no hint:
    // not resumable.
    expect(ended.resumable).toBe(false);
  });

  test("caller input during the shutdown drain is rejected shutting_down, never dropped", async () => {
    // The drain window exists only while a turn is open (an idle session
    // settles at once), so the late input must land inside one.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "user", text: "scenario:wait two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "second turn_started"
    );
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
    // seq 1 and 2 were the two accepted user lines, 3 the shutdown.
    expect(rejection.input_seq).toBe(4);
    expect(await session.code).toBe(1);
  });

  test("a confirmed session whose start was never recorded is not resumable", async () => {
    // Review live22's agy sibling: the first hint adopts the id and
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
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("crash");
    expect(ended.resumable).toBe(false);
    expect(session.events.some((event) => event.type === "session_started")).toBe(false);
    expect(session.events.every((event) => event.session_id === "")).toBe(true);
    expect(session.events.some((event) => event.raw?.includes("session.resume_hint"))).toBe(false);
  });

  test("the session timeout is honored while the turn's spawn is in flight; the late child is killed on landing (D5, al23)", async () => {
    // A timeout while the turn's spawn is still in flight (the 250 ms
    // hold models the slow scode gate — the probes the spawn closure
    // runs before any child exists). Round al23 (edges 2): the absolute
    // --timeout is no longer stretched by that wait. The end path
    // ABANDONS the in-flight spawn and resolves done at the deadline;
    // the late child is stopped by the hold (spawnContinuation's
    // abandoned arm, settleChild) when it
    // lands, its exit codemux's own kill, not a turn verdict — and
    // session_ended's exit_code is the end path's own code (the timeout
    // cause's 1, round al29), never a child's. Before al23 the end path
    // awaited the spawn, so the deadline
    // waited with it (and a spawn that never settled kept the session
    // from ending at all — the next test pins that half). A graceful
    // end still runs the late child instead (review D11), pinned by the
    // test after next.
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
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("timeout");
    // The timeout cause's own code, the same one the process exits with
    // (round al29 — never a child's exit, and no child landed yet).
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    // The al23 ordering: done resolved at the deadline, BEFORE the spawn
    // landed (100 ms timeout against a 250 ms hold) — the session's end
    // no longer waits on the in-flight spawn.
    expect(session.order).toEqual(["done"]);
    // The abandoned spawn is not leaked: exactly one child landed, was
    // stopped rather than run — no assistant output was ever accepted —
    // and its tree settled after done.
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
  });

  test("a spawn that never settles cannot keep the session open past the timeout (al23)", async () => {
    // The edges major's far half: the end path awaited the in-flight
    // spawn unconditionally, so a spawn that never settled — probes hung
    // past their own timeouts — kept session_ended, the registry
    // release, the signal-handler cleanup, and run() resolution away
    // from the caller entirely. The abandonment closes this too: with
    // nothing to await, the timeout ends the session on schedule. The
    // eternal promise models the hung spawn; no child ever exists, so
    // there is nothing to stop and nothing leaks.
    const session = await startSession({
      sessionTimeoutMs: 100,
      spawnTurn: () => new Promise<SessionProcess>(() => {}),
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("the session ended (timeout)");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("timeout");
    // The timeout cause's own code, matching the process exit (round
    // al29 — no child ever existed to report).
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    // Nothing ever spawned, and done still resolved.
    expect(session.order).toEqual(["done"]);
  });

  test("a stdin close while the turn's spawn is still in flight runs that turn to completion (review D11, correctness 2 1)", async () => {
    // The exact trigger: one prompt, then immediate EOF — `printf one
    // user line | codemux session -a kimi -s` — where the scode gate
    // holds the turn's spawn when the close arrives (the 250 ms hold
    // models that window). A graceful end owes that pending turn its
    // run: the prompt already rides the late child's argv, so the end
    // path runs it through the landed path's drain, settled before done
    // resolves.
    const session = await startSession({}, {}, 250, 1, STARTUP_GRACE_MS);
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
    // The harness confirmed the session (its hint named the id inside
    // the drain), so the graceful end stays resumable.
    expect(ended.resumable).toBe(true);
    expect(await session.code).toBe(0);
    // The prompt actually reached the late child — the regression's
    // core — and it settled before done resolved.
    expect(fakeRecord(session, "prompts.jsonl")).toEqual([
      { text: "scenario:basic one" },
    ]);
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  }, 10_000);

  test("a signal while a graceful end awaits the turn's spawn cuts the wait; the late child is killed on landing (round al18, reshaped by al25)", async () => {
    // The correctness review's major (round al18): a SIGTERM arriving
    // after a graceful end entered the spawn wait only raised endExitCode
    // — the late child still landed into the graceful run and got its
    // prompt's full pre-stop grace. al18 stopped the child through the
    // landed check while the end still WAITED for it; round al25 (edges
    // major) cuts the wait itself, so the escalated end can never hang on
    // a spawn that does not settle: done resolves at the signal, and the
    // late child — landing after it — is stopped, never run to
    // completion. Before al18 the same sequence ran the turn to "end"
    // and reported the child's own exit 0.
    const session = await startSession({}, {}, 400);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    process.kill(process.pid, "SIGTERM");

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("before the turn completed");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    // The end path's own reason stands (the stdin close started it); the
    // exit code is the signal cause's — the one later cause the end path
    // met, the same code the process exits with — and the killed child's
    // exit is codemux's own, reported nothing of its own (round al29).
    expect(ended.reason).toBe("stdin-close");
    expect(ended.exit_code).toBe(SESSION_SIGNAL_EXIT_CODE);
    expect(await session.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    // The al25 ordering: done resolved at the signal, BEFORE the spawn
    // landed (the 400 ms hold is the slow scode gate) — the escalation
    // cut the wait instead of sitting in it.
    expect(session.order).toEqual(["done"]);
    // The abandoned spawn is not leaked: the child landed, was stopped
    // rather than run — no assistant output was ever accepted — and its
    // tree settled after done.
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
  });

  test("a session timeout that fires while a graceful end awaits the turn's spawn is enforced, not stretched (al25)", async () => {
    // The correctness major: cleanup used to clear the session timer
    // BEFORE awaiting the in-flight spawn, so the caller's absolute
    // --timeout could never fire while the wait ran — a 60 ms timeout
    // against a 200 ms spawn hold ended past 200 ms with exit 0, reason
    // stdin-close, the deadline stretched by whatever the spawn closure
    // did. The timer stays armed through the wait now and the timeout's
    // escalation cuts it: done resolves at the deadline with a nonzero
    // code, and the late child is stopped on landing, never run.
    const session = await startSession({ sessionTimeoutMs: 60 }, {}, 200);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.finish).toBe("interrupted");
    expect(completed.reason).toContain("the session ended (stdin-close) before the turn completed");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    // The timeout's raised code: the graceful end's 0 is gone.
    expect(await session.code).toBe(1);
    // The deadline was not stretched: done resolved before the spawn
    // landed (60 ms timeout against a 200 ms hold).
    expect(session.order).toEqual(["done"]);
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
  });

  test("a spawn that never settles cannot outlast a timeout that fires during a graceful end's wait (al25)", async () => {
    // The far half of the same major: the graceful end awaited the
    // in-flight spawn unconditionally, so a spawn that never settled —
    // probes hung past their own timeouts — kept session_ended, the
    // registry release, the signal handlers, and run() resolution away
    // from the caller forever, with the timer already cleared. The cut
    // closes that too: with nothing to land, the timeout ends the
    // session on schedule. The eternal promise models the hung spawn.
    const session = await startSession({
      sessionTimeoutMs: 100,
      spawnTurn: () => new Promise<SessionProcess>(() => {}),
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
    expect(session.order).toEqual(["done"]);
  });

  test("the session timer stays armed through the graceful drain: a hanging child cannot outlive --timeout (al27)", async () => {
    // Edges major 2, the drain half al25 left open: cleanup cleared the
    // session timer BEFORE the drain, so a timeout could cut the spawn
    // wait but never the drain after it — a landed child that hung
    // (scenario:wait) drained through the stop grace past the deadline
    // while the session reported a clean shutdown at exit 0. The timer
    // stays armed through the drain now: the 400 ms deadline fires inside
    // the drain's answer wait (closed at ~20 ms, grace 500 ms), the
    // escalation raises the end code and awaitEndAnswer's raised-verdict
    // predicate cuts the wait at once, and the session ends 1.
    const session = await startSession({ sessionTimeoutMs: 400 });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain(
      "the kimi process exited with signal SIGTERM and named no session id"
    );
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.shutdown_requested).toBe(true);
    expect(ended.exit_code).toBe(1);
    expect(await session.code).toBe(1);
    // The drain settled the stopped child before done resolved: the end
    // was cut by the deadline, not stretched through the whole grace.
    expect(session.order).toEqual(["spawned", "settled", "done"]);
  });

  test("a killing end holds the registry record until the abandoned spawn can no longer create a child (al27)", async () => {
    // Edges major 1: the end path released the registry record in its own
    // tail — before the abandoned spawn settled — so a concurrent
    // `--resume` could claim the session and write the store while the
    // late child was still to land, run, and write it too. The release
    // now defers behind the lateSpawnSettled tracker, past done: the
    // record keeps its live-looking owner until the late child has
    // settled, and only then is the end stamped. Turn one runs prompt
    // (the record exists); turn two's spawn is held in flight when the
    // signal arrives.
    const session = await startSession({}, {}, 250, 2);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[0],
      "the first turn_completed"
    );
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_started")[1],
      "the second turn_started"
    );
    process.kill(process.pid, "SIGTERM");

    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("signal");
    expect(await session.code).toBe(SESSION_SIGNAL_EXIT_CODE);
    // The al23 ordering still holds: done resolved at the signal, before
    // the held second spawn landed (turn one's milestones precede).
    expect(session.order).toEqual(["spawned", "settled", "done"]);
    // The record is STILL HELD at done — the spawn is in flight, so a
    // child may still be created for this session.
    const entryOf = ():
      | { ended: string | null }
      | undefined => {
      const registry = readRegistry(session.options.registryPath as string);
      return registry.outcome === "ok"
        ? (registry.file.sessions.find((r) => r.id === ID) as { ended: string | null })
        : undefined;
    };
    const held = entryOf();
    expect(held).toBeDefined(); // the record exists and is still live
    expect(held!.ended).toBeNull();
    // The abandoned spawn is not leaked: it lands, is stopped rather than
    // run, and settles.
    const deadline = Date.now() + 8_000;
    while (session.order.length < 5) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual([
      "spawned",
      "settled",
      "done",
      "spawned",
      "settled",
    ]);
    expect(
      session.events.filter((event) => event.type === "assistant_message").length
    ).toBe(1);
    // Past that settling the record releases: the end is stamped only
    // once no child of this session can be created anymore.
    const stampDeadline = Date.now() + 8_000;
    for (;;) {
      const entry = entryOf();
      if (entry !== undefined && entry.ended !== null) break;
      if (Date.now() > stampDeadline) {
        throw new Error(`timed out waiting for the deferred registry release`);
      }
      await Bun.sleep(10);
    }
  });

  test("a fatal escalation while a graceful end awaits the turn's spawn cuts the wait (al25)", async () => {
    // The edges major's third escalation: a crash end arriving while the
    // graceful spawn wait runs — here a codemux-side read failure
    // reported through the driver's fatal channel, the same seam round
    // al20 drove — must cut the wait like a signal or timeout does, or
    // a stuck spawn would block the crash end's own cleanup forever.
    const session = await startSession({}, {}, 400);
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    session.driver.handleFatal({
      kind: "read-error",
      error: new Error("EPIPE: broken pipe"),
      bytes: 0,
    });

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("reading the harness's stdout failed");
    expect(await session.code).toBe(1);
    // The crash cut the wait: done resolved before the spawn landed.
    expect(session.order).toEqual(["done"]);
    const deadline = Date.now() + 8_000;
    while (session.order.length < 3) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the late child; order: ${session.order.join(",")}`);
      }
      await Bun.sleep(10);
    }
    expect(session.order).toEqual(["done", "spawned", "settled"]);
  });

  test("a stdin read failure while the end path drains is fatal, not a drained close (round al20)", async () => {
    // Correctness 1: the graceful end (exit 0) had begun — the turn open,
    // the drain waiting — when the caller's stdin READ failed. Before the
    // fix that failure landed in the nonfatal note arm of the finished
    // branch: the exit stayed 0 and the session reported success after its
    // input channel broke. The failure now pairs with the fatal the
    // settled arm reports and raises the code through finish's monotone
    // escalation the way a cancellation does: the drain stops waiting, the
    // open turn's synthesis reads failed, and the session exits 1 with
    // the failure named.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn_started");
    session.driver.handleCallerEnd();
    session.driver.handleCallerEnd(new Error("EPIPE: broken pipe"));

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("the session ended on a failure before the turn completed");
    expect(completed.reason).toContain("reading the caller's stdin failed");
    expect(completed.reason).toContain("EPIPE: broken pipe");
    const fatal = session.events.find((event) => event.type === "error" && event.fatal === true);
    expect(fatal?.message).toContain("reading the caller's stdin failed");
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("harness_failed");
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("a stdin read failure closes the graceful drain: no harness line is accepted after the fatal (al23)", async () => {
    // The edges major: the fatal the al20 arm reports left the drain
    // OPEN — the end reason stayed stdin-close and no escalation ran,
    // so harness lines kept arriving into applyParse. The fake's persist
    // mode makes the window real: the drain's stop signal is answered
    // with a valid assistant line and the closing hint (exactly the
    // output the grace exists to deliver), and before the fix that line
    // was emitted as a post-fatal assistant_message while the late hint
    // re-confirmed the session and flipped the end resumable. The fatal
    // now closes the drain the same way every other fatal does: the
    // drained answer is accepted nowhere, and the session ends with the
    // error.
    // A long grace so the fake always answers and exits 0 inside it: the
    // end reason is then the fatal's own, not a timing-dependent kill
    // (a 500 ms grace under load let the kill timer fire first and the
    // reason flip to harness_failed; CI's faster runner saw stdin-close).
    const session = await startSession({}, { FAKE_SIGTERM_PERSIST: "1" }, 0, 1, 5_000);
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    // turn_started is the driver's own spawn event; the fake's SIGTERM
    // handler exists only once its module has run, which its startup
    // record proves. Ending before that kills a fake that has not armed
    // itself and the reason flips to harness_failed (seen locally under
    // load; CI's faster runner saw the armed fake answer and exit 0).
    const armed = join(session.stateDir, "argv.jsonl");
    for (let i = 0; i < 200 && !existsSync(armed); i++) await Bun.sleep(25);
    expect(existsSync(armed)).toBe(true);
    session.driver.handleCallerEnd();
    session.driver.handleCallerEnd(new Error("EPIPE: broken pipe"));

    const completed = await waitFor(
      session.events,
      of("turn_completed"),
      "the synthesized turn_completed"
    );
    expect(completed.turn_id).toBe("t1");
    expect(completed.finish).toBe("failed");
    expect(completed.reason).toContain("reading the caller's stdin failed");
    // The drained answer arrived after the fatal — and was accepted
    // nowhere: no assistant message, no re-confirmation, no resumable
    // end.
    expect(session.events.find((event) => event.type === "assistant_message")).toBeUndefined();
    // session_ended arrives asynchronously after the events awaited above.
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    // A child that answered and exited 0 is no harness failure (al41): the
    // caller's stdin read failure is the end's own reason, with its code 1.
    expect(ended.reason).toBe("stdin-close");
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });

  test("the session timeout ends an idle session", async () => {
    const session = await startSession({ sessionTimeoutMs: 150 });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.reason).toBe("timeout");
    // An idle end's code is its cause's own (round al29): the timeout's
    // 1, matching the process exit — no turn ran, so no child code
    // exists to report in the first place.
    expect(ended.exit_code).toBe(1);
    expect(ended.resumable).toBe(false);
    expect(await session.code).toBe(1);
  });
});
