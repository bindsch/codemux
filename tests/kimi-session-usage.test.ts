/**
 * The kimi session's per-turn usage read (the session.usage parity cell):
 * the print wire names no counts, so the executor reads the session's
 * wire log after each turn's child settles — the log accumulates every
 * turn of the native session, so a turn's own counts are the delta
 * against the previous read, and a resumed session seeds the baseline
 * with the prior turns' totals at construction. Every failure (no log,
 * no session id, unreadable totals) reports the honest all-null block:
 * usage is reporting, never a verdict.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiSessionDriver, type KimiDriverOptions } from "../src/session/kimi-driver.js";
import { kimiPrivateBrandHome } from "../src/kimi-hermetic.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import { FakeTurnProcess, assistantText, hintLine, ID } from "./helpers/session-kimi-interleavings.js";

const NULLS = {
  input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null,
};

/** One usage.record line in the wire log's exact shape (kimi-wire-log.ts
 * parses type "usage.record" with counts inputOther/output/
 * inputCacheRead/inputCacheCreation). */
const record = (inputOther: number, output: number, read: number): string =>
  `${JSON.stringify({ type: "usage.record", usage: { inputOther, output, inputCacheRead: read, inputCacheCreation: 0 } })}\n`;

interface Turn {
  /** What the turn's child appends to the wire log before it exits. */
  append?: string;
  lines?: string[];
}

/** A plain (non-hermetic) session over a scripted spawn: each turn hands
 * the driver a FakeTurnProcess, feeds its lines, appends the turn's wire
 * record, then exits 0 — the driver's read lands on the exit delivery. */
async function driveTurns(
  options: Pick<KimiDriverOptions, "resumeSessionId" | "harnessHome" | "privateHome">,
  brandHome: string,
  wireLog: string,
  turns: Turn[]
): Promise<Array<Record<string, any>>> {
  const events: Array<Record<string, any>> = [];
  let pending: ((child: FakeTurnProcess) => void) | null = null;
  const driver = new KimiSessionDriver({
    resumeSessionId: options.resumeSessionId,
    autonomy: "high",
    cwd: brandHome,
    hermetic: false,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: true,
    sessionTimeoutMs: null,
    registryPath: null,
    harnessHome: options.harnessHome,
    providerBaseUrl: null,
    privateHome: options.privateHome ?? null,
    spawnTurn: () =>
      new Promise((resolve) => {
        pending = resolve as (child: FakeTurnProcess) => void;
      }),
    sink: (line) => {
      events.push(JSON.parse(line) as Record<string, any>);
    },
  });
  const code = driver.run();
  try {
    for (const turn of turns) {
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "probe" }));
      while (pending === null) await Bun.sleep(2);
      const child = new FakeTurnProcess();
      (pending as unknown as (child: FakeTurnProcess) => void)(child);
      pending = null;
      await Bun.sleep(5);
      for (const line of turn.lines ?? [assistantText("answer"), hintLine(ID)]) {
        driver.handleHarnessLine(line);
      }
      if (turn.append !== undefined) {
        // A real child creates its session store before its first
        // write; the turn's append may be the log's first line.
        mkdirSync(join(wireLog, ".."), { recursive: true });
        appendFileSync(wireLog, turn.append);
      }
      child.die({ code: 0, signal: null });
      await Bun.sleep(30);
    }
    driver.handleCallerEnd();
    expect(await code).toBe(0);
    return events;
  } finally {
    driver.dispose();
  }
}

/** The wire log path findKimiWireLog computes for ID under `brandHome`:
 * sessions/<workspace>/<session dir>/agents/main/wire.jsonl. */
