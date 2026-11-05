import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { CALL_LOG_ENV, type CallRecord } from "../src/call-log.js";
import { ListingRing, collectSessionWithTurn, registerCallsCommand, windowKeeps } from "../src/calls-command.js";
import { CallTotals } from "../src/calls-totals.js";
import { BASE_RECORD } from "./helpers/call-log.js";
import { iso, MINUTE, record } from "./helpers/calls-records.js";

// The listing, the window, and the totals run in one streaming pass whose
// memory stays bounded however long the ledger is (review round 22): the
// ring holds at most `-n` records, the totals hold per-session state only,
// and the window keeps nothing but session ids. These tests prove the
// bound directly and prove the outputs unchanged at a few hundred
// thousand records.

const HOUR = 60 * MINUTE;
const OLD_RUNS = 150_000;
const NEW_RUNS = 150_000;
const SESSIONS = 40;

describe("the calls listing ring", () => {
  test("keeps at most `limit` records however many are pushed, newest, oldest first", () => {
    const ring = new ListingRing<number>(20);
    for (let i = 1; i <= 300_000; i++) ring.push(i);
    expect(ring.items()).toHaveLength(20);
    expect(ring.items()).toEqual(
      Array.from({ length: 20 }, (_, i) => 299_981 + i)
    );
  });

  test("holds every record while fewer than `limit` have been pushed", () => {
    const ring = new ListingRing<string>(5);
    for (const item of ["a", "b", "c"]) ring.push(item);
    expect(ring.items()).toEqual(["a", "b", "c"]);
  });
});

describe("the calls totals accumulator", () => {
  // i%3 picks the kind, i%40 the session; gcd(3, 40) is 1, so every one of
  // the 40 sessions sees both closings and turns as i runs.
  const recordAt = (i: number): CallRecord => ({
    ...BASE_RECORD,
    kind: i % 3 === 0 ? "session" : i % 3 === 1 ? "session_turn" : "run",
    session_id: `s-${i % SESSIONS}`,
    usage: { ...BASE_RECORD.usage, input_tokens: 1 },
  });

  test("retains one closing record per session, not the history, over 300000 adds", () => {
    const totals = new CallTotals();
    let early = -1;
    for (let i = 0; i < 300_000; i++) {
      totals.add(recordAt(i));
      // Every session has had a closing well before the history grows.
      if (i === 399) early = totals.retained;
    }
    expect(early).toBe(SESSIONS);
    expect(totals.retained).toBe(SESSIONS);
  });

  test("the grouped accumulator holds the same per-session bound across groups", () => {
    // Session i%40 always lands in group i%20 (40 is a multiple of 20), so
    // each session lives in exactly one group.
    const totals = new CallTotals("wf");
    for (let i = 0; i < 300_000; i++) {
      totals.add({ ...recordAt(i), labels: { wf: `g-${i % 20}` } });
    }
    expect(totals.retained).toBe(SESSIONS);
  });

  test("accumulates 300000 records into the same one totals line", () => {
    const totals = new CallTotals();
    for (let i = 0; i < 300_000; i++) totals.add(recordAt(i));
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      totals.print();
    } finally {
      log.mockRestore();
    }
    expect(lines).toHaveLength(1);
    // Closings fold away from the fields their turns reported: the 200000
    // non-session records carry the tokens, one closing per session held.
    expect(lines[0]).toContain("Totals over 200040 record(s)");
    expect(lines[0]).toContain("input=200,000");
  });
});

