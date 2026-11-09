/** Driver e2e tests for the hermetic agy session's private home (the
 * SessionPrivateHome contract, session/private-home-types.ts): the
 * populate-free driver side only — settle at a resumable end, remove of
 * an abandoned fresh home, the resumed-home immunity, the settlement
 * failure's honest verdict, `session_started.private_home`, the
 * registry's hermetic record, and the construction refusal. The homes
 * are the launcher's real openSessionPrivateHome records (no populate —
 * the private-login content has its own suite,
 * tests/agy-session-private-home.test.ts), so the settle and remove
 * semantics run against the shipped implementation, never a fake. */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import { openSessionPrivateHome } from "../src/session/private-home.js";
import { settledAgyHarnessHome } from "../src/session/agy-private-home.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  workRoot,
} from "./helpers/session-agy-e2e.js";
import type { SessionHold } from "../src/session/registry.js";

afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
});

/** One launcher-shaped parent under this suite's root; the sweep
 * consults a stub registry so nothing real is touched. */
function homeParent(): string {
  const parent = join(mkdtempSync(join(workRoot(), "p-")), ".gemini", ".codemux-isolation-probes");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}

const holdStateOf = (_id: string): SessionHold => "held";

function freshHome(parent: string): SessionPrivateHome {
  return openSessionPrivateHome({
    parent,
    resume: false,
    idPattern: /^\S{1,128}$/,
    blockedPaths: [],
    holdStateOf,
  });
}

function resumedHome(parent: string, id: string): SessionPrivateHome {
  mkdirSync(join(parent, `session-${id}`), { mode: 0o700 });
  return openSessionPrivateHome({
    parent,
    sessionId: id,
    resume: true,
    idPattern: /^\S{1,128}$/,
    blockedPaths: [],
    holdStateOf,
  });
}

