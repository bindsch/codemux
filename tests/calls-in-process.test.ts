import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { CALL_LOG_ENV } from "../src/call-log.js";
import { registerCallsCommand } from "../src/calls-command.js";
import { iso, MINUTE, record } from "./helpers/calls-records.js";

const HOUR = 60 * MINUTE;

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
      expect(badLimit.captured.code).toBe(64);
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

  test("session folds, exclusions, and unknowns run through the action", async () => {
    // Append order is oldest first (the shown table reverses it). A shown
    // turn that reports a field keeps its session's closing summary out of
    // that field; a second, older closing of the same session is
    // superseded; a closing with no session id is excluded outright.
    const lines = [
      "this line is not json",
      record({
        ts: iso(40 * MINUTE), kind: "session_turn", sessionId: "s1",
        input: 100, output: 5, total: 105,
      }),
      record({
        ts: iso(30 * MINUTE), kind: "session_turn", sessionId: "s1",
        input: 50, cost: 0.01,
      }),
      // The older closing, appended before the newer one: shown after it,
      // so the newest-closing-wins rule marks this one superseded.
      record({
        ts: iso(25 * MINUTE), kind: "session", sessionId: "s1",
        input: 999, total: 999, cost: 1.5,
      }),
      record({
        ts: iso(20 * MINUTE), kind: "session", sessionId: "s1",
        input: 999, total: 999, cost: 1.5,
      }),
      record({ ts: iso(15 * MINUTE), kind: "session", sessionId: "" }),
      // A record that reports no usage field at all: the unknowns note.
      record({ ts: iso(5 * MINUTE) }),
    ];
    const { captured, done } = await runCommand(lines, ["--sum"]);
    try {
      const totals = captured.out.find((line) => line.startsWith("Totals"));
      expect(totals).toBeDefined();
      // Turns win their reported fields; the closing's 999s and $1.50
      // never land beside them.
      expect(totals).toContain("input=150");
      expect(totals).toContain("cost=$0.01");
      expect(totals).not.toContain("999");
      expect(totals).toContain("1 session summary folded");
      expect(totals).toContain("1 session summary with no session id excluded");
      expect(totals).toContain("1 superseded session summary excluded");
      expect(totals).toContain("unreported —");
      expect(captured.err.join("\n")).toContain("skipped 1 unparseable line");
    } finally {
      done();
    }
  });

  test("a --since window keeps a closing summary whose turns moved inside it", async () => {
    // Append order is the writer's: a session's closing record lands after
    // its turns. The window keeps the closing when an in-window turn of the
    // same session came before it — the set of sessions with an in-window
    // turn, seen so far, decides.
    const lines = [
      // The session began outside the window; its turn and closing still
      // count because a later turn moved inside.
      record({ ts: iso(3 * 60 * MINUTE), kind: "session_turn", sessionId: "s1", input: 10 }),
      record({ ts: iso(10 * MINUTE), kind: "session_turn", sessionId: "s1", input: 20 }),
      record({ ts: iso(3 * 60 * MINUTE), kind: "session", sessionId: "s1", cost: 2 }),
      // Another agent's record the agent filter drops.
      record({ ts: iso(5 * MINUTE), agent: "zai", input: 7 }),
    ];
    const { captured, done } = await runCommand(lines, ["--since", "1h", "-a", "claude", "--sum"]);
    try {
      const totals = captured.out.find((line) => line.startsWith("Totals"));
      expect(totals).toBeDefined();
      // The inside turn reported input, so the closing contributes only
      // its cost — the claude family's only cost figure.
      expect(totals).toContain("input=20");
      expect(totals).toContain("cost=$2");
      expect(totals).toContain("Totals over 2 record(s)");
    } finally {
      done();
    }
  });

  test("an empty session id keys nothing: a recent empty-id turn never admits an old empty-id closing (round 80)", async () => {
    // "" is unkeyed legacy data (calls-totals.ts sessionKey), which the
    // totals already refuse to merge under. Before round 80 the window
    // collected it as a session key anyway, so one recent empty-id turn
    // made every old empty-id closing record pass the cutoff — unrelated
    // sessions mixed into the window, records outside it listed.
    const lines = [
      // An old closing record with an empty id, its start far outside the
      // window; its tokens must stay behind the cutoff.
      record({ ts: iso(3 * 60 * MINUTE), kind: "session", sessionId: "", input: 999, total: 999 }),
      // A recent turn with an empty id: inside the window on its own ts.
      record({ ts: iso(10 * MINUTE), kind: "session_turn", sessionId: "", input: 5, total: 5 }),
    ];
    const { captured, done } = await runCommand(lines, ["--since", "1h", "--json", "--sum"]);
    try {
      // One stored line (the turn) plus the totals line.
      expect(captured.out).toHaveLength(2);
      expect(JSON.parse(captured.out[0]!).kind).toBe("session_turn");
      expect(JSON.parse(captured.out[0]!).session_id).toBe("");
      const totals = captured.out[1]!;
      expect(totals).toContain("Totals over 1 record(s)");
      expect(totals).toContain("input=5");
      expect(totals).not.toContain("999");
    } finally {
      done();
    }
  });

  test("a label filter with no match says so instead of an empty table", async () => {
    const labeled = JSON.stringify({
      ...JSON.parse(record({ ts: iso(MINUTE) })),
      labels: { wf: "scan" },
    });
    const { captured, done } = await runCommand([labeled], ["--label", "wf=other"]);
    try {
      expect(captured.code).toBe(0);
      expect(captured.out).toEqual([]);
      expect(captured.err.join("\n")).toContain("no matching calls");
    } finally {
      done();
    }
  });

  test("a ledger that cannot be inspected fails instead of reporting none (review round 232)", async () => {
    // A mode-000 parent makes even the look fail with EACCES; existsSync
    // folded that into "absent", and the command answered an empty
    // ledger at exit 0 — a false result for any automation reading it.
    // Root ignores directory modes, so the case cannot be built there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "codemux-calls-locked-"));
    const parent = join(dir, "locked");
    mkdirSync(parent);
    writeFileSync(join(parent, "calls.jsonl"), `${record({ ts: iso(MINUTE), input: 3 })}\n`);
    chmodSync(parent, 0o000);
    const previous = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = join(parent, "calls.jsonl");
    const captured: { out: string[]; err: string[]; code: number } = { out: [], err: [], code: 0 };
    const out = console.log;
    const err = console.error;
    console.log = (line: string) => void captured.out.push(line);
    console.error = (line: string) => void captured.err.push(line);
    try {
      const program = new Command();
      registerCallsCommand(program, (code) => {
        captured.code = code;
      });
      await program.parseAsync(["calls"], { from: "user" });
    } finally {
      console.log = out;
      console.error = err;
      if (previous === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previous;
      chmodSync(parent, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toContain("could not inspect the call ledger");
    expect(captured.err.join("\n")).not.toContain("no calls recorded yet");
  });

  test("ledger absence and an unreadable ledger are distinct messages", async () => {
    // No lines means the helper never creates the file: the command
    // reports that nothing is recorded yet, at exit 0.
    const absent = await runCommand([], ["--sum"]);
    try {
      expect(absent.captured.code).toBe(0);
      expect(absent.captured.out).toEqual([]);
      expect(absent.captured.err.join("\n")).toContain("no calls recorded yet");
    } finally {
      absent.done();
    }
    // A directory at the ledger path: exists, but cannot be read as a file.
    const dir = mkdtempSync(join(tmpdir(), "codemux-calls-dir-"));
    const previous = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = dir;
    const captured: { out: string[]; err: string[]; code: number } = { out: [], err: [], code: 0 };
    const out = console.log;
    const err = console.error;
    console.log = (line: string) => void captured.out.push(line);
    console.error = (line: string) => void captured.err.push(line);
    try {
      const program = new Command();
      registerCallsCommand(program, (code) => {
        captured.code = code;
      });
      await program.parseAsync(["calls"], { from: "user" });
    } finally {
      console.log = out;
      console.error = err;
      if (previous === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toContain("could not read the call ledger");

    // `off` disables the ledger outright: a different failure, same exit.
    const previousOff = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = "off";
    const off: { out: string[]; err: string[]; code: number } = { out: [], err: [], code: 0 };
    console.log = (line: string) => void off.out.push(line);
    console.error = (line: string) => void off.err.push(line);
    try {
      const program = new Command();
      registerCallsCommand(program, (code) => {
        off.code = code;
      });
      await program.parseAsync(["calls"], { from: "user" });
    } finally {
      console.log = out;
      console.error = err;
      if (previousOff === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previousOff;
    }
    expect(off.code).toBe(1);
    expect(off.err.join("\n")).toContain("the call ledger is disabled");
  });

  test("a ledger past the old 16 MiB read bound sums every record through the stream", async () => {
    // A few hundred thousand short records cross 16 MiB with room to spare.
    // Before the streaming read landed, both the listing and the totals saw
    // only the newest 16 MiB and the totals line carried an under-count
    // note; now the totals see every record and only the listing is
    // bounded, by -n.
    const old = record({ ts: iso(HOUR + HOUR), input: 1, output: 1, total: 2 });
    const recent = record({ ts: iso(MINUTE), input: 1, output: 1, total: 2 });
    const dir = mkdtempSync(join(tmpdir(), "codemux-calls-big-"));
    const path = join(dir, "calls.jsonl");
    const writer = Bun.file(path).writer();
    for (let i = 0; i < 290_000; i++) writer.write(`${old}\n`);
    for (let i = 0; i < 10_000; i++) writer.write(`${recent}\n`);
    await writer.end();
    try {
      expect(statSync(path).size).toBeGreaterThan(16 * 1024 * 1024);
      const previous = process.env[CALL_LOG_ENV];
      const captured: { out: string[]; err: string[]; code: number } = { out: [], err: [], code: 0 };
      const out = console.log;
      const err = console.error;
      const run = async (args: string[]): Promise<void> => {
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
      };
      await run(["--sum"]);
      const totals = captured.out.find((line) => line.startsWith("Totals"));
      expect(totals).toBeDefined();
      // Every record summed, not only the newest 16 MiB.
      expect(totals).toContain("Totals over 300000 record(s)");
      expect(totals).toContain("input=300,000");
      // The listing keeps its -n bound: header, 20 rows, one totals line.
      expect(captured.out).toHaveLength(22);
      expect(captured.err.join("\n")).not.toContain("16 MiB");

      captured.out = [];
      await run(["--sum", "--since", "30m"]);
      const windowed = captured.out.find((line) => line.startsWith("Totals"));
      expect(windowed).toBeDefined();
      // The window sees the whole ledger too: exactly the 10000 recent
      // records, never only those inside the newest 16 MiB.
      expect(windowed).toContain("Totals over 10000 record(s)");
      expect(windowed).toContain("input=10,000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
