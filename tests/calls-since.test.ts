import { describe, expect, test } from "bun:test";
import { parseSinceOption } from "../src/calls-command.js";

describe("parseSinceOption", () => {
  test("durations subtract from now", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    expect(parseSinceOption("90m", now)!.toISOString()).toBe("2026-10-08T10:30:00.000Z");
    expect(parseSinceOption("7d", now)!.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(parseSinceOption("30s", now)!.toISOString()).toBe("2026-10-08T11:59:30.000Z");
    expect(parseSinceOption("2w", now)!.toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });

  test("Date accepts ISO and non-ISO dates; invalid date text is refused", () => {
    expect(parseSinceOption("2026-10-01T00:00:00Z")!.getTime())
      .toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseSinceOption("October 1, 2026 00:00:00 GMT")!.toISOString())
      .toBe("2026-10-01T00:00:00.000Z");
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

  test("a digit-only value is refused, never an engine-dependent date (review round 361)", () => {
    // On Bun's JSC `new Date("7")` is July 2001 and `new Date("31")` is
    // invalid; V8 rejects both. The first spelling accepted a typo for "7d"
    // with a cutoff 25 years in the past and the whole ledger inside the
    // window at exit 0, while the second was refused — acceptance by
    // engine accident. A bare number is neither a duration nor a date.
    expect(parseSinceOption("7")).toBeNull();
    expect(parseSinceOption("2000")).toBeNull();
    expect(parseSinceOption("31")).toBeNull();
    expect(parseSinceOption(" 7 ")).toBeNull();
  });

  test("a date-only value cuts at UTC midnight, whatever the local zone", () => {
    // The ECMAScript reading of a date-only ISO string: UTC midnight, so
    // the window's clock base is stated rather than mixed silently with
    // the local-now base durations use.
    const cutoff = parseSinceOption("2026-11-08", new Date("2026-11-08T22:30:00.000Z"))!;
    expect(cutoff.toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });
});
