import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CALL_LOG_ENV } from "../src/call-log.js";
import { runCli } from "./helpers/cli.js";
import { callsWith, iso, ledgerDir, MINUTE, record } from "./helpers/calls-records.js";

describe("codemux calls", () => {
  test("the table shows records newest first with the usage columns", async () => {
    const { stdout, exitCode } = await callsWith(
      [
        record({ ts: iso(30 * MINUTE), agent: "claude", input: 100, output: 5, cached: 10, total: 115, cost: 0.01 }),
        record({ ts: iso(20 * MINUTE), agent: "zai" }),
        record({ ts: iso(10 * MINUTE), agent: "codex", input: 7, output: 3, total: 10 }),
      ],
      []
    );
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(4); // header plus three rows
    expect(lines[0]).toContain("TIMESTAMP");
    expect(lines[0]).toContain("COST");
    // Newest first: codex's record is the first row.
    expect(lines[1]).toContain("codex");
    expect(lines[2]).toContain("zai");
    expect(lines[3]).toContain("claude");
    // An unreported usage block shows dashes, never zeros.
    expect(lines[2]!.match(/ -  +/g)?.length).toBeGreaterThan(0);
  });

  test("the table strips escapes and control characters a stored record still carries (ul6)", async () => {
    // A ledger written before the store-side strip (call-log.ts, review
    // ul6) may hold terminal controls in a harness-reported model name or
    // finish reason; printing them raw would replay them into the
    // operator's terminal. The table sanitizes at render; --json keeps
    // the stored bytes verbatim by contract.
    const dirty = "claude-\x1b[31mopus";
    const { stdout } = await callsWith(
      [
        record({ ts: iso(2 * MINUTE), modelEffective: dirty }),
        // exit_code null so the finish reason is the rendered EXIT cell.
        record({ ts: iso(MINUTE), agent: "zai", exitCode: null, finish: "end\x07" }),
      ],
      []
    );
    expect(stdout).toContain("claude-opus");
    expect(stdout).not.toContain("\x1b");
    expect(stdout).not.toContain("\x07");
  });

  test("--limit caps the shown records after filtering", async () => {
    // i=0 is the oldest (5 minutes ago); even i is claude, odd is zai.
    const lines = Array.from({ length: 5 }, (_, i) =>
      record({ ts: iso((5 - i) * MINUTE), agent: i % 2 === 0 ? "claude" : "zai" })
    );
    const { stdout } = await callsWith(lines, ["-n", "2"]);
    const rows = stdout.split("\n").filter((line) => line !== "");
    expect(rows).toHaveLength(3); // header plus two rows
    // The newest two are indexes 4 and 3, shown newest first.
    expect(rows[1]).toContain("claude");
    expect(rows[2]).toContain("zai");
  });

  test("twenty records show by default; a longer ledger truncates from the old end", async () => {
    // i=0 is the oldest (25 minutes ago) and carries m-25.
    const lines = Array.from({ length: 25 }, (_, i) =>
      record({ ts: iso((25 - i) * MINUTE), model: `m-${25 - i}` })
    );
    const { stdout } = await callsWith(lines, []);
    const rows = stdout.split("\n").filter((line) => line !== "");
    expect(rows).toHaveLength(21); // header plus twenty rows
    expect(rows[1]).toContain("m-1"); // the newest survived
    expect(rows[20]).toContain("m-20"); // the fifth-oldest, not the oldest: the old end went
    expect(stdout).not.toContain("m-25");
  });

  test("-a filters to one agent", async () => {
    const { stdout, exitCode } = await callsWith(
      [
        record({ ts: iso(3 * MINUTE), agent: "claude" }),
        record({ ts: iso(2 * MINUTE), agent: "zai" }),
        record({ ts: iso(MINUTE), agent: "zai" }),
      ],
      ["-a", "zai"]
    );
    expect(exitCode).toBe(0);
    const rows = stdout.split("\n").filter((line) => line !== "");
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => !row.includes("claude") || row.includes("TIMESTAMP"))).toBe(true);
  });

  test("-a refuses an unknown agent", async () => {
    const { stderr, exitCode } = await callsWith(
      [record({ ts: iso(MINUTE) })],
      ["-a", "nope"]
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("Unknown agent 'nope'");
  });

  test("--since takes a duration and an ISO timestamp", async () => {
    const lines = [
      record({ ts: iso(5 * 60 * MINUTE), model: "old" }),
      record({ ts: iso(MINUTE), model: "new" }),
    ];
    const recent = await callsWith(lines, ["--since", "1h"]);
    expect(recent.stdout).toContain("new");
    expect(recent.stdout).not.toContain("old");

    const sinceIso = await callsWith(lines, [
      "--since",
      new Date(Date.now() - 2 * MINUTE).toISOString(),
    ]);
    expect(sinceIso.stdout).toContain("new");
    expect(sinceIso.stdout).not.toContain("old");
  });

  test("--since refuses a value that is neither duration nor timestamp (ul7: exit 64, a usage error)", async () => {
    const { stderr, exitCode, stdout } = await callsWith([record({ ts: iso(MINUTE) })], [
      "--since",
      "whenever",
    ]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--since must be a duration");
    expect(stdout).toBe("");
  });

  test("--since refuses a duration whose cutoff overflows the date range, never a silent empty table (ul7)", async () => {
    // The ul7 defect: the overflow produced an invalid Date unchecked, so
    // every record failed the window comparison and the command exited 0
    // with "no matching calls" — an empty answer to a mistyped window.
    const { stderr, exitCode, stdout } = await callsWith(
      [record({ ts: iso(MINUTE) })],
      ["--since", "999999999999999999999999d"]
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--since must be a duration");
    expect(stderr).toContain("date range");
    expect(stdout).toBe("");
    expect(stderr).not.toContain("no matching calls");
  });

  test("--since keeps a session whose turns are inside even when its closing record predates the window (ul6)", async () => {
    // A closing `session` record's ts is the session's START. A session
    // that began before the cutoff and ran turns inside the window is the
    // claude family's whole cost story — every turn reports cost null, the
    // closing record alone carries it — so the window keeps the closing
    // record when any turn of the same session is inside, and the same
    // fold counts it once beside those turns.
    const { stdout } = await callsWith(
      [
        // s1 started 90 minutes ago (outside the 1h window)...
        record({ ts: iso(90 * MINUTE), kind: "session_turn", sessionId: "s1", input: 5, output: 1, total: 6 }),
        // ...ran a turn 30 minutes ago (inside)...
        record({ ts: iso(30 * MINUTE), kind: "session_turn", sessionId: "s1", input: 10, output: 2, total: 12 }),
        // ...and closed with the session-lifetime cost (ts is still the
        // start, outside the window).
        record({ ts: iso(90 * MINUTE), kind: "session", sessionId: "s1", input: 15, output: 3, total: 18, cost: 0.05 }),
        // A session wholly outside the window stays out, closing included.
        record({ ts: iso(120 * MINUTE), kind: "session_turn", sessionId: "s2", input: 100, output: 20, total: 120 }),
        record({ ts: iso(120 * MINUTE), kind: "session", sessionId: "s2", input: 100, output: 20, total: 120, cost: 9.0 }),
        // So does a plain run from before the cutoff.
        record({ ts: iso(120 * MINUTE), model: "oldrun" }),
      ],
      ["--since", "1h", "--sum"]
    );
    // The turn outside the window is not shown; the closing record is.
    expect(stdout).not.toContain("oldrun");
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    // The shown turn's tokens, the closing record's cost, counted once —
    // before ul6 the closing record was dropped and the cost read unknown.
    expect(totals).toContain("Totals over 2 record(s)");
    expect(totals).toContain("input=10");
    expect(totals).toContain("total=12");
    expect(totals).toContain("cost=$0.0500");
    expect(totals).not.toContain("input=25");
    expect(totals).not.toContain("cost=$9.0");
  });

  test("--json prints the raw lines, newest first", async () => {
    const lines = [
      record({ ts: iso(2 * MINUTE), agent: "claude", input: 1 }),
      record({ ts: iso(MINUTE), agent: "zai", input: 2 }),
    ];
    const { stdout } = await callsWith(lines, ["--json"]);
    const printed = stdout.split("\n").filter((line) => line !== "");
    expect(printed).toHaveLength(2);
    expect(JSON.parse(printed[0]!).agent).toBe("zai");
    expect(printed[0]).toBe(lines[1]);
    expect(printed[1]).toBe(lines[0]);
  });

  test("wrong-shaped JSON lines are skipped and counted like corrupt ones (ul2)", async () => {
    // Lines that parse but are not records: one missing its usage block,
    // one with a wrong-typed field. Both must land in the malformed
    // count — the old three-field check accepted them and every reader
    // that trusted the shape crashed.
    const noUsage = JSON.stringify({ ts: iso(MINUTE), agent: "claude", kind: "run" });
    const badField = JSON.stringify({
      ...JSON.parse(record({ ts: iso(MINUTE) })),
      duration_ms: "soon",
    });
    const { stdout, stderr, exitCode } = await callsWith(
      [noUsage, badField, record({ ts: iso(MINUTE), agent: "zai", input: 4, output: 1, total: 5 })],
      ["--sum"]
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("skipped 2 unparseable line(s)");
    expect(stdout).toContain("zai");
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toContain("input=4");
    expect(totals).toContain("Totals over 1 record(s)");
  });

  test("corrupt lines are skipped and counted, never fatal", async () => {
    const { stdout, stderr, exitCode } = await callsWith(
      ["not json", record({ ts: iso(MINUTE), agent: "zai" }), "{broken"],
      []
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("zai");
    expect(stderr).toContain("skipped 2 unparseable line(s)");
  });

  test("an absent ledger is a note, not an error", async () => {
    const dir = ledgerDir();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["calls"],
        { [CALL_LOG_ENV]: join(dir, "absent.jsonl") }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("no calls recorded yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disabled ledger fails with the reason", async () => {
    const { stderr, exitCode } = await runCli(["calls"], { [CALL_LOG_ENV]: "off" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("disabled");
  });

  test("--limit refuses zero, negatives, and non-integers", async () => {
    for (const bad of ["0", "-3", "two", "100001"]) {
      const { stderr, exitCode } = await callsWith([record({ ts: iso(MINUTE) })], [
        "-n",
        bad,
      ]);
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--limit must be an integer");
    }
  });

  test("no matching records is a note with exit 0", async () => {
    const { stdout, stderr, exitCode } = await callsWith(
      [record({ ts: iso(MINUTE), agent: "claude" })],
      ["-a", "zai"]
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("no matching calls");
  });
});
