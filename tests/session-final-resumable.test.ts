/**
 * The --final verdict (review round 7, edges finding 1): a project-settings
 * session launched with --final has its private config directory removed
 * by the CLI right after session_ended, so the driver reports
 * `resumable: false` — a resume would open a fresh, transcript-less
 * directory. Without --final the verdict stays true.
 */
import { afterAll, expect, test } from "bun:test";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-e2e.js";

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("a --final session ends not resumable; an ordinary session stays resumable", async () => {
  // The CLI passes `final` only for a project-settings session
  // (cli-request.ts refuses the flag otherwise), so the driver options
  // here are exactly that combination.
  const finalSession = await startSession({ projectSettings: true, final: true });
  send(finalSession.driver, { type: "user", text: "scenario:basic hello" });
  await waitFor(finalSession.events, of("turn_completed"), "turn_completed");
  send(finalSession.driver, { type: "shutdown" });
  const finalEnded = await waitFor(finalSession.events, of("session_ended"), "session_ended");
  expect(finalEnded.reason).toBe("shutdown");
  expect(finalEnded.resumable).toBe(false);
  expect(await finalSession.code).toBe(0);

  const plain = await startSession();
  send(plain.driver, { type: "user", text: "scenario:basic hello" });
  await waitFor(plain.events, of("turn_completed"), "turn_completed");
  send(plain.driver, { type: "shutdown" });
  const ended = await waitFor(plain.events, of("session_ended"), "session_ended");
  expect(ended.reason).toBe("shutdown");
  expect(ended.resumable).toBe(true);
  expect(await plain.code).toBe(0);
});
