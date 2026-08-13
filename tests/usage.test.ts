import { describe, expect, test } from "bun:test";
import {
  assertUsageSnapshotClients,
  buildUsagemuxArguments,
  escapeForTerminal,
  formatUsageSnapshot,
  getUsagemuxProcessTimeout,
  parseUsageSnapshot,
  parseUsageTimeoutOption,
} from "../src/usage.js";
import type { UsageSnapshot } from "../src/usage-protocol.js";

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
    expect(getUsagemuxProcessTimeout(300_000)).toBe(302_000);
    expect(() => parseUsageTimeoutOption("301")).toThrow(
      "--timeout must be a number from 0 (exclusive) to 300 seconds"
    );
  });

  test("accepts a complete version 1 snapshot", () => {
    expect(parseUsageSnapshot(JSON.stringify(VALID_SNAPSHOT))).toEqual(VALID_SNAPSHOT);
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
    expect(output).toContain("resets 2026-08-07T09:00:00.000Z");
    expect(output).toContain("credits: 12.5 credits left");
    expect(output).toContain("subscription renews: 2026-09-03T10:00:00.000Z");
    expect(output).toContain("aider: not-applicable — aider is provider-agnostic");
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
