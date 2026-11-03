/**
 * The quota gate (src/quota-gate.ts) against a fake usagemux: absent,
 * untrusted, slow, stale, and cached snapshots, and the refusals that come
 * from a live reading. usagemux is a fake binary on a private PATH
 * (helpers/cli.ts), so nothing here spends a real request.
 */

import { describe, expect, spyOn, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertQuotaHeadroom, resetQuotaGateState } from "../src/quota-gate.js";
import * as usageModule from "../src/usage.js";
import { fetchUsageSnapshot, UsageQueryError } from "../src/usage.js";
import type { UsageResult } from "../src/usage-protocol.js";
import { createFakeBinaryEnv, minimalPath } from "./helpers/cli.js";
import { POLICY, refusal, result, window } from "./helpers/quota-gate.js";

describe("assertQuotaHeadroom against a fake usagemux", () => {
  // The gate's warnings go to the operator's stderr; capturing them here
  // also lets the silent paths assert their silence.
  let warnings: string[] = [];
  let originalError: typeof console.error;

  const snapshotScript = (results: UsageResult[], generatedAt = new Date().toISOString()): string =>
    `printf '%s' '${JSON.stringify({ schemaVersion: "1", generatedAt, results })}'`;

  const fakeEnvWith = (usagemux: string): { env: Record<string, string>; cleanup: () => void } =>
    createFakeBinaryEnv({ usagemux });

  beforeEach(() => {
    resetQuotaGateState();
    warnings = [];
    originalError = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    // These tests exercise the real gate: the suite-wide hermeticity
    // switch (tests/setup.ts) must not silence it. The env objects below
    // spread process.env, so the variable is scrubbed for the process.
    delete process.env.CODEMUX_TEST_NO_QUOTA_GATE;
  });

  afterEach(() => {
    console.error = originalError;
    process.env.CODEMUX_TEST_NO_QUOTA_GATE =
      (globalThis as { __codemuxTestNoQuotaGate?: string }).__codemuxTestNoQuotaGate ?? "1";
  });

  test("the variable alone, without the preload's nonce marker, does not disable the gate (round 20, minor 15)", async () => {
    // tests/setup.ts mirrors the nonce it generated on globalThis; the
    // gate honors the variable only when the two match. An exported or
    // leaked CODEMUX_TEST_NO_QUOTA_GATE by itself disables nothing.
    const holder = globalThis as { __codemuxTestNoQuotaGate?: string };
    const saved = holder.__codemuxTestNoQuotaGate;
    const status = spyOn(usageModule, "getUsagemuxStatus").mockReturnValue({
      available: false,
      issue: null,
    });
    try {
      delete holder.__codemuxTestNoQuotaGate;
      process.env.CODEMUX_TEST_NO_QUOTA_GATE = "1";
      await assertQuotaHeadroom("claude", POLICY, { ...process.env } as Record<string, string>);
      // The gate ran: the status probe was consulted, not skipped.
      expect(status).toHaveBeenCalledTimes(1);
      // The preload's shape — the nonce on globalThis and the same nonce
      // in the environment — is the only thing that skips it.
      holder.__codemuxTestNoQuotaGate = "nonce-under-test";
      await assertQuotaHeadroom("claude", POLICY, {
        ...process.env,
        CODEMUX_TEST_NO_QUOTA_GATE: "nonce-under-test",
      } as Record<string, string>);
      expect(status).toHaveBeenCalledTimes(1);
    } finally {
      status.mockRestore();
      holder.__codemuxTestNoQuotaGate = saved;
    }
  });

  test("no usagemux installed warns once and proceeds", async () => {
    const env = { ...process.env, PATH: minimalPath() } as Record<string, string>;
    await assertQuotaHeadroom("claude", POLICY, env);
    await assertQuotaHeadroom("claude", POLICY, env);
    expect(warnings).toEqual([
      "Warning: quota gate skipped: usagemux is not installed (optional usage integration)",
    ]);
  });

  test("an untrusted usagemux warns once and proceeds", async () => {
    const fake = fakeEnvWith(snapshotScript([result()]));
    try {
      // Group-writable fails the same trust check the launch path applies
      // to every executable codemux runs.
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "usagemux"), 0o775);
      const env = { ...process.env, PATH: fake.env.PATH } as Record<string, string>;
      await assertQuotaHeadroom("claude", POLICY, env);
      await assertQuotaHeadroom("claude", POLICY, env);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Warning: quota gate skipped: usagemux is unavailable");
      expect(warnings[0]).toContain("not a trusted executable");
    } finally {
      fake.cleanup();
    }
  });

  test("headroom proceeds silently", async () => {
    const fake = fakeEnvWith(snapshotScript([result()]));
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toHaveLength(0);
    } finally {
      fake.cleanup();
    }
  });

  test("a window below the ceiling refuses", async () => {
    const fake = fakeEnvWith(
      snapshotScript([result({ windows: [window({ kind: "primary", remainingPercent: 5 })] })])
    );
    try {
      const message = await refusal(() =>
        assertQuotaHeadroom(
          "claude",
          POLICY,
          { ...process.env, PATH: fake.env.PATH } as Record<string, string>
        )
      );
      expect(message).toContain("quota gate: claude: primary window has 5% left");
    } finally {
      fake.cleanup();
    }
  });

  test("a provider error warns and proceeds", async () => {
    const fake = fakeEnvWith(
      snapshotScript([result({ status: "error", windows: [], message: "provider says no" })])
    );
    try {
      await assertQuotaHeadroom("claude", POLICY, { ...process.env, PATH: fake.env.PATH } as Record<string, string>);
      expect(warnings).toEqual(["Warning: quota gate: claude: usage unreadable (provider says no); proceeding"]);
    } finally {
      fake.cleanup();
    }
  });

  test("unparseable output warns and proceeds", async () => {
    const fake = fakeEnvWith("printf 'not json at all'");
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Warning: quota gate skipped: ");
    } finally {
      fake.cleanup();
    }
  });

  test("a failing usagemux names its exit code and proceeds", async () => {
    const fake = fakeEnvWith("printf 'boom' >&2; exit 3");
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toEqual([
        "Warning: quota gate skipped: usagemux exited 3: boom"
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test("usagemux stderr bytes arrive escaped, never raw (round 10, contracts 5)", async () => {
    // An OSC title and an ANSI color run on usagemux's stderr used to
    // ride the error message to the terminal verbatim. The detail is
    // escaped where it enters the message and again at the warn site.
    const fake = fakeEnvWith("printf '\\033]777;title\\007 \\033[31mred\\033[0m' >&2; exit 3");
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("usagemux exited 3: \\x1b]777;title\\x07 \\x1b[31mred\\x1b[0m");
      expect(warnings[0]).not.toContain("\u001b");
      expect(warnings[0]).not.toContain("\u0007");
    } finally {
      fake.cleanup();
    }
  });

  test("a snapshot older than ten minutes warns and proceeds", async () => {
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    const fake = fakeEnvWith(
      snapshotScript([result({ windows: [window({ remainingPercent: 0 })] })], stale)
    );
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("snapshot is stale");
      // Even a zero-percent window does not refuse on a stale reading.
    } finally {
      fake.cleanup();
    }
  });

  test("a snapshot dated in the future is unreadable, not fresh (round 15, edges 5)", async () => {
    // A clock skew or a lying stamp produced a negative age, which the
    // staleness check accepted as current. More than a minute into the
    // future now warns like a stale one.
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    const fake = fakeEnvWith(
      snapshotScript([result({ windows: [window({ remainingPercent: 0 })] })], future)
    );
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("snapshot is dated in the future");
      // Even a zero-percent window does not refuse on a reading the gate
      // cannot place in time.
    } finally {
      fake.cleanup();
    }
  });

  test("a snapshot a few seconds into the future still gates normally", async () => {
    // Inside the one-minute tolerance (usagemux stamps the same host
    // clock, so a small skew is normal) the snapshot is fresh: a
    // zero-percent window refuses, proving the gate read it.
    const skewed = new Date(Date.now() + 5_000).toISOString();
    const fake = fakeEnvWith(
      snapshotScript([result({ windows: [window({ kind: "primary", remainingPercent: 0 })] })], skewed)
    );
    try {
      const message = await refusal(() =>
        assertQuotaHeadroom(
          "claude",
          POLICY,
          { ...process.env, PATH: fake.env.PATH } as Record<string, string>
        )
      );
      expect(message).toContain("has 0% left");
    } finally {
      fake.cleanup();
    }
  });

  test("a usagemux that never answers warns and proceeds", async () => {
    // The gate's own timeout is the policy's; the runner adds its shutdown
    // grace, so this case costs about five seconds by design. The runner
    // may add its own process-table note to stderr, so the assertion finds
    // the gate's line rather than comparing every warning.
    const fake = fakeEnvWith("sleep 30");
    try {
      await assertQuotaHeadroom(
        "claude",
        { ...POLICY, timeoutSeconds: 0.2 },
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      const gateWarning = warnings.find((line) => line.includes("quota gate skipped"));
      expect(gateWarning).toBeDefined();
      expect(gateWarning).toContain("usagemux exited 124");
    } finally {
      fake.cleanup();
    }
  }, 20_000);

  test("an invalid gate timeout refuses instead of failing open", async () => {
    // 0.0001 seconds becomes a non-integer millisecond timeout; the
    // runner's own validation rejects it, and that error is codemux's, not
    // usagemux's: the launch is refused (exit 64), never allowed through
    // by the fail-open catch.
    const fake = fakeEnvWith(snapshotScript([result()]));
    try {
      const message = await refusal(() =>
        assertQuotaHeadroom(
          "claude",
          { ...POLICY, timeoutSeconds: 0.0001 },
          { ...process.env, PATH: fake.env.PATH } as Record<string, string>
        )
      );
      expect(message).toContain("quota gate: invalid usage query settings");
      expect(message).toContain("timeoutMs must be an integer");
      expect(warnings).toHaveLength(0);
    } finally {
      fake.cleanup();
    }
  });

  test("a snapshot missing the agent warns and proceeds", async () => {
    // fetchUsageSnapshot itself rejects a response without the requested
    // client, so the gate's catch handles it: warned, launch proceeds.
    const fake = fakeEnvWith(snapshotScript([]));
    try {
      await assertQuotaHeadroom(
        "claude",
        POLICY,
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(warnings).toEqual([
        "Warning: quota gate skipped: usagemux omitted requested client 'claude'"
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test("a valid snapshot with a nonzero exit warns, proceeds, and caches nothing (review round 4, edges 3)", async () => {
    // usagemux printed a full healthy snapshot and then failed its own
    // cleanup (exit 3): the query is unreadable, so the gate warns and
    // proceeds, and the next gate run queries again instead of reusing
    // the failed reading from the cache.
    const fake = createFakeBinaryEnv({
      usagemux: `printf 'x' >> "$(dirname "$0")/runs"\n${snapshotScript([result()])}; exit 3`,
    });
    const runsPath = join(fake.env.PATH!.split(":")[0]!, "runs");
    try {
      const env = { ...process.env, PATH: fake.env.PATH } as Record<string, string>;
      await assertQuotaHeadroom("claude", POLICY, env);
      await assertQuotaHeadroom("claude", POLICY, env);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain("Warning: quota gate skipped: usagemux exited 3");
      // Two gate runs, two usagemux runs: nothing was cached.
      expect(readFileSync(runsPath, "utf8")).toBe("xx");
    } finally {
      fake.cleanup();
    }
  });

  test("a fetched snapshot is reused inside the cache window", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: `printf 'x' >> "$(dirname "$0")/runs"\n${snapshotScript([result()])}`,
    });
    const runsPath = join(fake.env.PATH!.split(":")[0]!, "runs");
    try {
      const env = { ...process.env, PATH: fake.env.PATH } as Record<string, string>;
      await assertQuotaHeadroom("claude", POLICY, env);
      await assertQuotaHeadroom("claude", POLICY, env);
      expect(readFileSync(runsPath, "utf8")).toBe("x");
      // A new process (the reset stands in for one) queries again.
      resetQuotaGateState();
      await assertQuotaHeadroom("claude", POLICY, env);
      expect(readFileSync(runsPath, "utf8")).toBe("xx");
    } finally {
      fake.cleanup();
    }
  });

  test("a second environment queries its own usagemux, never the first's cached snapshot (round 11, edges 6)", async () => {
    // The cache key covers the whole environment the query receives, PATH
    // included: one process, two environments, two accounts. The second
    // environment's usagemux answers a below-ceiling window; reusing the
    // first's healthy cached snapshot would proceed silently instead.
    const healthy = fakeEnvWith(snapshotScript([result()]));
    const drained = fakeEnvWith(
      snapshotScript([result({ windows: [window({ kind: "primary", remainingPercent: 5 })] })])
    );
    try {
      const envA = { ...process.env, PATH: healthy.env.PATH } as Record<string, string>;
      const envB = { ...process.env, PATH: drained.env.PATH } as Record<string, string>;
      await assertQuotaHeadroom("claude", POLICY, envA);
      expect(warnings).toHaveLength(0);
      const message = await refusal(() => assertQuotaHeadroom("claude", POLICY, envB));
      expect(message).toContain("quota gate: claude: primary window has 5% left");
    } finally {
      healthy.cleanup();
      drained.cleanup();
    }
  });

  test("environments differing only in HOME never share a cached snapshot (round 12, contracts-2 1)", async () => {
    // usagemux resolves its account from HOME, not just PATH: one fake
    // binary on one shared PATH answers per HOME. The old key (agent,
    // resolved usagemux, PATH) saw the same account twice, so HOME B
    // proceeded on HOME A's healthy cached snapshot.
    const homeA = mkdtempSync(join(tmpdir(), "codemux-quota-home-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "codemux-quota-home-b-"));
    const healthyJson = JSON.stringify({ schemaVersion: "1", generatedAt: new Date().toISOString(), results: [result()] });
    const drainedJson = JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      results: [result({ windows: [window({ kind: "primary", remainingPercent: 5 })] })],
    });
    const fake = fakeEnvWith(
      `if [ "$HOME" = '${homeB}' ]; then printf '%s' '${drainedJson}'; else printf '%s' '${healthyJson}'; fi`
    );
    try {
      const base = { ...process.env, PATH: fake.env.PATH } as Record<string, string>;
      await assertQuotaHeadroom("claude", POLICY, { ...base, HOME: homeA });
      expect(warnings).toHaveLength(0);
      const message = await refusal(() =>
        assertQuotaHeadroom("claude", POLICY, { ...base, HOME: homeB })
      );
      expect(message).toContain("quota gate: claude: primary window has 5% left");
    } finally {
      fake.cleanup();
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  test("a spendsFrom mapping gates the harness on the mapped client (audit round 2, B4)", async () => {
    // opencode spends from a Claude subscription usagemux measures under
    // its claude client: with the mapping, the gate queries claude and the
    // refusal names the harness. Without it, the gate asks for opencode,
    // the snapshot omits it, and the launch proceeds on a warning.
    const fake = fakeEnvWith(
      snapshotScript([
        result({ windows: [window({ kind: "primary", remainingPercent: 0, usedPercent: 100 })] }),
      ])
    );
    try {
      const env = { ...process.env, PATH: fake.env.PATH } as Record<string, string>;
      const message = await refusal(() =>
        assertQuotaHeadroom("opencode", { ...POLICY, spendsFrom: { opencode: "claude" } }, env)
      );
      expect(message).toContain("quota gate: opencode: primary window has 0% left");
      warnings = [];
      await assertQuotaHeadroom("opencode", POLICY, env);
      expect(warnings).toEqual([
        // Without the mapping the gate asks for opencode and the snapshot
        // answers with claude's result: unrequested, so unreadable.
        "Warning: quota gate skipped: usagemux returned unrequested client 'claude'",
      ]);
    } finally {
      fake.cleanup();
    }
  });

  test("a usagemux that turns untrusted by query time is a UsageQueryError, not a refusal (round 11, edges 7)", async () => {
    // The resolution itself sits inside the UsageQueryError contract: a
    // plain Error here would reach the gate as codemux's own
    // misconfiguration and refuse the launch, the opposite of the
    // documented warn-and-proceed for an unreadable snapshot.
    const fake = fakeEnvWith(snapshotScript([result()]));
    try {
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "usagemux"), 0o775);
      const env = { ...process.env, PATH: fake.env.PATH } as Record<string, string>;
      let rejection: unknown;
      try {
        // POLICY.timeoutSeconds (15) as milliseconds, spelled out because
        // the policy type admits a per-agent map here.
        await fetchUsageSnapshot(["claude"], 15_000, process.cwd(), env);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(UsageQueryError);
      expect((rejection as Error).message).toContain("not a trusted executable");
    } finally {
      fake.cleanup();
    }
  });
});
