/** Driver e2e tests for the agy session, review-audit split (from
 * tests/session-agy-e2e.test.ts): the review live17 idle-drain exits,
 * the live22 registry-record rule, and the live22/live23 audit
 * siblings. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  workRoot,
  type Event
} from "./helpers/session-agy-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
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
    expect(ended.exit_code).toBe(1);
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