function wireLogAt(brandHome: string, contents: string): string {
  const path = join(brandHome, "sessions", "ws", ID, "agents", "main", "wire.jsonl");
  mkdirSync(join(brandHome, "sessions", "ws", ID, "agents", "main"), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe("kimi session usage - the wire-log read", () => {
  test("a resumed session reports each turn's delta, never the prior turns' totals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-usage-resume-"));
    try {
      // The session's earlier turns (before this codemux session resumed
      // it): 100/20/30 already on the log, read as the seed baseline.
      const wireLog = wireLogAt(join(dir, "home"), record(100, 20, 30));
      const events = await driveTurns(
        { resumeSessionId: ID, harnessHome: join(dir, "home") },
        dir,
        wireLog,
        [{ append: record(10, 2, 3) }, { append: record(7, 5, 1) }]
      );
      const completed = events.filter((event) => event.type === "turn_completed");
      expect(completed).toHaveLength(2);
      expect(completed[0]!.usage).toEqual({
        input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15, cost_usd: null,
      });
      expect(completed[1]!.usage).toEqual({
        input_tokens: 7, output_tokens: 5, cached_input_tokens: 1, total_tokens: 13, cost_usd: null,
      });
      // The session's end carries the fold of this session's turns.
      const ended = events.at(-1)!;
      expect(ended.type).toBe("session_ended");
      expect(ended.usage).toEqual({
        input_tokens: 17, output_tokens: 7, cached_input_tokens: 4, total_tokens: 28, cost_usd: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh session without a log reports the all-null block, and a later log still attributes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-usage-fresh-"));
    try {
      // No wire log at all for the first turn: the read fails, the
      // report is nulls (not zeros), and attribution continues once a
      // log exists — the baseline stayed at zero for the fresh session.
      const brandHome = join(dir, "home");
      mkdirSync(brandHome, { recursive: true });
      const wireLog = join(brandHome, "sessions", "ws", ID, "agents", "main", "wire.jsonl");
      const events = await driveTurns(
        { resumeSessionId: null, harnessHome: brandHome },
        dir,
        wireLog,
        [{}, { append: record(4, 1, 0) }]
      );
      const completed = events.filter((event) => event.type === "turn_completed");
      expect(completed[0]!.usage).toEqual(NULLS);
      expect(completed[1]!.usage).toEqual({
        input_tokens: 4, output_tokens: 1, cached_input_tokens: 0, total_tokens: 5, cost_usd: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hermetic session reads the settled private brand home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-usage-hermetic-"));
    try {
      // A resumed hermetic session: the private home is already settled
      // onto its session-keyed name, and the wire log lives under the
      // private brand home inside it — the path a resume computes and
      // the registry records (harness_home).
      const keyed = join(dir, `session-${ID}`);
      const brandHome = kimiPrivateBrandHome(keyed);
      const wireLog = wireLogAt(brandHome, record(50, 9, 2));
      const privateHome: SessionPrivateHome = {
        dir: keyed,
        resumed: true,
        settled: true,
        blockedPaths: [],
        settle() {
          throw new Error("an already-settled home must not settle again");
        },
        remove() {
          throw new Error("the resumed home must not be removed");
        },
      };
      const events = await driveTurns(
        { resumeSessionId: ID, harnessHome: join(dir, "unrelated"), privateHome },
        dir,
        wireLog,
        [{ append: record(10, 2, 3) }]
      );
      const completed = events.find((event) => event.type === "turn_completed");
      expect(completed!.usage).toEqual({
        input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15, cost_usd: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a resumed session whose prior log cannot be read reports nulls forever", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-usage-seedless-"));
    try {
      // The seed read fails (no log), so no turn's counts can be
      // attributed: the first turn reports nulls even though a log
      // exists by its exit — the prior totals are unknown.
      const brandHome = join(dir, "home");
      mkdirSync(brandHome, { recursive: true });
      const wireLog = join(brandHome, "sessions", "ws", ID, "agents", "main", "wire.jsonl");
      const events = await driveTurns(
        { resumeSessionId: ID, harnessHome: brandHome },
        dir,
        wireLog,
        [{ append: record(10, 2, 3) }]
      );
      const completed = events.find((event) => event.type === "turn_completed");
      expect(completed!.usage).toEqual(NULLS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
