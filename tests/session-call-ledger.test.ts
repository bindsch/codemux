/**
 * The session side of the call ledger, end to end: a real AgySessionDriver
 * over the scenario-driven fake agy (tests/fixtures/live/fake-agy-session.ts)
 * runs a two-turn exchange, and the ledger this process points at (the
 * preload's CODEMUX_TEST_LEDGER redirect, overridden here for assertions)
 * carries one
 * session_turn line per completed turn plus one closing session line with
 * the cumulative usage — the same numbers the session_ended event reports,
 * from the same fold.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCallLog, type CallRecord } from "../src/call-log.js";
import { AgySessionDriver, type AgyDriverOptions } from "../src/session/agy-driver.js";
import { SessionProcess } from "../src/session/process.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-agy-session.ts", import.meta.url));

type Event = Record<string, any>;

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

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const clean of cleanups) await clean();
});

describe("the session ledger", () => {
  test("a two-turn session writes two turn records and one closing session record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-session-ledger-"));
    const ledgerPath = join(dir, "calls.jsonl");
    const workDir = join(dir, "work");
    const stateDir = join(dir, "state");
    const registryDir = join(dir, "registry");
    mkdirSync(workDir);
    mkdirSync(stateDir);
    mkdirSync(registryDir, { mode: 0o700 });

    // Redirect this process's ledger so the assertions own the file; the
    // preload's CODEMUX_TEST_LEDGER redirect is overridden here and
    // restored after.
    const previousLog = process.env.CODEMUX_CALL_LOG;
    process.env.CODEMUX_CALL_LOG = ledgerPath;
    const events: Event[] = [];
    const options: AgyDriverOptions = {
      resumeConversationId: null,
      autonomy: "high",
      cwd: workDir,
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
      sink: (line) => {
        events.push(JSON.parse(line) as Event);
      },
    };
    const driver = new AgySessionDriver(options);
    const proc = new SessionProcess({
      command: ["bun", FAKE],
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        FAKE_STATE_DIR: stateDir,
        HOME: dir,
      },
      onLine: (line) => driver.handleHarnessLine(line),
      onFatal: (fatal) => driver.handleFatal(fatal),
      graceMs: 500,
    });
    driver.attach(proc);
    const code = driver.run();
    cleanups.push(async () => {
      driver.dispose();
      proc.requestStop();
      await proc.settled;
      if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
      else process.env.CODEMUX_CALL_LOG = previousLog;
      rmSync(dir, { recursive: true, force: true });
    });

    try {
      const send = (message: unknown): void => {
        driver.handleCallerLine(JSON.stringify(message));
      };
      send({ type: "user", text: "scenario:basic one" });
      await waitFor(events, of("turn_completed"), "first turn_completed");
      send({ type: "user", text: "scenario:basic two" });
      await waitFor(
        events,
        (list) => list.filter((event) => event.type === "turn_completed")[1],
        "second turn_completed"
      );
      send({ type: "shutdown" });
      expect(await code).toBe(0);

      // The ledger: two turn lines, then the closing session line.
      expect(existsSync(ledgerPath)).toBe(true);
      const log = readCallLog(ledgerPath);
      expect(log.malformed).toBe(0);
      const records = log.entries.map((entry) => entry.record as CallRecord);
      expect(records).toHaveLength(3);
      const [turnOne, turnTwo, session] = records as [CallRecord, CallRecord, CallRecord];
      for (const turn of [turnOne, turnTwo]) {
        expect(turn.kind).toBe("session_turn");
        expect(turn.agent).toBe("agy");
        expect(turn.session_id).toBe("conv-fake-1");
        expect(turn.finish).toBe("end");
        expect(turn.exit_code).toBeNull();
        expect(turn.autonomy).toBe("high");
        expect(turn.hermetic).toBe(false);
        expect(turn.sandboxed).toBe(true);
        expect(turn.cwd).toBe(workDir);
        expect(turn.duration_ms).toBeGreaterThanOrEqual(0);
        expect(turn.usage).toEqual({
          input_tokens: 60,
          output_tokens: 20,
          cached_input_tokens: 40,
          total_tokens: 120,
          cost_usd: null,
        });
      }
      expect(turnOne!.turn_id).toBe("t1");
      expect(turnTwo!.turn_id).toBe("t2");
      expect(new Date(turnTwo!.ts).getTime()).toBeGreaterThanOrEqual(new Date(turnOne!.ts).getTime());

      expect(session!.kind).toBe("session");
      expect(session!.turn_id).toBeNull();
      expect(session!.session_id).toBe("conv-fake-1");
      expect(session!.finish).toBe("shutdown");
      expect(session!.exit_code).toBe(0);
      // The cumulative usage session_ended reports, from the same fold:
      // two identical turns summed field-wise, cost still null.
      expect(session!.usage).toEqual({
        input_tokens: 120,
        output_tokens: 40,
        cached_input_tokens: 80,
        total_tokens: 240,
        cost_usd: null,
      });
    } finally {
      // The cleanup in afterAll disposes; the env restore happens there.
    }
  });

  test("two id-less sessions never share a ledger key: codemux's own id, never \"\" (ul6)", async () => {
    // The regression's writer side: agy adopts a conversation id only from
    // a result that names one, and the auth-failure fixture names none
    // ("" parses to null). Both records of such a session used to carry
    // session_id "" — and every id-less session shared that one key, so
    // `calls --sum` merged them into a phantom session. Each driver mints
    // a codemux id at construction and keys its records by it until a
    // result names the conversation.
    const dir = mkdtempSync(join(tmpdir(), "codemux-session-idless-"));
    const ledgerPath = join(dir, "calls.jsonl");
    const workDir = join(dir, "work");
    const stateDir = join(dir, "state");
    mkdirSync(workDir);
    mkdirSync(stateDir);

    const previousLog = process.env.CODEMUX_CALL_LOG;
    process.env.CODEMUX_CALL_LOG = ledgerPath;

    /** One auth-failed session over the fake: a turn answered with an
     * error that names no conversation, then the crash end. Returns the
     * run's own two records (turn, then closing session). */
    const runIdlessSession = async (): Promise<[CallRecord, CallRecord]> => {
      const events: Event[] = [];
      const options: AgyDriverOptions = {
        resumeConversationId: null,
        autonomy: "high",
        cwd: workDir,
        sandboxed: true,
        sandboxTrust: "standard",
        sandboxNoNet: false,
        sandboxScrubEnv: false,
        passEnv: [],
        authorPrefix: true,
        sessionTimeoutMs: null,
        // Unit-test mode: an untracked session never records anyway.
        registryPath: null,
        harnessHome: join(dir, "home"),
        providerBaseUrl: null,
        sink: (line) => {
          events.push(JSON.parse(line) as Event);
        },
      };
      const driver = new AgySessionDriver(options);
      const proc = new SessionProcess({
        command: ["bun", FAKE],
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FAKE_STATE_DIR: stateDir,
          HOME: dir,
        },
        onLine: (line) => driver.handleHarnessLine(line),
        onFatal: (fatal) => driver.handleFatal(fatal),
        graceMs: 500,
      });
      driver.attach(proc);
      const code = driver.run();
      cleanups.push(async () => {
        driver.dispose();
        proc.requestStop();
        await proc.settled;
      });
      driver.handleCallerLine(
        JSON.stringify({ type: "user", text: "scenario:authfail one" })
      );
      await waitFor(events, of("turn_completed"), "authfail turn_completed");
      // The crash end is the honest verdict: an untracked live session
      // must not run (§4.8).
      expect(await code).toBe(1);
      const records = readCallLog(ledgerPath).entries.map(
        (entry) => entry.record as CallRecord
      );
      return [records.at(-2)!, records.at(-1)!] as [CallRecord, CallRecord];
    };

    try {
      const [firstTurn, firstSession] = await runIdlessSession();
      const [secondTurn, secondSession] = await runIdlessSession();

      const log = readCallLog(ledgerPath);
      expect(log.malformed).toBe(0);
      const records = log.entries.map((entry) => entry.record as CallRecord);
      expect(records).toHaveLength(4); // two turns, two closing sessions
      for (const record of records) {
        // Never "" and never null: the shared-key defect's exact shape.
        expect(record.session_id).toBeTruthy();
      }
      expect(firstTurn.kind).toBe("session_turn");
      expect(secondTurn.kind).toBe("session_turn");
      expect(firstSession.kind).toBe("session");
      expect(secondSession.kind).toBe("session");
      // The two sessions never merged: each closing record matches its own
      // turn's key, and the two keys differ.
      expect(firstTurn.session_id).not.toBe(secondTurn.session_id);
      expect(firstSession.session_id).toBe(firstTurn.session_id);
      expect(secondSession.session_id).toBe(secondTurn.session_id);
    } finally {
      if (previousLog === undefined) delete process.env.CODEMUX_CALL_LOG;
      else process.env.CODEMUX_CALL_LOG = previousLog;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
