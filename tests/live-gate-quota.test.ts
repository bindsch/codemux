// Quota outcomes for the live gate (parity pass, 2.0.0): the pre-spawn
// decisions built from the gate's ONE usage snapshot (one query per gate,
// passed to every probe), and the classification that separates a quota
// refusal from a behavior failure. scripts/live-gate/quota.ts owns both;
// the decision rule itself is src/quota-gate.ts's gateOutcomeOnResult.
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig, DEFAULT_QUOTA_POLICY } from "../src/config.js";
import type { AgentId } from "../src/types.js";
import type { UsageSnapshot, UsageResult } from "../src/usage-protocol.js";
import { gateQuotaDecisions, parseOptions, quotaRefusalIn, runProbes } from "../scripts/live-gate.js";
import type { GateQuotaDecision } from "../scripts/live-gate/quota.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

/** One usagemux result row, fresh by the gate's freshness rule. */
const result = (client: string, windows: UsageResult["windows"], status: UsageResult["status"] = "ok"): UsageResult => ({
  client: client as UsageResult["client"],
  provider: "provider", status, source: "source", plan: "plan", account: "account",
  windows, credits: null, subscriptionRenewsAt: null, subscriptionExpiresAt: null, message: null,
});

const snapshotWith = (results: UsageResult[], generatedAt = new Date().toISOString()): UsageSnapshot =>
  ({ schemaVersion: "1", generatedAt, results });

test("quotaRefusalIn matches the three evidenced refusal spellings and nothing else", () => {
  // The live gate of 2026-11-08 printed these as behavior FAILs. The
  // stored stderr is the runner's first ordinary line, escaped and cut at
  // 160 characters (kimi's line ends mid-word), so the match is a
  // substring, never a full sentence.
  const fail = (stderr: string) => ({ status: "FAIL" as const, seconds: 1, stderr });
  expect(quotaRefusalIn(fail("Error: quota gate: codex: secondary window has 0% left (resets 2026-11-08 20:36:48 (in 2 h 8 m)), below the 10% ceiling")))
    .toBe("the codemux quota gate refused the launch");
  expect(quotaRefusalIn(fail("error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 128h26m17s.")))
    .toBe("the provider refused the run: individual quota reached");
  expect(quotaRefusalIn(fail("error: failed to run prompt: provider.api_error: You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To co")))
    .toBe("the provider refused the run: weekly usage limit reached");
  // A quota warning the gate prints while proceeding is not a refusal, an
  // ordinary harness failure is not a refusal, and neither is a PASS.
  expect(quotaRefusalIn(fail("Warning: quota gate: agy: secondary window has 0% left (resets 2026-11-08 18:29:42 (in 2 m)), below the 10% ceiling; proceeding (not the primary window)"))).toBeNull();
  expect(quotaRefusalIn(fail("exit 1; stdout: not the nonce"))).toBeNull();
  expect(quotaRefusalIn({ status: "PASS", seconds: 0, stderr: "Error: quota gate: codex: refused" })).toBeNull();
});

