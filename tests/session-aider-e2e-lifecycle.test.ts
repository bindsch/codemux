/** Driver e2e tests for the aider session, lifecycle split (from
 * tests/session-aider-e2e.test.ts): the minted-UUID identity, the
 * two-turn history exchange, resume and its bounds, the author prefix,
 * reply extraction, and the argv text bound. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_HISTORY_BYTES } from "../src/aider-history.js";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  fakeRecord,
  messageArg,
  of,
  send,
  startSession,
  UUID,
  waitFor,
  workRoot,
  type Event
} from "./helpers/session-aider-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

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
    // rode argv while the decline stream rode stdin — whole 128-byte
    // blocks, no EOF while the child lived (the repeating carrier,
    // review round 153).
    expect(readFileSync(session.historyPath, "utf8")).toContain("#### scenario:basic one");
    expect(messageArg(session, 0)).toBe("--message=scenario:basic one");
    const stdin = fakeRecord(session, "stdin.jsonl")[0];
    expect(stdin?.eof).toBe(false);
    expect(stdin?.bytes % 128).toBe(0);
    expect(stdin?.bytes).toBeGreaterThanOrEqual(128);
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
