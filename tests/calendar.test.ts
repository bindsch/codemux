import { expect, test } from "bun:test";
import { calendarValid, leapSecondValid, timestampMs } from "../src/calendar.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { snapshotFreshnessIssue } from "../src/quota-gate.js";
import { parseUsageSnapshot } from "../src/usage.js";
import { formatResetTime } from "../src/usage-protocol.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

test("calendarValid refuses calendar dates JavaScript would silently normalize (review round 64)", () => {
  // Date.parse reads 2026-02-30 as March 2 and 2026-02-29 as March 1
  // (2026 is not a leap year): a timestamp recording evidence under its
  // own clock must name a real instant, not one the parser invents.
  expect(calendarValid("2026-02-30T00:00:00Z")).toBe(false);
  expect(calendarValid("2026-02-29T00:00:00Z")).toBe(false);
  expect(calendarValid("2026-13-01T00:00:00Z")).toBe(false);
  expect(calendarValid("2026-11-31T00:00:00Z")).toBe(false);
  expect(calendarValid("2026-10-29T24:00:00Z")).toBe(false);
  expect(calendarValid("2026-10-29T00:60:00Z")).toBe(false);
  expect(calendarValid("2026-10-29T00:00:60Z")).toBe(false);
  // A timestamp without leading calendar fields never matches partially.
  expect(calendarValid("00:00:00Z")).toBe(false);
  expect(calendarValid("")).toBe(false);
  // Real instants, including the ones a naive Date.UTC check would break
  // on: year 1 must not be read as 1901 (review round 61), and the leap
  // day, fractional seconds, and a numeric offset all stay valid.
  expect(calendarValid("0001-01-01T00:00:00Z")).toBe(true);
  expect(calendarValid("2024-02-29T12:34:56Z")).toBe(true);
  expect(calendarValid("2026-10-29T00:00:00.123Z")).toBe(true);
  expect(calendarValid("2026-12-31T23:59:59+05:00")).toBe(true);
});

test("the Codex rollout parser refuses a normalized calendar date and accepts year 1 (review round 64)", () => {
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(["bash"]), () => {}, () => codexDefinitions(["bash"]));
  // The check fires before any payload is read: the nonexistent instant
  // is the failure, whatever the line carries.
  // A timestamp without a zone reads in the host's zone (review round
  // 265): the same evidence named different instants on different hosts,
  // so the RFC 3339 rule, zone included, applies to rollout lines too.
  expect(() => parser.accept({ timestamp: "2026-10-29T01:02:03", type: "world_state", payload: {} }))
    .toThrow("Invalid Codex rollout timestamp '2026-10-29T01:02:03'");
  // A leap second is a valid RFC 3339 instant the validator accepts; the
  // conversion must not read it as NaN (review round 268).
  expect(() => parser.accept({ ...codexCatalog(["bash"]), timestamp: "2016-12-31T23:59:60Z" })).not.toThrow();
  expect(timestampMs("2016-12-31T23:59:60Z")).toBe(Date.parse("2017-01-01T00:00:00Z"));
  expect(() => parser.accept({ timestamp: "2026-02-30T00:00:00Z", type: "world_state", payload: {} }))
    .toThrow(expect.objectContaining({ code: "harness_log_missing" }));
  // The earliest instants stay valid: setUTCFullYear reads year 1 as
  // itself, so the guard does not trade one normalization for another.
  expect(() => parser.accept({ ...codexCatalog(["bash"]), timestamp: "0001-01-01T00:00:00Z" })).not.toThrow();
});

test("a leap second is valid only where one happened, and reads as the second after 23:59:59 (review rounds 133, 134)", () => {
  // RFC 3339 allows second 60; Date.parse rejects it, so a legal timestamp
  // used to fail as malformed.
  expect(leapSecondValid("1990-12-31T23:59:60Z")).toBe(true);
  expect(leapSecondValid("2016-12-31T23:59:60.5Z")).toBe(true);
  expect(leapSecondValid("2015-06-30T23:59:60Z")).toBe(true);
  // The same instant written with an offset.
  expect(leapSecondValid("1991-01-01T00:59:60+01:00")).toBe(true);
  // Second 60 anywhere else is not a leap second.
  expect(leapSecondValid("2026-11-05T12:00:60Z")).toBe(false);
  expect(leapSecondValid("2026-11-05T23:59:60Z")).toBe(false);
  expect(leapSecondValid("2016-12-31T23:59:60+05:00")).toBe(false);
  expect(leapSecondValid("2026-02-30T23:59:60Z")).toBe(false);
  // A month end, or even a year end, where no leap second was inserted.
  expect(leapSecondValid("2016-01-31T23:59:60Z")).toBe(false);
  expect(leapSecondValid("2016-06-30T23:59:60Z")).toBe(false);
  expect(leapSecondValid("2026-12-31T23:59:60Z")).toBe(false);
  expect(leapSecondValid("1971-12-31T23:59:60Z")).toBe(false);
  // Not a leap second at all.
  expect(leapSecondValid("2026-12-31T23:59:59Z")).toBe(false);
  expect(leapSecondValid("")).toBe(false);
  // The reader: one second after 23:59:59, fraction kept; every other
  // value is what Date.parse answers.
  expect(timestampMs("1990-12-31T23:59:60Z")).toBe(Date.parse("1991-01-01T00:00:00Z"));
  expect(timestampMs("2016-12-31T23:59:60.5Z")).toBe(Date.parse("2017-01-01T00:00:00.5Z"));
  expect(timestampMs("2026-11-05T12:00:00Z")).toBe(Date.parse("2026-11-05T12:00:00Z"));
  expect(Number.isNaN(timestampMs("not a time"))).toBe(true);
  expect(Number.isNaN(timestampMs("2026-13-01T00:00:60Z"))).toBe(true);
});

test("a usage snapshot with a leap-second timestamp is accepted and read, not called malformed (review round 133)", () => {
  const snapshot = (generatedAt: string, resetsAt: string): string => JSON.stringify({
    schemaVersion: "1",
    generatedAt,
    results: [{
      client: "codex", provider: "codex", status: "ok", source: "codex-cli", plan: "plus", account: null,
      windows: [{ kind: "weekly", usedPercent: 39, remainingPercent: 61, windowMinutes: 10080, resetsAt }],
      credits: null, subscriptionRenewsAt: null, subscriptionExpiresAt: null, message: null,
    }],
  });
  const leap = "2016-12-31T23:59:60Z";
  expect(() => parseUsageSnapshot(snapshot(leap, leap))).not.toThrow();
  // Second 60 anywhere else is still not a timestamp.
  expect(() => parseUsageSnapshot(snapshot("2026-11-05T12:00:60Z", leap)))
    .toThrow("generatedAt must be an RFC 3339 timestamp");
  expect(() => parseUsageSnapshot(snapshot(leap, "2026-11-05T12:00:60Z")))
    .toThrow("resetsAt must be an RFC 3339 timestamp");
  // The two readers of these fields read a leap second as an instant.
  expect(formatResetTime(leap, new Date("2016-12-31T00:00:00Z"))).not.toBeNull();
  expect(snapshotFreshnessIssue({ generatedAt: leap })).toContain("stale");
  const now = Date.now;
  Date.now = () => Date.parse("2017-01-01T00:00:10Z");
  try {
    expect(snapshotFreshnessIssue({ generatedAt: leap })).toBeNull();
  } finally {
    Date.now = now;
  }
});

