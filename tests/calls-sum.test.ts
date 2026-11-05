import { describe, expect, test } from "bun:test";
import { callsWith, iso, MINUTE, record } from "./helpers/calls-records.js";

describe("codemux calls --sum", () => {
  test("--sum totals the shown records and counts the unreported as unknown, never zero", async () => {
    const { stdout } = await callsWith(
      [
        // Billed figures: a codex line is a provider charge (a claude figure
        // without cost_source would be the harness's own estimate).
        record({ ts: iso(3 * MINUTE), agent: "codex", input: 100, output: 5, total: 105, cost: 0.02 }),
        record({ ts: iso(2 * MINUTE), agent: "codex", input: 50, output: 5, total: 55, cost: 0.01 }),
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

  test("--sum totals billed cost only; the harness estimate prints on its own line (audit round 2, B5)", async () => {
    // claude's session cost is a figure the harness folded, not a per-call
    // bill; codex's is billed; opencode's zero is the subscription covering
    // the call. One sum over all three read the estimate as billed money.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(3 * MINUTE), agent: "codex", input: 10, output: 2, total: 12, cost: 0.02, costSource: "billed" }),
        record({ ts: iso(2 * MINUTE), kind: "session", sessionId: "s1", agent: "claude", input: 5, output: 1, total: 6, cost: 1.5, costSource: "harness-estimate" }),
        record({ ts: iso(MINUTE), agent: "opencode", input: 1, output: 1, total: 2, cost: 0, costSource: "subscription-zero" }),
      ],
      ["--sum"]
    );
    const lines = stdout.split("\n");
    const totals = lines.find((line) => line.startsWith("Totals"))!;
    expect(totals).toContain("cost=$0.0200");
    const estimate = lines.find((line) => line.includes("harness estimate"))!;
    expect(estimate).toContain("$1.5000");
    expect(estimate).toContain("session-lifetime");
  });

  test("a ledger line older than cost_source is classified as the writer classifies it today (review round 39)", async () => {
    // A zai or claude figure recorded before 2.0.0 is the harness's own price
    // estimate; a codex figure was billed. Neither line carries cost_source.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(3 * MINUTE), agent: "zai", input: 10, output: 2, total: 12, cost: 3, costSource: null }),
        record({ ts: iso(2 * MINUTE), agent: "codex", input: 10, output: 2, total: 12, cost: 0.5, costSource: null }),
      ],
      ["--sum"]
    );
    const lines = stdout.split("\n");
    expect(lines.find((line) => line.startsWith("Totals"))).toContain("cost=$0.5000");
    expect(lines.find((line) => line.includes("harness estimate"))).toContain("$3.0000");
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

  test("-n bounds the listing, never the totals, which read the whole ledger", async () => {
    // The limit cuts what the table shows, not what the totals cover: 30
    // matching records list 2 rows under -n 2 while the totals still sum
    // all 30 — the streaming read replaced the old 16 MiB tail bound, and
    // with it the coupling between the listing and the sums.
    const lines = Array.from(
      { length: 30 },
      (_, i) => record({ ts: iso((i + 1) * MINUTE), input: 1, output: 1, total: 2 })
    );
    const { stdout } = await callsWith(lines, ["-n", "2", "--sum"]);
    // Header plus two rows plus the totals line: the listing is bounded.
    expect(stdout.split("\n").filter((line) => line !== "")).toHaveLength(4);
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toContain("Totals over 30 record(s)");
    expect(totals).toContain("input=30");
    expect(totals).toContain("total=60");
  });

  test("--sum counts a session summary whole when its turns are not matched (ul3)", async () => {
    // The fold pairs a closing record with its matched turns only. An
    // agent filter that keeps the summary and drops its turns leaves the
    // summary contributing every field it reported.
    const lines = [
      record({ ts: iso(3 * MINUTE), kind: "session_turn", sessionId: "s1", agent: "claude", input: 10, output: 2, total: 12 }),
      record({ ts: iso(2 * MINUTE), kind: "session_turn", sessionId: "s1", agent: "claude", input: 20, output: 4, total: 24 }),
      record({ ts: iso(MINUTE), kind: "session", sessionId: "s1", agent: "codex", input: 30, output: 6, total: 36, cost: 0.05 }),
    ];
    const { stdout } = await callsWith(lines, ["-a", "codex", "--sum"]);
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toContain("Totals over 1 record(s)");
    expect(totals).toContain("input=30");
    expect(totals).toContain("total=36");
    expect(totals).toContain("cost=$0.0500");
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

  test("--sum prints unknown for a total that leaves the safe-integer range (round 80)", async () => {
    // Two individually valid records — a count at the ceiling and a count
    // of two — summed to the rounded 9007199254740992 before round 80;
    // the safe-sum rule makes the overflowing field unknown, the same
    // word an unreported field prints, and a later small count cannot
    // resurrect it.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(3 * MINUTE), agent: "codex", input: Number.MAX_SAFE_INTEGER }),
        record({ ts: iso(2 * MINUTE), agent: "codex", input: 2 }),
        record({ ts: iso(MINUTE), agent: "codex", input: 5 }),
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    expect(totals).toContain("input=unknown");
    expect(totals).not.toContain("input=9,007,199,254,740,992");
    expect(totals).not.toContain("input=5");
    // A field that never overflows keeps its plain sum.
    expect(totals).toContain("output=unknown");
    expect(totals).toContain("Totals over 3 record(s)");
  });

  test("--sum prints unknown for a cost total that leaves the finite range (round 90)", async () => {
    // The reader accepts every finite cost, so two Number.MAX_VALUE
    // figures are valid records; the unchecked addition printed Infinity
    // as a money total. The billed total prints unknown — the same word an
    // unreported field prints — a later figure cannot restart it, and the
    // harness-estimate bucket follows the same rule on its own line.
    const { stdout } = await callsWith(
      [
        record({ ts: iso(3 * MINUTE), agent: "codex", input: 1, output: 1, total: 2, cost: Number.MAX_VALUE }),
        record({ ts: iso(2 * MINUTE), agent: "codex", input: 1, output: 1, total: 2, cost: Number.MAX_VALUE }),
        record({ ts: iso(MINUTE), agent: "codex", input: 1, output: 1, total: 2, cost: 0.01 }),
      ],
      ["--sum"]
    );
    const totals = stdout.split("\n").find((line) => line.startsWith("Totals"))!;
    expect(totals).toBeDefined();
    expect(totals).toContain("cost=unknown");
    expect(totals).not.toContain("$0.0100"); // the overflowed bucket stays unknown
    expect(stdout).not.toContain("Infinity");
    const { stdout: estimated } = await callsWith(
      [
        record({ ts: iso(2 * MINUTE), input: 1, output: 1, total: 2, cost: Number.MAX_VALUE, costSource: "harness-estimate" }),
        record({ ts: iso(MINUTE), input: 1, output: 1, total: 2, cost: Number.MAX_VALUE, costSource: "harness-estimate" }),
      ],
      ["--sum"]
    );
    const estimate = estimated.split("\n").find((line) => line.includes("harness estimate"))!;
    expect(estimate).toBeDefined();
    expect(estimate).toContain("harness estimate unknown");
    expect(estimated).not.toContain("Infinity");
  });
});
