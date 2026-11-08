/**
 * Driver e2e for the kimi session (design §4.7): identity and resume —
 * the deferred identity model (session_started waits for the first turn's
 * resume hint), the --session resume, per-turn model selection, and the
 * turn verdicts that withdraw or restore the store's confirmation. Split
 * from tests/session-kimi-e2e.test.ts; the rig is tests/helpers/
 * session-kimi-e2e.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import { currentProcessIdentity } from "../src/session/registry-io.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  type Event,
  ID,
  NULL_USAGE,
  OTHER,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

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

  test("a busy registry lock on the first turn's record retries off the stream instead of freezing it (round 341)", async () => {
    // The record of a fresh session's identity runs when the first turn's
    // closing hint names it — inside the live output stream. A rival's
    // live held lock on the registry used to freeze the whole event loop
    // for the lock's full ~10 s budget mid-turn; the record now takes one
    // attempt, says so once, and retries on a timer while the turns keep
    // running, and once the rival is gone the record lands and the
    // deferred session_started follows.
    const session = await startSession();
    const registryPath = session.options.registryPath as string;
    const lockPath = `${registryPath}.lock`;
    const identity = currentProcessIdentity();
    const rival = join(
      dirname(lockPath),
      `.${basename(lockPath)}.${identity.pid}.${randomBytes(8).toString("hex")}.held`
    );
    writeFileSync(rival, `${identity.pid}\n${identity.start ?? ""}\n`, { mode: 0o600 });
    const notices: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      notices.push(args.map(String).join(" "));
    };
    try {
      send(session.driver, { type: "user", text: "scenario:basic one" });
      // While the lock is still held: both turns complete — the stream
      // never froze — and the deferred announcement has not come.
      await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t1"),
        "turn_completed t1",
        3_000
      );
      send(session.driver, { type: "user", text: "scenario:basic two" });
      await waitFor(
        session.events,
        (events) => events.find((event) => event.type === "turn_completed" && event.turn_id === "t2"),
        "turn_completed t2",
        3_000
      );
      expect(notices.filter((line) => line.includes("registry lock is busy recording session"))).toHaveLength(1);
      expect(session.events.find((event) => event.type === "session_started")).toBeUndefined();
      // The rival goes away; the next timer retry records and the
      // deferred announcement follows, before the session ends cleanly.
      rmSync(rival);
      await waitFor(session.events, of("session_started"), "session_started", 4_000);
      send(session.driver, { type: "shutdown" });
      await waitFor(session.events, of("session_ended"), "session_ended");
      expect(await session.code).toBe(0);
      const registry = readRegistry(registryPath);
      expect(
        registry.outcome === "ok" && registry.file.sessions.some((record) => record.id === ID)
      ).toBe(true);
    } finally {
      console.error = originalError;
      rmSync(rival, { force: true });
    }
  });
});