describe("agy session e2e - hermetic private home", () => {
  test("a fresh resumable end settles the home onto the conversation id and reports it", async () => {
    const parent = homeParent();
    const home = freshHome(parent);
    const runShaped = home.dir;
    const session = await startSession({ hermetic: true, privateHome: home });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    // The SETTLED spelling is reported — the path a --resume computes and
    // the one the home sits on after the end (the codex and kimi drivers'
    // rule). While the session runs, the live directory (the child's
    // HOME) is still the run-shaped one; the canary and probe K require
    // the reported path to exist once the session ended.
    expect(started.private_home).toBe(join(parent, "session-conv-fake-1"));
    expect(started.hermetic).toBe(true);
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(0);
    expect(ended.resumable).toBe(true);
    // Settled: the run-shaped name is gone, the session-keyed one holds
    // the directory a resume computes — the reported path survives.
    expect(existsSync(runShaped)).toBe(false);
    expect(existsSync(join(parent, "session-conv-fake-1"))).toBe(true);
    // The record says hermetic and names the session-keyed state home.
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const record =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "conv-fake-1")
        : undefined;
    expect(record?.hermetic).toBe(true);
    expect(record?.harness_home).toBe(
      join(parent, "session-conv-fake-1", ".gemini", "antigravity-cli")
    );
  });

  test("a fresh non-resumable end removes the abandoned home", async () => {
    const parent = homeParent();
    const home = freshHome(parent);
    const session = await startSession({ hermetic: true, privateHome: home });
    // authfail: a result naming no conversation, then exit 1 — nothing is
    // adopted, the drain fails, and the session is not resumable.
    send(session.driver, { type: "user", text: "scenario:authfail" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.resumable).toBe(false);
    expect(ended.exit_code).toBe(1);
    expect(existsSync(home.dir)).toBe(false);
  });

  test("a resumed home is never removed at the end", async () => {
    const parent = homeParent();
    const home = resumedHome(parent, "conv-fake-1");
    const session = await startSession({
      hermetic: true,
      privateHome: home,
      resumeConversationId: "conv-fake-1",
    });
    send(session.driver, { type: "user", text: "scenario:basic again" });
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.resumable).toBe(true);
    expect(existsSync(join(parent, "session-conv-fake-1"))).toBe(true);
  });

  test("a settlement that fails does not report the session resumable", async () => {
    const parent = homeParent();
    let settles = 0;
    const failing: SessionPrivateHome = {
      dir: join(parent, "run-failing"),
      resumed: false,
      settled: false,
      settle(): void {
        settles += 1;
        throw new Error("synthetic rename refusal");
      },
      remove: () => true,
      blockedPaths: [],
    };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = await startSession({ hermetic: true, privateHome: failing });
      send(session.driver, { type: "user", text: "scenario:basic one" });
      await waitFor(session.events, of("session_started"), "session_started");
      send(session.driver, { type: "shutdown" });
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      expect(settles).toBe(1);
      expect(ended.resumable).toBe(false);
      expect(String(errors.mock.calls.flat().join(" "))).toContain("settlement failed");
      expect(String(errors.mock.calls.flat().join(" "))).toContain("synthetic rename refusal");
    } finally {
      errors.mockRestore();
    }
  });

  test("a hermetic session without a private home is refused at construction", async () => {
    await expect(startSession({ hermetic: true })).rejects.toThrow(
      "a hermetic agy session requires its private home; the launcher passed none"
    );
    // And the refusal is not the general shape: a non-hermetic session
    // never needed one.
    const session = await startSession();
    send(session.driver, { type: "shutdown" });
    await waitFor(session.events, of("session_ended"), "session_ended");
  });

  test("--final removes a fresh home at the end, stamps the record final, and reports not resumable", async () => {
    const parent = homeParent();
    const home = freshHome(parent);
    const session = await startSession({ hermetic: true, privateHome: home, final: true });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(0);
    expect(ended.resumable).toBe(false);
    expect(existsSync(home.dir)).toBe(false);
    expect(existsSync(join(parent, "session-conv-fake-1"))).toBe(false);
    expect(session.driver.finalRemovalRan).toBe(true);
    const registry = readRegistry(session.options.registryPath as string);
    const record =
      registry.outcome === "ok"
        ? registry.file.sessions.find((r) => r.id === "conv-fake-1")
        : undefined;
    expect(record?.final).toBe(true);
    expect(record?.ended).not.toBe(null);
  });

  test("--final removes a resumed home too: the canary's resume-then-final flow", async () => {
    const parent = homeParent();
    const home = resumedHome(parent, "conv-fake-1");
    const session = await startSession({
      hermetic: true,
      privateHome: home,
      final: true,
      resumeConversationId: "conv-fake-1",
    });
    send(session.driver, { type: "user", text: "scenario:basic again" });
    await waitFor(session.events, of("session_started"), "session_started");
    send(session.driver, { type: "shutdown" });
    const ended = await waitFor(session.events, of("session_ended"), "session_ended");
    expect(ended.exit_code).toBe(0);
    expect(ended.resumable).toBe(false);
    expect(existsSync(join(parent, "session-conv-fake-1"))).toBe(false);
  });

  test("a --final removal that fails both attempts settles the kept home, costs exit 1, and stays resumable", async () => {
    const parent = homeParent();
    let attempts = 0;
    // A launcher-shaped home whose removal always refuses, settle intact:
    // after the double failure the end path must settle the kept home, so
    // the removal is the only broken operation (round 413, item 2).
    const real = freshHome(parent);
    const runShaped = real.dir;
    mkdirSync(join(real.dir, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
    const failing: SessionPrivateHome = {
      get dir() {
        return real.dir;
      },
      get resumed() {
        return real.resumed;
      },
      get settled() {
        return real.settled;
      },
      settle: (id) => real.settle(id),
      remove: () => {
        attempts += 1;
        throw new Error("synthetic removal refusal");
      },
      get blockedPaths() {
        return real.blockedPaths;
      },
    };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = await startSession({ hermetic: true, privateHome: failing, final: true });
      send(session.driver, { type: "user", text: "scenario:basic one" });
      await waitFor(session.events, of("session_started"), "session_started");
      send(session.driver, { type: "shutdown" });
      const ended = await waitFor(session.events, of("session_ended"), "session_ended");
      // Two attempts exactly, and the honest verdict: the home is still
      // there and the record is not final, so the promised resume is
      // real — which the settled path must now make true.
      expect(attempts).toBe(2);
      expect(ended.exit_code).toBe(1);
      expect(ended.resumable).toBe(true);
      // The kept home reached the session-keyed name: the run-shaped
      // directory is gone and the settled directory exists, so the path
      // a --resume computes (settledAgyHarnessHome, the registry's
      // harness_home) names an existing directory.
      expect(real.settled).toBe(true);
      expect(existsSync(runShaped)).toBe(false);
      expect(existsSync(join(parent, "session-conv-fake-1"))).toBe(true);
      expect(existsSync(settledAgyHarnessHome(real.dir, "conv-fake-1"))).toBe(true);
      const registry = readRegistry(session.options.registryPath as string);
      const record =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === "conv-fake-1")
          : undefined;
      expect(record?.final).toBe(false);
      expect(record?.harness_home).toBe(settledAgyHarnessHome(real.dir, "conv-fake-1"));
      expect(String(errors.mock.calls.flat().join(" "))).toContain("could not remove the session's private home");
      expect(String(errors.mock.calls.flat().join(" "))).toContain("synthetic removal refusal");
    } finally {
      errors.mockRestore();
    }
  });
});
