import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { CALL_LOG_ENV } from "../src/call-log.js";
import { parseSinceOption, registerCallsCommand } from "../src/calls-command.js";
import { runCli } from "./helpers/cli.js";

// `codemux calls` reads the ledger the rest of the suite writes through
// the preload's CODEMUX_TEST_LEDGER redirect; these tests point the
// command at their own ledger files instead, so every option is
// exercised against known contents.

function ledgerDir(): string {
  return mkdtempSync(join(tmpdir(), "codemux-calls-ledger-"));
}

interface RecordSpec {
  ts: string;
  agent?: string;
  kind?: string;
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  total?: number | null;
  cost?: number | null;
  model?: string | null;
  modelEffective?: string | null;
  finish?: string | null;
  exitCode?: number | null;
  sessionId?: string | null;
}

function record(spec: RecordSpec): string {
  return JSON.stringify({
    ts: spec.ts,
    kind: spec.kind ?? "run",
    agent: spec.agent ?? "claude",
    model: spec.model ?? null,
    model_effective: spec.modelEffective ?? null,
    provider: "default",
    session_id: spec.sessionId ?? null,
    turn_id: null,
    autonomy: "read-only",
    hermetic: false,
    sandboxed: false,
    exit_code: spec.exitCode ?? 0,
    finish: spec.finish ?? null,
    duration_ms: 10,
    cwd: "/repo",
    usage: {
      input_tokens: spec.input ?? null,
      output_tokens: spec.output ?? null,
      cached_input_tokens: spec.cached ?? null,
      total_tokens: spec.total ?? null,
      cost_usd: spec.cost ?? null,
    },
  });
}

