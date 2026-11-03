import { describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import {
  assertUsageSnapshotClients,
  buildUsagemuxArguments,
  escapeForTerminal,
  fetchUsageSnapshot,
  formatUsagePercent,
  formatUsageSnapshot,
  getUsagemuxProcessTimeout,
  getUsagemuxStatus,
  parseUsageSnapshot,
  parseUsageTimeoutOption,
} from "../src/usage.js";
import { formatResetTime } from "../src/usage-protocol.js";
import type { UsageSnapshot } from "../src/usage-protocol.js";
import { createFakeBinaryEnv, minimalPath } from "./helpers/cli.js";

const VALID_SNAPSHOT: UsageSnapshot = {
  schemaVersion: "1",
  generatedAt: "2026-08-03T12:00:00.000Z",
  results: [
    {
      client: "codex",
      provider: "codex",
      status: "ok",
      source: "codex-cli",
      plan: "plus",
      account: "user@example.com",
      windows: [
        {
          kind: "weekly",
          usedPercent: 39,
          remainingPercent: 61,
          windowMinutes: 10080,
          resetsAt: "2026-08-07T09:00:00.000Z",
        },
      ],
      credits: { remaining: 12.5, unit: "credits" },
      subscriptionRenewsAt: "2026-09-03T10:00:00.000Z",
      subscriptionExpiresAt: null,
      message: null,
    },
  ],
};

describe("usage protocol", () => {
  test("builds a bounded snapshot request for selected clients", () => {
    expect(buildUsagemuxArguments(["codex", "claude"], 15_000)).toEqual([
      "snapshot",
      "--client",
      "codex",
      "--client",
      "claude",
      "--format",
      "json",
      "--timeout",
      "15",
    ]);
  });

  test("bounds provider timeouts and gives usagemux shutdown grace", () => {
    expect(parseUsageTimeoutOption("0.5")).toBe(500);
    expect(parseUsageTimeoutOption("300")).toBe(300_000);
    // 5 s grace: usagemux's discovery, env preparation, and cleanup sit
    // outside its provider timer (its BACKEND.md), and 2 s fired the outer
    // timer on a cold filesystem.
    expect(getUsagemuxProcessTimeout(300_000)).toBe(305_000);
    for (const bad of ["soon", "", "0", "-1", "301", "1e999"]) {
      expect(() => parseUsageTimeoutOption(bad)).toThrow(
        "--timeout must be a number from 0 (exclusive) to 300 seconds"
      );
    }
  });

  test("forwards fractional timeouts as decimal seconds", () => {
    // The cross-repo grammar: 500 ms reaches usagemux as "--timeout 0.5".
    expect(buildUsagemuxArguments(["codex"], 500)).toEqual([
      "snapshot",
      "--client",
      "codex",
      "--format",
      "json",
      "--timeout",
      "0.5",
    ]);
  });

  test("parses a complete version 1 snapshot field by field", () => {
    // Field-level expectations, never a self-comparison: every value is
    // chosen distinct from its siblings (41.5 vs 58.5, two different
    // timestamps, a named plan and account), so a parser that mixes
    // fields, invents defaults, or echoes its input fails here.
    const text = JSON.stringify({
      schemaVersion: "1",
      generatedAt: "2026-08-03T12:00:00.000Z",
      results: [
        {
          client: "codex",
          provider: "openai",
          status: "ok",
          source: "codex-cli",
          plan: "pro",
          account: "user@example.com",
          windows: [
            {
              kind: "weekly",
              usedPercent: 41.5,
              remainingPercent: 58.5,
              windowMinutes: 10080,
              resetsAt: "2026-08-07T09:00:00.000Z",
            },
          ],
          credits: { remaining: 3.25, unit: "credits" },
          subscriptionRenewsAt: "2026-09-03T10:00:00.000Z",
          subscriptionExpiresAt: null,
          message: null,
        },
      ],
    });
    expect(parseUsageSnapshot(text)).toEqual({
      schemaVersion: "1",
      generatedAt: "2026-08-03T12:00:00.000Z",
      results: [
        {
          client: "codex",
          provider: "openai",
          status: "ok",
          source: "codex-cli",
          plan: "pro",
          account: "user@example.com",
          windows: [
            {
              kind: "weekly",
              usedPercent: 41.5,
              remainingPercent: 58.5,
              windowMinutes: 10080,
              resetsAt: "2026-08-07T09:00:00.000Z",
            },
          ],
          credits: { remaining: 3.25, unit: "credits" },
          subscriptionRenewsAt: "2026-09-03T10:00:00.000Z",
          subscriptionExpiresAt: null,
          message: null,
        },
      ],
    });
  });

  test("rejects unsupported protocol versions", () => {
    expect(() => parseUsageSnapshot(JSON.stringify({
      ...VALID_SNAPSHOT,
      schemaVersion: "2",
    }))).toThrow("unsupported usagemux protocol version '2'");
  });

  test("rejects invalid result percentages", () => {
    const invalid = structuredClone(VALID_SNAPSHOT);
    invalid.results[0]!.windows[0]!.remainingPercent = 101;
    expect(() => parseUsageSnapshot(JSON.stringify(invalid)))
      .toThrow("remainingPercent must be a number from 0 to 100 or null");
  });

  test("requires RFC 3339 timestamps and rejects unknown protocol fields", () => {
    expect(() => parseUsageSnapshot(JSON.stringify({
      ...VALID_SNAPSHOT,
      generatedAt: "2026-08-03",
    }))).toThrow("generatedAt must be an RFC 3339 timestamp");
    expect(() => parseUsageSnapshot(JSON.stringify({
      ...VALID_SNAPSHOT,
      extra: true,
    }))).toThrow("usagemux response contains unknown field 'extra'");
    expect(() => parseUsageSnapshot(JSON.stringify({
      ...VALID_SNAPSHOT,
      results: [{
        ...VALID_SNAPSHOT.results[0],
        subscriptionRenewsAt: "next month",
      }],
    }))).toThrow("subscriptionRenewsAt must be an RFC 3339 timestamp");
  });

  test("requires exactly one result for every requested client", () => {
    const snapshot = parseUsageSnapshot(JSON.stringify(VALID_SNAPSHOT));
    expect(() => assertUsageSnapshotClients(snapshot, ["codex"])).not.toThrow();
    expect(() => assertUsageSnapshotClients(snapshot, ["claude"]))
      .toThrow("usagemux returned unrequested client 'codex'");
    expect(() => assertUsageSnapshotClients(snapshot, ["codex", "claude"]))
      .toThrow("usagemux omitted requested client 'claude'");
    expect(() => assertUsageSnapshotClients({
      ...snapshot,
      results: [...snapshot.results, snapshot.results[0]!],
    }, ["codex"]))
      .toThrow("usagemux returned duplicate client 'codex'");
  });

  test("renders quota windows and unavailable states", () => {
    const snapshot = parseUsageSnapshot(JSON.stringify({
      ...VALID_SNAPSHOT,
      results: [
        ...VALID_SNAPSHOT.results,
        {
          client: "aider",
          provider: null,
          status: "not-applicable",
          source: null,
          plan: null,
          account: null,
          windows: [],
          credits: null,
          subscriptionRenewsAt: null,
          subscriptionExpiresAt: null,
          message: "aider is provider-agnostic",
        },
      ],
    }));

    const output = formatUsageSnapshot(snapshot);
    expect(output).toContain("codex (codex): plus");
    expect(output).toContain("weekly: 61% left");
    expect(output).toContain(`resets ${formatResetTime("2026-08-07T09:00:00.000Z")}`);
    expect(output).toContain("credits: 12.5 credits left");
    // Subscription timestamps are resets too: local time plus a relative
    // span, not a raw UTC instant (audit round 2, B13).
    expect(output).toContain(
      `subscription renews: ${formatResetTime("2026-09-03T10:00:00.000Z")}`
    );
    expect(output).toContain("aider: not-applicable — aider is provider-agnostic");
  });

  test("formatResetTime prints local time plus a relative span (audit round 2, B13)", () => {
    // The local half comes from the same Date getters the formatter uses,
    // so the assertion holds in any timezone; the spans are pinned by the
    // explicit `now`. Nobody converts UTC in their head reading a gate
    // message.
    const now = new Date("2026-11-03T12:00:00.000Z");
    const local = (iso: string): string => {
      const date = new Date(iso);
      const two = (value: number): string => String(value).padStart(2, "0");
      return (
        `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
        `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
      );
    };
    const inDays = "2026-11-05T15:05:00.000Z";
    expect(formatResetTime(inDays, now)).toBe(`${local(inDays)} (in 2 d 3 h)`);
    const inHours = "2026-11-03T13:30:00.000Z";
    expect(formatResetTime(inHours, now)).toBe(`${local(inHours)} (in 1 h 30 m)`);
    const inMinutes = "2026-11-03T12:45:00.000Z";
    expect(formatResetTime(inMinutes, now)).toBe(`${local(inMinutes)} (in 45 m)`);
    const past = "2026-11-03T11:59:00.000Z";
    expect(formatResetTime(past, now)).toBe(`${local(past)} (now)`);
    expect(formatResetTime(null, now)).toBeNull();
    expect(formatResetTime("not-a-timestamp", now)).toBeNull();
  });
});

describe("terminal escaping", () => {
  const ESC = String.fromCharCode(0x1b);

  const snapshotWith = (overrides: Record<string, unknown>) => ({
    schemaVersion: "1" as const,
    generatedAt: "2026-08-13T10:00:00.000Z",
    results: [
      {
        client: "claude" as const,
        provider: "claude",
        status: "ok" as const,
        source: "codexbar",
        plan: null,
        account: null,
        windows: [],
        credits: null,
        subscriptionRenewsAt: null,
        subscriptionExpiresAt: null,
        message: null,
        ...overrides,
      },
    ],
  });

  test("escapeForTerminal neutralizes control characters", () => {
    expect(escapeForTerminal(`${ESC}[2J`)).toBe("\\x1b[2J");
    expect(escapeForTerminal(String.fromCharCode(0x7f))).toBe("\\x7f");
    expect(escapeForTerminal("plain text")).toBe("plain text");
  });

  test("provider-controlled fields cannot emit escape sequences", () => {
    const rendered = formatUsageSnapshot(
      snapshotWith({
        plan: `${ESC}[2JPro`,
        account: `${ESC}]0;title`,
        provider: `${ESC}[31mclaude`,
        credits: { remaining: 5, unit: `${ESC}[0mcredits` },
        windows: [
          {
            kind: `${ESC}[31mprimary`,
            usedPercent: 10,
            remainingPercent: 90,
            windowMinutes: null,
            resetsAt: null,
          },
        ],
      })
    );
    expect(rendered).not.toContain(ESC);
    expect(rendered).toContain("\\x1b[2JPro");
  });

  test("error messages are escaped too", () => {
    const rendered = formatUsageSnapshot(
      snapshotWith({ status: "error", message: `${ESC}[2Jboom` })
    );
    expect(rendered).not.toContain(ESC);
  });
});

describe("window tolerance and percent rendering", () => {
  const snapshotWithWindow = (window: Record<string, unknown>): UsageSnapshot =>
    parseUsageSnapshot(JSON.stringify({
      ...VALID_SNAPSHOT,
      results: [
        {
          ...VALID_SNAPSHOT.results[0],
          windows: [window],
        },
      ],
    }));

  test("negative and non-finite windowMinutes become null", () => {
    // usagemux's PROTOCOL.md puts no positivity constraint on
    // windowMinutes; a provider that reports -1 (unknown span) must not
    // fail the whole snapshot.
    const negative = snapshotWithWindow({
      kind: "weekly",
      usedPercent: 39,
      remainingPercent: 61,
      windowMinutes: -1,
      resetsAt: null,
    });
    expect(negative.results[0]!.windows[0]!.windowMinutes).toBeNull();
    expect(() => snapshotWithWindow({
      kind: "weekly",
      usedPercent: 39,
      remainingPercent: 61,
      windowMinutes: "soon",
      resetsAt: null,
    })).toThrow("windowMinutes must be a finite number or null");
    expect(snapshotWithWindow({
      kind: "weekly",
      usedPercent: 39,
      remainingPercent: 61,
      windowMinutes: null,
      resetsAt: null,
    }).results[0]!.windows[0]!.windowMinutes).toBeNull();
    // JSON `1e999` parses to Infinity (JSON.stringify would write null, so
    // the text is spelled by hand): a protocol violation, never an unbounded
    // pool (review round 53).
    const infinite = JSON.stringify({
      ...VALID_SNAPSHOT,
      results: [{ ...VALID_SNAPSHOT.results[0], windows: [{ kind: "secondary", usedPercent: 100, remainingPercent: 0, windowMinutes: 0, resetsAt: null }] }],
    }).replace('"windowMinutes":0', '"windowMinutes":1e999');
    expect(infinite).toContain("1e999");
    expect(() => parseUsageSnapshot(infinite)).toThrow("windowMinutes must be a finite number or null");
  });

  test("percent values round to two decimals, matching usagemux", () => {
    expect(formatUsagePercent(16.434)).toBe("16.43");
    expect(formatUsagePercent(61)).toBe("61");
    expect(formatUsagePercent(0)).toBe("0");
    expect(formatUsagePercent(100)).toBe("100");
  });

  test("a window that reports only usage prints percent used", () => {
    const rendered = formatUsageSnapshot(snapshotWithWindow({
      kind: "weekly",
      usedPercent: 39.434,
      remainingPercent: null,
      windowMinutes: 10_080,
      resetsAt: null,
    }));
    expect(rendered).toContain("weekly: 39.43% used");
    expect(rendered).not.toContain("% left");
  });

  test("a window that reports neither figure says so", () => {
    const rendered = formatUsageSnapshot(snapshotWithWindow({
      kind: "weekly",
      usedPercent: null,
      remainingPercent: null,
      windowMinutes: 10_080,
      resetsAt: null,
    }));
    expect(rendered).toContain("weekly: remaining unknown");
  });
});

describe("fetchUsageSnapshot against a fake usagemux", () => {
  const envWith = (usagemux: string): { env: Record<string, string>; cleanup: () => void } =>
    createFakeBinaryEnv({ usagemux });

  test("returns the parsed snapshot", async () => {
    const fake = envWith(`printf '%s' '${JSON.stringify(VALID_SNAPSHOT)}'`);
    try {
      const snapshot = await fetchUsageSnapshot(
        ["codex"],
        30_000,
        process.cwd(),
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(snapshot).toEqual(VALID_SNAPSHOT);
    } finally {
      fake.cleanup();
    }
  });

  test("a valid snapshot with a nonzero exit is an unreadable query (review round 4, edges 3)", async () => {
    // usagemux can print a full valid snapshot and still fail its own
    // cleanup; the exit status must decide, or the gate would cache and
    // answer a query the caller cannot trust.
    const fake = envWith(`printf '%s' '${JSON.stringify(VALID_SNAPSHOT)}'; printf 'cleanup failed' >&2; exit 3`);
    try {
      expect(() => fetchUsageSnapshot(
        ["codex"],
        30_000,
        process.cwd(),
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      )).toThrow("usagemux exited 3: cleanup failed");
    } finally {
      fake.cleanup();
    }
  });

  test("reports an oversized response as truncation, not malformed JSON", async () => {
    // 17 MB of stdout crosses the runner's 16 MiB capture bound.
    const fake = envWith("yes a | head -c 17000000");
    try {
      expect(() => fetchUsageSnapshot(
        ["codex"],
        30_000,
        process.cwd(),
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      )).toThrow("usagemux produced more output than codemux will capture");
    } finally {
      fake.cleanup();
    }
  });

  test("names the exit code and stderr of a failing usagemux", async () => {
    const fake = envWith("printf 'boom' >&2; exit 3");
    try {
      expect(() => fetchUsageSnapshot(
        ["codex"],
        30_000,
        process.cwd(),
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      )).toThrow("usagemux exited 3: boom");
    } finally {
      fake.cleanup();
    }
  });

  test("an absent usagemux is an integration failure", async () => {
    expect(() => fetchUsageSnapshot(
      ["codex"],
      30_000,
      process.cwd(),
      { ...process.env, PATH: minimalPath() } as Record<string, string>
    )).toThrow("usagemux is not installed");
  });

  test("getUsagemuxStatus reports an untrusted binary as an issue", () => {
    const fake = envWith("exit 0");
    try {
      chmodSync(join(fake.env.PATH!.split(":")[0]!, "usagemux"), 0o775);
      const status = getUsagemuxStatus(
        process.cwd(),
        { ...process.env, PATH: fake.env.PATH } as Record<string, string>
      );
      expect(status.available).toBe(true);
      expect(status.issue).toContain("usagemux binary is not a trusted executable");
    } finally {
      fake.cleanup();
    }
  });

  test("getUsagemuxStatus reports absence without an issue", () => {
    const status = getUsagemuxStatus(
      process.cwd(),
      { ...process.env, PATH: minimalPath() } as Record<string, string>
    );
    expect(status).toEqual({ available: false, issue: null });
  });
});
