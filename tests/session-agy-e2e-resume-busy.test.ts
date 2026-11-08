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