async function callsWith(
  lines: string[],
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = ledgerDir();
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    return await runCli(["calls", ...args], { [CALL_LOG_ENV]: path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MINUTE = 60_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

describe("parseSinceOption", () => {
  test("durations subtract from now", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    expect(parseSinceOption("90m", now)!.toISOString()).toBe("2026-10-08T10:30:00.000Z");
    expect(parseSinceOption("7d", now)!.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(parseSinceOption("30s", now)!.toISOString()).toBe("2026-10-08T11:59:30.000Z");
    expect(parseSinceOption("2w", now)!.toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });

  test("an ISO timestamp passes through; anything else is refused", () => {
    expect(parseSinceOption("2026-10-01T00:00:00Z")!.getTime())
      .toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseSinceOption("yesterday")).toBeNull();
    expect(parseSinceOption("1x")).toBeNull();
  });

  test("a duration whose cutoff overflows the date range is refused, never an invalid Date (ul7)", () => {
    // The ul7 defect: only the ISO branch checked its Date, so a huge
    // duration returned an invalid Date unchecked — every window
    // comparison against NaN is false, and the command answered a silent
    // empty table at exit 0.
    expect(parseSinceOption("99999999999999w")).toBeNull();
    expect(parseSinceOption("999999999999999999999999d")).toBeNull();
    // A duration that lands inside the range still works, however large.
    const now = new Date("2026-10-08T12:00:00.000Z");
    expect(parseSinceOption("100000w", now)!.toISOString()).toBe(
      new Date(Date.parse("2026-10-08T12:00:00.000Z") - 100000 * 604_800_000).toISOString()
    );
  });
});

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
    expect(exitCode).toBe(1);
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

  test("--sum totals the shown records and counts the unreported as unknown, never zero", async () => {
    const { stdout } = await callsWith(
      [
        record({ ts: iso(3 * MINUTE), input: 100, output: 5, total: 105, cost: 0.02 }),
        record({ ts: iso(2 * MINUTE), input: 50, output: 5, total: 55, cost: 0.01 }),
        record({ ts: iso(MINUTE) }), // a harness that reported nothing
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    expect(totals).toContain("input=150");
    expect(totals).toContain("input=150");
    expect(totals).toContain("output=10");
    expect(totals).toContain("total=160");
    expect(totals).toContain("cost=$0.0300");
    // cached and the unknown counts say which part is missing.
    expect(totals).toContain("cached=unknown");
    expect(totals).toContain("input: 1");
    expect(totals).toContain("of 3");
  });

  test("--sum folds session summaries per field: turns' tokens once, the session's cost (ul3)", async () => {
    // The claude/zai shape: turns carry tokens and null cost (the wire's
    // total_cost_usd is session-lifetime), the closing record carries the
    // cumulative tokens AND the cost. Before ul3 the exclusion that kept
    // tokens from doubling also dropped the cost entirely.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(4 * MINUTE), input: 5, output: 1, total: 6 }),
        record({ ts: iso(3 * MINUTE), kind: "session_turn", sessionId: "s1", input: 10, output: 2, total: 12 }),
        record({ ts: iso(2 * MINUTE), kind: "session_turn", sessionId: "s1", input: 20, output: 4, total: 24 }),
        // The closing summary carries the turns' cumulative sum (30 = 10
        // + 20) plus the session cost; counting its tokens beside the
        // turns would report 65, not 35, and dropping it would lose the
        // $0.05.
        record({ ts: iso(MINUTE), kind: "session", sessionId: "s1", input: 30, output: 6, total: 36, cost: 0.05 }),
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    expect(totals).toContain("Totals over 4 record(s)");
    expect(totals).toContain("input=35");
    expect(totals).toContain("output=7");
    expect(totals).toContain("total=42");
    expect(totals).not.toContain("input=65");
    expect(totals).toContain("cost=$0.0500");
    expect(totals).toContain("1 session summary folded");
    // The table still shows all four records (header plus four rows plus
    // the totals line).
    expect(stdout.split("\n").filter((line) => line !== "")).toHaveLength(6);
  });

  test("--sum folds a resumed session's closings to the newest one (ul4)", async () => {
    // A resumed session writes a SECOND closing record under the same
    // session id, and each closing carries session-lifetime usage — the
    // claude family's cost especially — so both closings shown together
    // double-count the pre-resume share ($3.00, not $2.00). The newest
    // closing wins; the older one is superseded and named in the note.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(4 * MINUTE), kind: "session_turn", sessionId: "s1", input: 10, output: 2, total: 12 }),
        record({ ts: iso(3 * MINUTE), kind: "session", sessionId: "s1", input: 30, output: 6, total: 36, cost: 1.0 }),
        record({ ts: iso(2 * MINUTE), kind: "session_turn", sessionId: "s1", input: 20, output: 4, total: 24 }),
        record({ ts: iso(MINUTE), kind: "session", sessionId: "s1", input: 50, output: 10, total: 60, cost: 2.0 }),
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    // Tokens come from the turns (10 + 20), the cost from the newest
    // closing alone — never the pre-resume cost counted twice.
    expect(totals).toContain("Totals over 3 record(s)");
    expect(totals).toContain("input=30");
    expect(totals).toContain("total=36");
    expect(totals).toContain("cost=$2.0000");
    expect(totals).not.toContain("cost=$3.0000");
    expect(totals).toContain("1 superseded session summary excluded");
    // The table still shows all four records.
    expect(stdout.split("\n").filter((line) => line !== "")).toHaveLength(6);
  });

  test("--sum counts a session summary whole when its turns are not shown (ul3)", async () => {
    // --limit 2 shows the closing record and one turn: with the other
    // turn cut off, the fold still keeps the shown turn's tokens (10) and
    // the summary's cost; a summary with NO shown turns (the limit cut
    // them all) contributes every field it reported.
    const lines = [
      record({ ts: iso(3 * MINUTE), kind: "session_turn", sessionId: "s1", input: 10, output: 2, total: 12 }),
      record({ ts: iso(2 * MINUTE), kind: "session_turn", sessionId: "s1", input: 20, output: 4, total: 24 }),
      record({ ts: iso(MINUTE), kind: "session", sessionId: "s1", input: 30, output: 6, total: 36, cost: 0.05 }),
    ];
    const oneTurn = await callsWith(lines, ["-n", "2", "--sum"]);
    const totalsOne = oneTurn.stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    // The shown turn reported input, so the summary's input stays out;
    // the cost folds in either way.
    expect(totalsOne).toContain("input=20");
    expect(totalsOne).toContain("cost=$0.0500");

    const summaryOnly = await callsWith(lines, ["-n", "1", "--sum"]);
    const totalsBare = summaryOnly.stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totalsBare).toContain("input=30");
    expect(totalsBare).toContain("total=36");
    expect(totalsBare).toContain("cost=$0.0500");
  });

  test("--sum excludes a session summary with no session id", async () => {
    const { stdout } = await callsWith(
      [
        record({ ts: iso(2 * MINUTE), kind: "session_turn", sessionId: "s1", input: 10, output: 2, total: 12 }),
        // A summary that names no session cannot be matched to its turns;
        // counting it beside them risks the double count, so it is out.
        record({ ts: iso(MINUTE), kind: "session", input: 30, output: 6, total: 36, cost: 0.05 }),
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toContain("Totals over 1 record(s)");
    expect(totals).toContain("input=10");
    expect(totals).not.toContain("input=40");
    expect(totals).toContain("1 session summary with no session id excluded");
  });

  test("--sum never merges sessions that recorded '': the empty id keys nothing, like null (ul6)", async () => {
    // Old ledgers wrote "" where a session had no native id, and one
    // shared "" key merged every such session into one phantom session:
    // the second closing's cost was matched against the first's turns,
    // and a resumed-looking pair double-counted. "" keys nothing now —
    // the writers mint a codemux id (session drivers, review ul6) — and
    // the reader excludes ""-keyed summaries exactly like null ones.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(4 * MINUTE), kind: "session_turn", sessionId: "", input: 10, output: 2, total: 12 }),
        record({ ts: iso(3 * MINUTE), kind: "session", sessionId: "", input: 10, output: 2, total: 12, cost: 0.05 }),
        record({ ts: iso(2 * MINUTE), kind: "session_turn", sessionId: "", input: 20, output: 4, total: 24 }),
        record({ ts: iso(MINUTE), kind: "session", sessionId: "", input: 20, output: 4, total: 24, cost: 0.07 }),
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    // Tokens from the turns alone; neither ""-keyed summary folded in.
    expect(totals).toContain("Totals over 2 record(s)");
    expect(totals).toContain("input=30");
    expect(totals).not.toContain("input=50");
    expect(totals).toContain("cost=unknown");
    expect(totals).toContain("2 session summaries with no session id excluded");
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
      expect(exitCode).toBe(1);
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

// The spawned-CLI tests above prove the command ships in the real binary;
// these in-process runs drive the same action for line coverage, with the
// process's stdout/stderr captured and CODEMUX_CALL_LOG redirected.
describe("codemux calls in-process", () => {
  interface Captured {
    out: string[];
    err: string[];
    code: number;
  }

  async function runCommand(
    lines: string[],
    args: string[]
  ): Promise<{ captured: Captured; dir: string; done: () => void }> {
    const dir = mkdtempSync(join(tmpdir(), "codemux-calls-inproc-"));
    const path = join(dir, "calls.jsonl");
    if (lines.length > 0) writeFileSync(path, `${lines.join("\n")}\n`);
    const previous = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = path;
    const captured: Captured = { out: [], err: [], code: 0 };
    const out = console.log;
    const err = console.error;
    console.log = (line: string) => void captured.out.push(line);
    console.error = (line: string) => void captured.err.push(line);
    const program = new Command();
    registerCallsCommand(program, (code) => {
      captured.code = code;
    });
    try {
      await program.parseAsync(["calls", ...args], { from: "user" });
    } finally {
      console.log = out;
      console.error = err;
      if (previous === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previous;
    }
    return { captured, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("the table, filters, and totals run through the commander action", async () => {
    const { captured, done } = await runCommand(
      [
        record({ ts: iso(30 * MINUTE), agent: "claude", input: 100, output: 5, total: 105, cost: 0.02 }),
        record({ ts: iso(20 * MINUTE), agent: "zai" }),
        record({ ts: iso(MINUTE), agent: "zai", input: 7, output: 3, total: 10 }),
      ],
      ["-a", "zai", "--sum"]
    );
    try {
      expect(captured.code).toBe(0);
      // Header plus two zai rows, newest first.
      expect(captured.out[0]).toContain("TIMESTAMP");
      expect(captured.out.filter((line) => line.includes("zai"))).toHaveLength(2);
      const totals = captured.out.find((line) => line.startsWith("Totals"));
      expect(totals).toContain("input=7");
      expect(totals).toContain("cost=unknown");
      expect(totals).toContain("of 2");
    } finally {
      done();
    }
  });

  test("--json prints the raw lines through the action", async () => {
    const { captured, done } = await runCommand(
      [record({ ts: iso(2 * MINUTE), agent: "claude" }), record({ ts: iso(MINUTE), agent: "zai" })],
      ["--json"]
    );
    try {
      expect(captured.out).toHaveLength(2);
      expect(JSON.parse(captured.out[0]!).agent).toBe("zai");
    } finally {
      done();
    }
  });

  test("the error paths set the exit code through the action", async () => {
    const disabled = await runCommand([record({ ts: iso(MINUTE) })], []);
    try {
      // Not an error: a ledger with records prints normally.
      expect(disabled.captured.code).toBe(0);
    } finally {
      disabled.done();
    }
    const badLimit = await runCommand([record({ ts: iso(MINUTE) })], ["-n", "0"]);
    try {
      expect(badLimit.captured.code).toBe(1);
      expect(badLimit.captured.err.join("\n")).toContain("--limit must be an integer");
    } finally {
      badLimit.done();
    }
    const badSince = await runCommand([record({ ts: iso(MINUTE) })], ["--since", "soon"]);
    try {
      expect(badSince.captured.code).toBe(64);
      expect(badSince.captured.err.join("\n")).toContain("--since must be a duration");
    } finally {
      badSince.done();
    }
  });
});
