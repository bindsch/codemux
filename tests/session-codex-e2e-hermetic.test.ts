/**
 * Driver e2e for the HERMETIC codex session: the private-home option the
 * launcher hands the driver (src/session/private-home-types.ts) — the
 * session_started.private_home report, the registry record's hermetic and
 * harness_home keys (the settled path a --resume computes), the end path's
 * settle of the home once the child is gone, and the fail-closed fold when
 * a settle cannot complete. The spawn argv itself (HOME/CODEX_HOME env
 * prefix) is the CLI's wiring; its builder is pinned in
 * tests/hermetic-session-homes.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import { settledPrivateHomePath } from "../src/session/private-home-key.js";
import { fakePrivateHome, settledPath } from "./helpers/fake-private-home.js";
import {
  cleanupSessions,
  fakeRecord,
  of,
  send,
  startAndWait,
  startSession,
  waitFor,
  waitForRecord,
  type Event,
} from "./session-codex-e2e-helpers.js";

const THREAD = "0123456789abcdef";

afterAll(cleanupSessions);

const registryEntry = (session: { options: { registryPath: string | null } }) => {
  const registry = readRegistry(session.options.registryPath as string);
  expect(registry.outcome).toBe("ok");
  return registry.outcome === "ok"
    ? registry.file.sessions.find((r) => r.id === THREAD)
    : undefined;
};

describe("codex session e2e - hermetic", () => {
  test("the driver sends the AGENTS.md-skip thread config only a hermetic session (round 413, item 1)", async () => {
    // A PLAIN session sends no thread config, so project-doc discovery
    // behaves exactly as a plain codex run's — the parity rule the
    // session canary's control arm needs (the planted AGENTS.md must
    // reach the model without --hermetic).
    const plain = await startAndWait();
    const plainThread = fakeRecord(plain, "requests.jsonl").find(
      (request) => request.method === "thread/start"
    );
    expect(plainThread).toBeDefined();
    expect("config" in plainThread!.params).toBe(false);
    send(plain.driver, { type: "shutdown" });
    expect(await plain.code).toBe(0);

    const home = fakePrivateHome();
    const hermetic = await startAndWait({ privateHome: home, hermetic: true });
    const hermeticThread = fakeRecord(hermetic, "requests.jsonl").find(
      (request) => request.method === "thread/start"
    );
    expect(hermeticThread!.params.config).toEqual({
      project_doc_max_bytes: 0,
      project_doc_fallback_filenames: [],
    });
    send(hermetic.driver, { type: "shutdown" });
    expect(await hermetic.code).toBe(0);
    home.remove();
  });

  test("a hermetic session reports the settled private home, records it, and settles it at the end", async () => {
    const home = fakePrivateHome();
    const session = await startAndWait({ privateHome: home, hermetic: true });
    const started = of("session_started")(session.events) as Event;
    // The report names the settled path — the one a --resume computes —
    // not the run-shaped dir the home was created with.
    expect(started.private_home).toBe(settledPrivateHomePath(home.dir, THREAD));

    // The registry says hermetic and keys the same settled path.
    const entry = registryEntry(session);
    expect(entry?.hermetic).toBe(true);
    expect(entry?.harness_home).toBe(settledPrivateHomePath(home.dir, THREAD));

    // While the session runs, the home is still fresh: the long-lived
    // app-server writes by absolute path through its turns, so the
    // rename waits for the end path.
    expect(home.settled).toBe(false);

    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.resumable).toBe(true);

    // The end path settled the home once the child was gone, and the
    // removal stayed the launcher's (--final / the sweep): the settled
    // directory still exists.
    expect(home.settled).toBe(true);
    expect(existsSync(settledPath(home, THREAD))).toBe(true);
    home.remove();
  });

  test("a hermetic session that never records leaves its private home fresh", async () => {
    const home = fakePrivateHome();
    // A stalled handshake (FAKE_STALL_INIT): the session ends cleanly
    // with no thread, so no record, no id, and no settle — the sweep's
    // abandoned-fresh rule is what reclaims the home.
    const session = await startSession({ privateHome: home }, { FAKE_STALL_INIT: "1" });
    await waitForRecord(session, "requests.jsonl", 1);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(of("session_started")(session.events)).toBeUndefined();
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.resumable).toBe(false);
    expect(home.settled).toBe(false);
    home.remove();
  });

  test("a settle that cannot complete costs resumable and leaves the home run-shaped (fail closed)", async () => {
    const home = fakePrivateHome();
    home.failSettle = true;
    const session = await startAndWait({ privateHome: home });
    send(session.driver, { type: "user", text: "scenario:basic hello" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    // The registry's harness_home names the settled path, which does not
    // exist: the next resume is refused on the missing home instead of
    // failing inside codex — reported honestly here.
    expect(ended.resumable).toBe(false);
    expect(home.settled).toBe(false);
    expect(existsSync(settledPath(home, THREAD))).toBe(false);
    expect(existsSync(home.dir)).toBe(true);
    const entry = registryEntry(session);
    expect(entry?.harness_home).toBe(settledPrivateHomePath(home.dir, THREAD));
    home.remove();
  });

  test("a resumed private home is never resettled and records the keyed path it arrived on", async () => {
    // A resumed home arrives settled; the driver neither settles nor
    // removes it, and the record names the keyed path itself (the
    // settled-path computation is idempotent on an already-keyed dir).
    const dir = settledPrivateHomePath(join(tmpdir(), "codemux-parent", "run-1"), THREAD);
    const session = await startSession({
      resumeThreadId: THREAD,
      privateHome: {
        dir,
        resumed: true,
        settled: true,
        settle: () => {
          throw new Error("a resumed home must not settle");
        },
        remove: () => true,
        blockedPaths: [],
      },
    });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect((started as Event).private_home).toBe(dir);
    const entry = registryEntry(session);
    expect(entry?.harness_home).toBe(dir);
    expect(entry?.hermetic).toBe(true);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.resumable).toBe(true);
  });

  test("a plain session reports private_home: null — the key is always present", async () => {
    // The protocol doc promises the field on every session_started (no
    // omission), so a plain session carries an explicit null.
    const session = await startAndWait();
    const started = of("session_started")(session.events) as Event;
    expect("private_home" in started).toBe(true);
    expect(started.private_home).toBe(null);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});