describe("codemux calls streams a few hundred thousand records in bounded memory", () => {
  // Append order: old runs, new runs, sessions begun before the cutoff with
  // a turn inside it (closing record after its turns, the writer's order),
  // sessions wholly outside the window, and five marker runs last so the
  // listing's newest records are identifiable.
  async function bigLedger(): Promise<{ path: string; done: () => void }> {
    const dir = mkdtempSync(join(tmpdir(), "codemux-calls-bounded-"));
    const path = join(dir, "calls.jsonl");
    const writer = Bun.file(path).writer();
    const oldRun = record({ ts: iso(24 * HOUR), input: 1, output: 1, total: 2, model: "oldrun" });
    const newRun = record({ ts: iso(MINUTE), input: 2, output: 1, total: 3, model: "newrun" });
    for (let i = 0; i < OLD_RUNS; i++) writer.write(`${oldRun}\n`);
    for (let i = 0; i < NEW_RUNS; i++) writer.write(`${newRun}\n`);
    for (let i = 0; i < SESSIONS; i++) {
      // Began 90 minutes ago (outside a 1h window), ran a turn 30 minutes
      // ago (inside), closed after that turn with the session's cost.
      writer.write(
        `${record({ ts: iso(90 * MINUTE), kind: "session_turn", sessionId: `in-${i}`, input: 1, output: 1, total: 2 })}\n`
      );
      writer.write(
        `${record({ ts: iso(30 * MINUTE), kind: "session_turn", sessionId: `in-${i}`, input: 3, output: 1, total: 4 })}\n`
      );
      writer.write(
        `${record({ ts: iso(90 * MINUTE), kind: "session", sessionId: `in-${i}`, input: 300, output: 100, total: 400, cost: 0.25 })}\n`
      );
    }
    for (let i = 0; i < SESSIONS; i++) {
      // Wholly outside the window: neither the turns nor the closing count.
      writer.write(
        `${record({ ts: iso(3 * HOUR), kind: "session_turn", sessionId: `out-${i}`, input: 50, output: 1, total: 51 })}\n`
      );
      writer.write(
        `${record({ ts: iso(3 * HOUR), kind: "session", sessionId: `out-${i}`, input: 500, output: 10, total: 510, cost: 5.0 })}\n`
      );
    }
    for (let i = 1; i <= 5; i++) {
      writer.write(`${record({ ts: iso(0), model: `marker-${i}`, input: 9, output: 1, total: 10 })}\n`);
    }
    await writer.end();
    return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function runCalls(
    path: string,
    args: string[]
  ): Promise<{ out: string[]; err: string[]; code: number }> {
    const captured: { out: string[]; err: string[]; code: number } = { out: [], err: [], code: 0 };
    const out = console.log;
    const err = console.error;
    const previous = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = path;
    console.log = (line: string) => void captured.out.push(line);
    console.error = (line: string) => void captured.err.push(line);
    try {
      const program = new Command();
      registerCallsCommand(program, (code) => {
        captured.code = code;
      });
      await program.parseAsync(["calls", ...args], { from: "user" });
    } finally {
      console.log = out;
      console.error = err;
      if (previous === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previous;
    }
    return captured;
  }

  test(
    "lists the newest -n, sums every record, and applies --since exactly",
    async () => {
      const { path, done } = await bigLedger();
      try {
        // The listing keeps only the newest 5 of 300205 records: the five
        // markers, newest first, raw lines under --json.
        const json = await runCalls(path, ["-n", "5", "--json"]);
        const printed = json.out.filter((line) => line !== "");
        expect(printed).toHaveLength(5);
        expect(printed.map((line) => JSON.parse(line).model)).toEqual([
          "marker-5", "marker-4", "marker-3", "marker-2", "marker-1",
        ]);

        // The table path lists the same newest records without raw lines.
        const table = await runCalls(path, ["-n", "3", "--since", "1h"]);
        const rows = table.out.filter((line) => line !== "");
        expect(rows).toHaveLength(4); // header plus three rows
        expect(rows[1]).toContain("marker-5");
        expect(rows[3]).toContain("marker-3");
        expect(table.out.join("\n")).not.toContain("oldrun");

        // The totals see every record: all runs, both session shapes, and
        // every closing folded to the fields its turns left unreported.
        const sum = await runCalls(path, ["--sum"]);
        const totals = sum.out.find((line) => line.startsWith("Totals"))!;
        expect(totals).toBeDefined();
        expect(totals).toContain("Totals over 300205 record(s)");
        // 150000x1 + 150000x2 + 5x9 markers + 40x50 out turns + 40x4 in
        // turns; every closing's input is folded out by its turns.
        expect(totals).toContain("input=452,205");
        // Only the closings carry cost: 40x$5.00 outside, 40x$0.25 inside.
        expect(totals).toContain("cost=$210.0000");
        expect(totals).toContain("80 session summaries folded");

        // The window is exact over the whole ledger: the new runs, the
        // markers, and the in-window turns with their closings (kept by the
        // turn seen before the closing, which follows its turns); the old
        // runs and the wholly outside sessions stay out.
        const windowed = await runCalls(path, ["--sum", "--since", "1h"]);
        const windowTotals = windowed.out.find((line) => line.startsWith("Totals"))!;
        expect(windowTotals).toBeDefined();
        expect(windowTotals).toContain("Totals over 150085 record(s)");
        // 150000x2 + 5x9 markers + 40x3 turns; the closings' 300 folded out.
        expect(windowTotals).toContain("input=300,165");
        expect(windowTotals).toContain("cost=$10.0000");
        expect(windowTotals).toContain("40 session summaries folded");
      } finally {
        done();
      }
    },
    120_000
  );

  test("a resumed session's first closing is kept when only later turns fall inside --since (round 23, edges 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-calls-resumed-"));
    const path = join(dir, "calls.jsonl");
    const writer = Bun.file(path).writer();
    // The ordering the one-pass window mishandled: an old turn, the first
    // closing, the resumed turn INSIDE the window, the second closing.
    // The first closing arrives before the in-window turn, so a pass that
    // decided each closing on arrival dropped it.
    writer.write(`${record({ ts: iso(90 * MINUTE), kind: "session_turn", sessionId: "res-1", input: 1, output: 1, total: 2 })}\n`);
    writer.write(`${record({ ts: iso(90 * MINUTE), kind: "session", sessionId: "res-1", input: 100, output: 10, total: 110, cost: 1.0, model: "closing-first" })}\n`);
    writer.write(`${record({ ts: iso(30 * MINUTE), kind: "session_turn", sessionId: "res-1", input: 3, output: 1, total: 4 })}\n`);
    writer.write(`${record({ ts: iso(90 * MINUTE), kind: "session", sessionId: "res-1", input: 300, output: 30, total: 330, cost: 2.0, model: "closing-second" })}\n`);
    await writer.end();
    try {
      // The listing keeps BOTH closings: the newest first, then the one
      // that arrived before the in-window turn.
      const json = await runCalls(path, ["-n", "20", "--json", "--since", "1h"]);
      const lines = json.out.filter((line) => line !== "").map((line) => JSON.parse(line));
      expect(lines.filter((entry) => entry.kind === "session").map((entry) => entry.model))
        .toEqual(["closing-second", "closing-first"]);
      // The totals' fold still keeps only the newest closing per session —
      // but both were in the window, so the older one is named superseded,
      // not silently absent from the pass.
      const sum = await runCalls(path, ["--sum", "--since", "1h"]);
      const totals = sum.out.find((line) => line.startsWith("Totals"))!;
      expect(totals).toContain("1 superseded session summary excluded");
      // The newest closing's cost is the one that lands.
      expect(totals).toContain("cost=$2.0000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the --since window during the second pass", () => {
  test("a turn appended after the first pass still admits its closing (round 26, edges 3)", () => {
    // The first pass saw nothing of this session; the second pass meets the
    // in-window turn, then the closing whose own ts is the session's start,
    // before the cutoff. Adding during the pass keeps it.
    const cutoff = new Date(iso(10 * HOUR));
    const set = new Set<string>();
    // iso() counts time AGO: the turn is one hour old (inside a ten-hour
    // window), the closing's start twenty hours old (outside).
    const turn: CallRecord = { ...BASE_RECORD, kind: "session_turn", session_id: "late", ts: iso(1 * HOUR) };
    const closing: CallRecord = { ...BASE_RECORD, kind: "session", session_id: "late", ts: iso(20 * HOUR) };
    expect(windowKeeps(closing, cutoff, set)).toBe(false);
    collectSessionWithTurn(turn, cutoff, set);
    expect(windowKeeps(turn, cutoff, set)).toBe(true);
    expect(windowKeeps(closing, cutoff, set)).toBe(true);
  });

  test("a shared session id across agents does not admit another agent's old closing (round 127)", () => {
    // The window keys sessions by agent and session id together. Under the
    // id alone, a recent turn of one agent admitted an old closing record
    // of a different agent that happened to share the id, pulling records
    // the cutoff should have kept out.
    const cutoff = new Date(iso(10 * HOUR));
    const set = new Set<string>();
    const turn: CallRecord = { ...BASE_RECORD, kind: "session_turn", session_id: "shared", ts: iso(1 * HOUR) };
    const sameAgentClosing: CallRecord = { ...BASE_RECORD, kind: "session", session_id: "shared", ts: iso(20 * HOUR) };
    const otherAgentClosing: CallRecord = { ...BASE_RECORD, agent: "codex", kind: "session", session_id: "shared", ts: iso(20 * HOUR) };
    collectSessionWithTurn(turn, cutoff, set);
    expect(windowKeeps(turn, cutoff, set)).toBe(true);
    // Same agent, same id: the session's own old closing is admitted.
    expect(windowKeeps(sameAgentClosing, cutoff, set)).toBe(true);
    // Another agent sharing the id is a different session: its closing
    // stays behind the cutoff.
    expect(windowKeeps(otherAgentClosing, cutoff, set)).toBe(false);
  });
});

