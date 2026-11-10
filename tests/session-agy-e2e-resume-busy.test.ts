/**
 * The pending-record verdict (review round 345) applies to FRESH sessions:
 * a resumed one is tracked by the record the CLI's claim wrote before the
 * spawn, so a run-start record that never lands behind a busy lock must
 * not turn its clean end into a crash (review round 356). Split from the
 * lifecycle file, which sits near the 500-line cap.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { currentProcessIdentity } from "../src/session/registry-io.js";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  
} from "./helpers/session-agy-e2e.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
}, 20_000);

test("a resumed agy session whose run-start record stays behind a busy lock ends cleanly (review 356)", async () => {
  // The rival's live lock is in place before the run starts, so the
  // run-start record's one attempt is busy and its retries never land;
  // the CLI's claim (adoptResumeClaim) is what tracks the session.
  const registryDir = mkdtempSync(join(tmpdir(), "codemux-resume-busy-"));
  const registryPath = join(registryDir, "live-sessions.json");
  const identity = currentProcessIdentity();
  const rival = join(
    registryDir,
    `.${basename(`${registryPath}.lock`)}.${identity.pid}.${randomBytes(8).toString("hex")}.held`
  );
  writeFileSync(rival, `${identity.pid}\n${identity.start ?? ""}\n`, { mode: 0o600 });
  const notices: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    notices.push(args.map(String).join(" "));
  };
  try {
    const session = await startSession({ resumeConversationId: "conv-res-7", registryPath });
    session.driver.adoptResumeClaim();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed", 3_000);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    expect(ended.reason).not.toBe("crash");
    expect(session.events.find((event) => event.type === "error" && event.fatal === true)).toBeUndefined();
    expect(notices.some((line) => line.includes("cannot record the session in the registry"))).toBe(false);
  } finally {
    console.error = originalError;
    rmSync(rival, { force: true });
    rmSync(registryDir, { recursive: true, force: true });
  }
}, 20_000);

test("a resumed agy session whose record budget exhausts mid-session emits the notice and keeps running (round 361, item 16)", async () => {
  // The rival's live lock never releases and the retry budget is cut to
  // two attempts of 20 ms, so the run-start record's exhaustion lands
  // while the session is live — the test above never reaches that path:
  // its retries stop at the summary. A resumed session is tracked by its
  // claim, so the exhaustion is one stderr notice plus the deferred
  // announcement, and the session runs its turn and ends cleanly
  // instead of crashing mid-run.
  const registryDir = mkdtempSync(join(tmpdir(), "codemux-resume-busy-"));
  const registryPath = join(registryDir, "live-sessions.json");
  const identity = currentProcessIdentity();
  const rival = join(
    registryDir,
    `.${basename(`${registryPath}.lock`)}.${identity.pid}.${randomBytes(8).toString("hex")}.held`
  );
  writeFileSync(rival, `${identity.pid}\n${identity.start ?? ""}\n`, { mode: 0o600 });
  const notices: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    notices.push(args.map(String).join(" "));
  };
  try {
    const session = await startSession({
      resumeConversationId: "conv-res-7",
      registryPath,
      registryStartBudget: { attempts: 2, retryMs: 20 },
    });
    session.driver.adoptResumeClaim();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed", 3_000);
    // The exhaustion must land while the session is live (the premise
    // above): it answers with the announcement, so wait for it before
    // the shutdown. Sending the shutdown at turn_completed raced the
    // 20 ms retry: an ended session drops its pending record retries,
    // and no session_started was ever emitted (2 of 6 runs in an
    // ubuntu:26.04 container).
    await waitFor(session.events, of("session_started"), "session_started", 3_000);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(await session.code).toBe(0);
    expect(ended.reason).not.toBe("crash");
    expect(session.events.find((event) => event.type === "error" && event.fatal === true)).toBeUndefined();
    expect(session.events.find((event) => event.type === "session_started")).toBeDefined();
    expect(notices.filter((line) => line.includes("the retry budget is spent"))).toHaveLength(1);
    expect(notices.some((line) => line.includes("conv-res-7") && line.includes("claim stays the record"))).toBe(true);
  } finally {
    console.error = originalError;
    rmSync(rival, { force: true });
    rmSync(registryDir, { recursive: true, force: true });
  }
}, 20_000);