test("gateQuotaDecisions applies the launch-path rule over one snapshot", () => {
  const policy = { ...DEFAULT_QUOTA_POLICY };
  const snapshot = snapshotWith([
    // codex: an exhausted weekly secondary tier (the 2026-11-08 shape).
    result("codex", [
      { kind: "secondary", usedPercent: 100, remainingPercent: 0, windowMinutes: 10_080, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ]),
    // claude: healthy primary window.
    result("claude", [
      { kind: "primary", usedPercent: 20, remainingPercent: 80, windowMinutes: null, resetsAt: null },
    ]),
    // kimi: an empty pool that is not the primary window — warns, refuses
    // nothing.
    result("kimi", [
      { kind: "third-party pool", usedPercent: 100, remainingPercent: 0, windowMinutes: null, resetsAt: null },
    ]),
  ]);
  const decisions = gateQuotaDecisions(snapshot, policy, ["codex", "claude", "kimi", "agy"]);
  expect(decisions.get("codex")).toMatchObject({ refused: true });
  expect(decisions.get("codex")!.reason).toContain("quota gate: codex: secondary window has 0% left");
  expect(decisions.get("claude")).toBeUndefined();
  expect(decisions.get("kimi")).toBeUndefined();
  // agy has no row in the snapshot (the gate's own usage query excludes
  // it): no decision, so its probes spawn and a provider refusal is
  // classified after the fact.
  expect(decisions.get("agy")).toBeUndefined();
  // A stale snapshot decides nothing: the gate, like the launch path,
  // fails open on an unreadable reading.
  const stale = snapshotWith(
    [result("codex", [{ kind: "primary", usedPercent: 100, remainingPercent: 0, windowMinutes: null, resetsAt: null }])],
    new Date(Date.now() - 30 * 60_000).toISOString()
  );
  expect(gateQuotaDecisions(stale, policy, ["codex"]).size).toBe(0);
  // spendsFrom: the decision is made on the mapped client's windows.
  const mapped = gateQuotaDecisions(
    snapshot,
    { ...policy, spendsFrom: { opencode: "codex" } },
    ["opencode"]
  );
  expect(mapped.get("opencode")).toMatchObject({ refused: true });
  expect(mapped.get("opencode")!.reason).toContain("quota gate: opencode:");
});

test("a quota-refused harness gets SKIP cells before anything spawns; the no-spend probes still run", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const spawned: string[] = [];
  const decisions = new Map<AgentId, GateQuotaDecision>([
    ["claude", { refused: true, reason: "quota gate: claude: primary window has 0% left (resets soon), below the 10% ceiling" }],
  ]);
  try {
    const rows = await runProbes(
      [factsFor("claude")],
      parseOptions(["--probe", "A,B,H2,J,P", "--timeout", "10"], ""),
      {
        async run(command) { spawned.push(command.join(" ")); return { status: "PASS", seconds: 0, stderr: "" }; },
        async capture(command) { spawned.push(command.join(" ")); return { status: "PASS", seconds: 0, stderr: "" }; },
      },
      reportDirectory, fixture.env, undefined, decisions
    );
    const row = rows[0]!.results;
    // The spawn probes skip naming the refusal.
    expect(row.A).toMatchObject({ status: "SKIP" });
    expect(row.A!.note).toContain("quota gate refused this harness before the probes");
    expect(row.A!.note).toContain("below the 10% ceiling");
    expect(row.B).toMatchObject({ status: "SKIP" });
    // H2 runs under the loopback override and J and P start no native run,
    // so a native-account refusal does not skip them: exactly their four
    // runner calls spawned (J's print and script, H2, P) and nothing else.
    expect(row.H2).toMatchObject({ status: "PASS" });
    expect(row.J).toMatchObject({ status: "PASS" });
    expect(row.P).toMatchObject({ status: "PASS" });
    expect(spawned).toHaveLength(4);
    expect(spawned.filter((command) => command.includes("--print-sandbox")).length).toBe(2);
    // H2 is the loopback twin: its run scrubs the environment instead of
    // asserting an envelope.
    expect(spawned.some((command) => command.includes("--sandbox-scrub-env"))).toBe(true);
    // No spawn carried a bare probe run: A and B never started, and every
    // spawned run carries either --print-sandbox (J, P) or
    // --sandbox-scrub-env (H2).
    expect(spawned.some((command) => command.includes("run -a claude")
      && !command.includes("--print-sandbox") && !command.includes("--sandbox-scrub-env"))).toBe(false);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("a FAIL whose stderr is a quota refusal becomes a SKIP naming it; an ordinary FAIL stays a FAIL", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const stub = (stderr: string) => ({
    async run() { return { status: "FAIL" as const, seconds: 1, stderr }; },
    async capture() { throw new Error("unexpected capture probe"); },
  });
  try {
    // codex: the codemux pre-spawn refusal, exit 64 (the 2026-11-08 row).
    const refused = await runProbes([factsFor("codex")], parseOptions(["--probe", "A", "--timeout", "10"], ""),
      stub("Error: quota gate: codex: secondary window has 0% left (resets 2026-11-08 20:36:48 (in 2 h 8 m)), below the 10% ceiling"),
      reportDirectory, fixture.env);
    expect(refused[0]!.results.A).toMatchObject({ status: "SKIP" });
    expect(refused[0]!.results.A!.note).toContain("the codemux quota gate refused the launch");
    expect(refused[0]!.results.A!.note).toContain("Error: quota gate: codex");
    // agy: the provider's own refusal line (the 2026-11-08 row).
    const provider = await runProbes([factsFor("agy")], parseOptions(["--probe", "A", "--timeout", "10"], ""),
      stub("error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 128h26m17s."),
      reportDirectory, fixture.env);
    expect(provider[0]!.results.A).toMatchObject({ status: "SKIP" });
    expect(provider[0]!.results.A!.note).toContain("individual quota reached");
    // kimi: the provider's weekly-limit line, truncated at the runner's
    // 160-character cap (the 2026-11-08 row).
    const weekly = await runProbes([factsFor("kimi")], parseOptions(["--probe", "A", "--timeout", "10"], ""),
      stub("error: failed to run prompt: provider.api_error: You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To co"),
      reportDirectory, fixture.env);
    expect(weekly[0]!.results.A).toMatchObject({ status: "SKIP" });
    // An ordinary failure is a behavior failure and stays a FAIL.
    const ordinary = await runProbes([factsFor("claude")], parseOptions(["--probe", "A", "--timeout", "10"], ""),
      stub("exit 1; stdout: the harness refused to answer"), reportDirectory, fixture.env);
    expect(ordinary[0]!.results.A).toMatchObject({ status: "FAIL" });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("a reclassified quota SKIP keeps no probe directory; a FAIL still does", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const stub = (stderr: string) => ({
    async run() { return { status: "FAIL" as const, seconds: 0, stderr }; },
    async capture() { throw new Error("unexpected capture probe"); },
  });
  const refused = stub("Error: quota gate: codex: primary window has 0% left (resets x), below the 10% ceiling");
  const ordinary = stub("exit 1; stdout: not the nonce");
  try {
    const quotaRows = await runProbes([factsFor("codex")], parseOptions(["--probe", "A", "--timeout", "10"], ""),
      refused, reportDirectory, fixture.env);
    expect(quotaRows[0]!.results.A).toMatchObject({ status: "SKIP" });
    expect(existsSync(join(reportDirectory, "codex-A-probe"))).toBe(false);
    // The same probe with an ordinary failure keeps its directory: only a
    // judged FAIL is evidence, and the reclassification is not a way to
    // lose it.
    const failRows = await runProbes([factsFor("codex")], parseOptions(["--probe", "A", "--timeout", "10"], ""),
      ordinary, reportDirectory, fixture.env);
    expect(failRows[0]!.results.A).toMatchObject({ status: "FAIL" });
    expect(existsSync(join(reportDirectory, "codex-A-probe"))).toBe(true);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("the default policy is what the config defaults to", () => {
  // The decisions above run against DEFAULT_QUOTA_POLICY; main() reads the
  // effective config, whose absent key resolves to the same defaults, so
  // the gate's pre-spawn rule and a launch's rule agree by construction.
  expect(getDefaultConfig().quota).toEqual(DEFAULT_QUOTA_POLICY);
});
