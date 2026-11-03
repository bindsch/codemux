/**
 * The quota gate's window-kind rules from audit round 2 (src/quota-gate.ts):
 * what refuses, what warns. Only the `primary` window and a week-span
 * `secondary`/`tertiary` tier window refuse (B1); every other pool below the
 * ceiling warns and proceeds, and only `mcp` stays non-binding (B7); credits
 * at zero warn on their own (B10). The base decision table lives in
 * tests/quota-gate.test.ts; the option parsing in
 * tests/quota-gate-options.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { gateOnResult } from "../src/quota-gate.js";
import { formatResetTime } from "../src/usage-protocol.js";
import { POLICY, captureWarnings, refusal, result, window } from "./helpers/quota-gate.js";

describe("quota gate window kinds (audit round 2)", () => {
  test("an unscoped weekly window at 0% warns and proceeds (audit round 2, B1)", () => {
    // "unscoped" still does not match the non-binding kind pattern — the
    // window gates at the ceiling and warns below it — but its kind names
    // a pool, not the provider's primary window or a weekly tier, so it
    // no longer refuses a launch on its own.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "claude",
          result({ windows: [window({ kind: "unscoped weekly", remainingPercent: 0 })] }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        `Warning: quota gate: claude: unscoped weekly window has 0% left (resets ${formatResetTime("2026-11-07T09:00:00.000Z")}), below the 10% ceiling; proceeding (not the primary window)`,
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("an mcp window at 0% still never gates on its percent", () => {
    // The whole-word fix keeps the per-window MCP budget non-binding: at
    // 0% remaining the outcome is the missing-binding-window warning,
    // never a percent refusal.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult("claude", result({ windows: [window({ kind: "mcp daily", remainingPercent: 0 })] }), POLICY)
      ).not.toThrow();
      expect(warnings.lines[0]).toContain("no window that bounds model calls");
    } finally {
      warnings.restore();
    }
  });

  test("an exhausted pool that is neither primary nor weekly warns and proceeds", () => {
    // Live gate of 2026-11-02: cursor's third window is the third-party
    // model pool; its exhaustion refused every cursor launch while the
    // plan pool had 42% left.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "cursor",
          result({
            client: "cursor",
            provider: "cursor",
            windows: [
              window({ kind: "primary", usedPercent: 58, remainingPercent: 42, windowMinutes: 44_640 }),
              window({ kind: "tertiary", usedPercent: 100, remainingPercent: 0, windowMinutes: 44_640 }),
            ],
          }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        `Warning: quota gate: cursor: tertiary window has 0% left (resets ${formatResetTime("2026-11-07T09:00:00.000Z")}), below the 10% ceiling; proceeding (not the primary window)`,
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("an exhausted weekly tier window refuses by span, whatever its name (audit round 2, B1)", () => {
    return refusal(async () => {
      gateOnResult(
        "codex",
        result({
          windows: [
            window({ kind: "primary", remainingPercent: 80, windowMinutes: 300 }),
            window({ kind: "secondary", remainingPercent: 3, windowMinutes: 10_080 }),
          ],
        }),
        POLICY
      );
    }).then((message) => {
      expect(message).toContain("quota gate: codex: secondary window has 3% left");
    });
  });

  test("agy's kind-named weekly pool at 5% warns and proceeds (audit round 2, B1)", () => {
    // The live snapshot carries antigravity-quota-summary-3p-weekly: the
    // kind names the third-party model pool, not the plan window, and the
    // old name test refused every agy launch on it.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "agy",
          result({
            client: "agy",
            windows: [
              window({
                kind: "antigravity-quota-summary-3p-weekly",
                usedPercent: 95,
                remainingPercent: 5,
                windowMinutes: 10_080,
              }),
            ],
          }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        `Warning: quota gate: agy: antigravity-quota-summary-3p-weekly window has 5% left (resets ${formatResetTime("2026-11-07T09:00:00.000Z")}), below the 10% ceiling; proceeding (not the primary window)`,
        "Warning: quota gate: agy antigravity-quota-summary-3p-weekly window is 95% used (above 50%); proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("cursor's grok pool, a weekly span under a non-weekly name, warns (audit round 2, B1)", () => {
    // cursor-grok-bot carries windowMinutes 10_080 but no "weekly" in its
    // kind: under the old rules it refused on the span while the same pool
    // named "-5h" only warned. Pools warn; tiers refuse.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "cursor",
          result({
            client: "cursor",
            windows: [
              window({ kind: "cursor-grok-bot", usedPercent: 98, remainingPercent: 2, windowMinutes: 10_080 }),
            ],
          }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines[0]).toContain("cursor-grok-bot window has 2% left");
      expect(warnings.lines[0]).toContain("proceeding (not the primary window)");
    } finally {
      warnings.restore();
    }
  });

  test("claude's scoped fable allowance at 0% warns and proceeds (audit round 2, B7)", () => {
    // claude-weekly-scoped-fable is a real weekly budget — the "scoped"
    // word used to match the old non-binding pattern, so an exhausted
    // allowance passed without a word.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "claude",
          result({
            windows: [
              window({ kind: "primary", usedPercent: 40, remainingPercent: 60, windowMinutes: 300 }),
              window({ kind: "claude-weekly-scoped-fable", usedPercent: 100, remainingPercent: 0 }),
            ],
          }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        `Warning: quota gate: claude: claude-weekly-scoped-fable window has 0% left (resets ${formatResetTime("2026-11-07T09:00:00.000Z")}), below the 10% ceiling; proceeding (not the primary window)`,
        "Warning: quota gate: claude claude-weekly-scoped-fable window is 100% used (above 50%); proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });

  test("exhausted credits warn and proceed even beside healthy windows (audit round 2, B10)", () => {
    // Credits are a prepaid meter the windows do not carry: zero means
    // every API-key call fails. The warning fires before any window logic
    // can return early, so it prints exactly once with the unit named.
    const warnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "codex",
          result({
            client: "codex",
            windows: [window({ kind: "primary", usedPercent: 58, remainingPercent: 42, windowMinutes: 300 })],
            credits: { remaining: 0, unit: "credits" },
          }),
          POLICY
        )
      ).not.toThrow();
      expect(warnings.lines).toEqual([
        "Warning: quota gate: codex: credits exhausted (0 credits left); proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });
});
