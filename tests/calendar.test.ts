import { expect, test } from "bun:test";
import { calendarValid } from "../src/calendar.js";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
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
  expect(() => parser.accept({ timestamp: "2026-02-30T00:00:00Z", type: "world_state", payload: {} }))
    .toThrow(expect.objectContaining({ code: "harness_log_missing" }));
  // The earliest instants stay valid: setUTCFullYear reads year 1 as
  // itself, so the guard does not trade one normalization for another.
  expect(() => parser.accept({ ...codexCatalog(["bash"]), timestamp: "0001-01-01T00:00:00Z" })).not.toThrow();
});
