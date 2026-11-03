/**
 * The quota gate (src/quota-gate.ts): the base decision table — status
 * rows, binding-window refusals, and the weekly over-use warnings. The
 * audit-round-2 window-kind rules live in
 * tests/quota-gate-window-kinds.test.ts and the option parsing in
 * tests/quota-gate-options.test.ts; the fake-usagemux integration paths in
 * tests/quota-gate-usagemux.test.ts; the launch-command refusals in
 * tests/quota-gate-cli.test.ts and tests/quota-gate-session.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { gateOnResult } from "../src/quota-gate.js";
import { formatResetTime } from "../src/usage-protocol.js";
import { POLICY, captureWarnings, refusal, result, window } from "./helpers/quota-gate.js";

describe("quota gate decision table", () => {
  test("not-applicable prints one line naming the unmetered spend and proceeds (audit round 2, B4)", () => {
    // Silent here read as "the gate is off for this harness," which is not
    // what not-applicable says: usagemux has no client for the account the
    // run spends from. One line, exactly once, no Warning prefix — this is
    // an observation, not a skipped check.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult("claude", result({ status: "not-applicable", windows: [] }), POLICY)
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        "quota gate: claude: usage not measured; spends from its configured provider",
      ]);
    } finally {
      warnings.restore();
    }
  });

  // An unreadable provider is not an exhausted one (live gate of
  // 2026-11-02: a usage backend answering in 30 s and an opencode without
  // browser cookies blocked every launch of both harnesses).
  test("error warns with the provider's message and proceeds", () => {
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult("claude", result({ status: "error", windows: [], message: "provider says no" }), POLICY)
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        "Warning: quota gate: claude: usage unreadable (provider says no); proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("unavailable warns with the status itself when it carries no message", () => {
    const warnings = captureWarnings();
    try {
      expect(() => gateOnResult("claude", result({ status: "unavailable", windows: [] }), POLICY)).not.toThrow();
      expect(warnings.lines).toEqual(["Warning: quota gate: claude: usage unreadable (unavailable); proceeding"]);
    } finally {
      warnings.restore();
    }
  });

  test("ok with no binding window warns and proceeds: nothing reports a remaining percent", () => {
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "claude",
          result({
            windows: [
              // An MCP per-window budget does not bound model calls...
              window({ kind: "mcp daily", remainingPercent: 0 }),
              // ...and a window without a remaining percent cannot be compared.
              window({ kind: "primary", remainingPercent: null }),
            ],
          }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        "Warning: quota gate: claude: no window that bounds model calls reports a remaining percent; proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("a binding window below the ceiling refuses, naming it", () => {
    return refusal(async () => {
      gateOnResult(
        "claude",
        result({
          windows: [window({ kind: "primary", usedPercent: 95, remainingPercent: 5, windowMinutes: 300 })],
        }),
        POLICY
      );
    }).then((message) => {
      expect(message).toContain("quota gate: claude: primary window has 5% left");
      expect(message).toContain(`resets ${formatResetTime("2026-11-07T09:00:00.000Z")}`);
      expect(message).toContain("below the 10% ceiling");
    });
  });

  test("a window with unknown resets still names that", () => {
    return refusal(async () => {
      gateOnResult(
        "claude",
        result({
          windows: [window({ kind: "primary", remainingPercent: 2, resetsAt: null })],
        }),
        POLICY
      );
    }).then((message) => {
      expect(message).toContain("resets unknown");
    });
  });

  test("ok above the ceiling proceeds", () => {
    expect(() =>
      gateOnResult(
        "claude",
        result({ windows: [window({ remainingPercent: 61 })] }),
        POLICY
      )
    ).not.toThrow();
  });

  test("an over-used weekly window warns and proceeds", () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({ windows: [window({ usedPercent: 80, remainingPercent: 20 })] }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("quota gate: claude weekly window is 80% used");
    expect(warnings[0]).toContain("above 50%");
    expect(warnings[0]).toContain("proceeding");
  });

  test("a weekly window exactly at the warn threshold stays silent", () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({ windows: [window({ usedPercent: 50, remainingPercent: 50 })] }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(0);
  });

  test("a heavily used non-weekly window does not warn", () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({
          windows: [window({ kind: "primary", usedPercent: 90, remainingPercent: 10, windowMinutes: 300 })],
        }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(0);
  });

  test("a biweekly window is not a weekly window (round 20, minor 12)", () => {
    // The kind test is word-bounded: "biweekly" and "weekday" name other
    // cadences, and the old /week/i matched both, warning about the
    // weekly budget on a fortnightly one.
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({
          windows: [
            window({ kind: "biweekly", usedPercent: 90, remainingPercent: 10, windowMinutes: 20_160 }),
            window({ kind: "weekday", usedPercent: 90, remainingPercent: 10, windowMinutes: 1_440 }),
          ],
        }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(0);
    // The word itself still matches: "weekly cap" is a weekly window.
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({ windows: [window({ kind: "weekly cap", usedPercent: 80, remainingPercent: 20 })] }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("weekly cap");
  });

  test("a weekly window reporting only a used percent still warns", () => {
    // Review round 9, edges finding 2: the warning loop must not inherit
    // the ceiling's remaining-percent set, or this shape passes silently.
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({
          windows: [
            window({ kind: "primary", usedPercent: null, remainingPercent: 90, windowMinutes: 300 }),
            window({ kind: "weekly", usedPercent: 80, remainingPercent: null }),
          ],
        }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("quota gate: claude weekly window is 80% used");
  });

  test("a used-only weekly window with no binding window prints both warnings (round 23, edges 8)", () => {
    // The weekly window is the only one and reports no remaining percent,
    // so the binding set is empty — and the no-binding early return used
    // to skip the weekly loop entirely. Both warnings print now, the
    // weekly one first.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "claude",
          result({ windows: [window({ kind: "weekly", usedPercent: 80, remainingPercent: null })] }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        "Warning: quota gate: claude weekly window is 80% used (above 50%); proceeding",
        "Warning: quota gate: claude: no window that bounds model calls reports a remaining percent; proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("a used-only weekly window below the threshold stays silent", () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({
          windows: [
            window({ kind: "primary", usedPercent: null, remainingPercent: 90, windowMinutes: 300 }),
            window({ kind: "weekly", usedPercent: 40, remainingPercent: null }),
          ],
        }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(0);
  });

  test("a monthly window is not weekly and never warns", () => {
    // Review round 14, contracts 5: weekly is a span of one week within an
    // hour, not any span of a week or longer.
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({
          windows: [
            window({ kind: "primary", usedPercent: null, remainingPercent: 90, windowMinutes: 300 }),
            window({ kind: "monthly", usedPercent: 90, remainingPercent: 10, windowMinutes: 43_200 }),
            window({ kind: "primary", usedPercent: 60, remainingPercent: 40, windowMinutes: 10_079 }),
          ],
        }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("window is 60% used");
  });

  test("a weekly window is recognized by kind as well as span", () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      gateOnResult(
        "claude",
        result({
          windows: [window({ kind: "5-hour weekly cap", windowMinutes: null, usedPercent: 60, remainingPercent: 40 })],
        }),
        POLICY
      );
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
  });
});
