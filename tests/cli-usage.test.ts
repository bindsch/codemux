import { describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";
import { AGENT_IDS, type AgentId } from "../src/types.js";

describe("CLI - Usage", () => {
  const snapshot = JSON.stringify({
    schemaVersion: "1",
    generatedAt: "2026-08-03T12:00:00.000Z",
    results: [
      {
        client: "codex",
        provider: "codex",
        status: "ok",
        source: "codex-cli",
        plan: "plus",
        account: null,
        windows: [
          {
            kind: "weekly",
            usedPercent: 39,
            remainingPercent: 61,
            windowMinutes: 10080,
            resetsAt: "2026-08-07T09:00:00.000Z",
          },
        ],
        credits: null,
        subscriptionRenewsAt: null,
        subscriptionExpiresAt: null,
        message: null,
      },
    ],
  });

  // A snapshot over any set of clients, every result not-applicable: the
  // cheapest valid body for tests that only care WHICH clients were asked.
  const snapshotFor = (clients: readonly AgentId[]): string =>
    JSON.stringify({
      schemaVersion: "1",
      generatedAt: "2026-08-03T12:00:00.000Z",
      results: clients.map((client) => ({
        client,
        provider: null,
        status: "not-applicable",
        source: null,
        plan: null,
        account: null,
        windows: [],
        credits: null,
        subscriptionRenewsAt: null,
        subscriptionExpiresAt: null,
        message: null,
      })),
    });

  test("prints validated usagemux JSON for one agent", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${snapshot}'`,
    });
    try {
      const result = await runCli(["usage", "-a", "codex", "--json"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(JSON.parse(snapshot));
    } finally {
      fake.cleanup();
    }
  });

  test("renders a concise human usage summary", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${snapshot}'`,
    });
    try {
      const result = await runCli(["usage", "-a", "codex"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("codex (codex): plus");
      expect(result.stdout).toContain("weekly: 61% left");
    } finally {
      fake.cleanup();
    }
  });

  test("fails only the usage command when usagemux is absent", async () => {
    const usage = await runCli(["usage"], { PATH: minimalPath() });
    expect(usage.exitCode).toBe(69);
    expect(usage.stderr).toContain("usagemux is not installed");
    expect(usage.stderr).toContain("optional usage integration");

    const list = await runCli(["list"], { PATH: minimalPath() });
    expect(list.exitCode).toBe(0);
  });

  test("rejects unknown agents before invoking usagemux", async () => {
    const result = await runCli(["usage", "-a", "unknown"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain("Unknown agent 'unknown'");
  });

  test("rejects combining one agent with all agents", async () => {
    const result = await runCli(["usage", "-a", "codex", "--all"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain("--agent and --all cannot be used together");
  });

  test("a bad --timeout exits 64 even when usagemux is untrusted (round 28, edges 6)", async () => {
    const fake = createFakeBinaryEnv({ usagemux: `printf '%s' '${snapshot}'` });
    try {
      // Group-writable fails the same trust check the launch path applies.
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "usagemux"), 0o775);
      const result = await runCli(["usage", "--timeout", "301"], fake.env);
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("--timeout must be a number from 0 (exclusive) to 300 seconds");
    } finally {
      fake.cleanup();
    }
  });

  test("rejects usage timeouts above the usagemux protocol maximum", async () => {
    const result = await runCli(["usage", "--timeout", "301"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain(
      "--timeout must be a number from 0 (exclusive) to 300 seconds"
    );
  });

  test("fails closed on malformed protocol output", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: "printf '%s' '{\"schemaVersion\":\"2\",\"results\":[]}'",
    });
    try {
      const result = await runCli(["usage", "-a", "codex"], fake.env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unsupported usagemux protocol version '2'");
    } finally {
      fake.cleanup();
    }
  });

  test("a parsed snapshot over a nonzero usagemux exit is an unreadable query", async () => {
    // Review round 4, edges finding 3: usagemux can print a full valid
    // snapshot and still fail its own cleanup (exit 69 here). The exit
    // status is part of the query, so codemux exits 1 without answering
    // or caching it; 69 stays reserved for the integration being absent
    // or untrusted.
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${snapshot}'; exit 69`,
    });
    try {
      const result = await runCli(["usage", "-a", "codex"], fake.env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("usagemux exited 69");
      expect(result.stdout).not.toContain("codex (codex): plus");
    } finally {
      fake.cleanup();
    }
  });

  test("--json passes values through except DEL and C1, escaped", async () => {
    // JSON.stringify escapes C0 controls but leaves DEL and the C1 range
    // raw; --json layers escapeJsonControls on top, as `calls --json` does.
    const DEL = String.fromCharCode(0x7f);
    const C1 = String.fromCharCode(0x85);
    const raw = JSON.stringify({
      ...JSON.parse(snapshot),
      results: [
        { ...JSON.parse(snapshot).results[0], account: `a${DEL}b${C1}c` },
      ],
    });
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${raw}'`,
    });
    try {
      const result = await runCli(["usage", "-a", "codex", "--json"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("\\u007f");
      expect(result.stdout).toContain("\\u0085");
      expect(result.stdout).not.toContain(DEL);
      expect(result.stdout).not.toContain(C1);
    } finally {
      fake.cleanup();
    }
  });

  test("the no-agent default queries every agent except agy", async () => {
    // The snapshot omits agy, so the request set is proven by success:
    // codemux requires exactly one result per client it asked for, and a
    // request for agy against this snapshot fails instead.
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${snapshotFor(AGENT_IDS.filter((id) => id !== "agy"))}'`,
    });
    try {
      const result = await runCli(["usage"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("codex:");
      expect(result.stdout).toContain("aider:");
      expect(result.stdout).not.toContain("agy:");
    } finally {
      fake.cleanup();
    }
  });

  test("--all queries every agent, agy included", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${snapshotFor(AGENT_IDS)}'`,
    });
    try {
      const result = await runCli(["usage", "--all"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("agy:");
    } finally {
      fake.cleanup();
    }
  });

  test("-a agy still reaches the slow agy probe when asked", async () => {
    const fake = createFakeBinaryEnv({
      usagemux: `printf '%s' '${snapshotFor(["agy"])}'`,
    });
    try {
      const result = await runCli(["usage", "-a", "agy"], fake.env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("agy:");
    } finally {
      fake.cleanup();
    }
  });
});
