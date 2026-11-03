/**
 * The quota gate's option parsing (src/quota-gate.ts): --quota-ceiling
 * bounds, resolveQuotaGate's flag and config handling, and the per-agent
 * timeout map from audit round 2 (B2). The decision table lives in
 * tests/quota-gate.test.ts; the window-kind rules in
 * tests/quota-gate-window-kinds.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { gateOnResult, parseQuotaCeilingOption, quotaTimeoutSecondsFor, resolveQuotaGate } from "../src/quota-gate.js";
import { POLICY, captureWarnings, result, window } from "./helpers/quota-gate.js";

describe("quota gate options", () => {
  test("--quota-ceiling accepts 0 through 100", () => {
    expect(parseQuotaCeilingOption("0")).toBe(0);
    expect(parseQuotaCeilingOption("50")).toBe(50);
    expect(parseQuotaCeilingOption("100")).toBe(100);
  });

  test("--quota-ceiling refuses anything else", () => {
    for (const bad of ["banana", "", "-1", "101", "1e999"]) {
      expect(() => parseQuotaCeilingOption(bad)).toThrow(
        "--quota-ceiling must be a number from 0 to 100"
      );
    }
  });

  test("resolveQuotaGate turns the gate off by flag and by config", () => {
    expect(resolveQuotaGate({ config: POLICY, disabled: true })).toBeNull();
    expect(resolveQuotaGate({ config: false })).toBeNull();
  });

  test("resolveQuotaGate returns the policy unchanged without a ceiling flag", () => {
    const resolved = resolveQuotaGate({ config: POLICY });
    expect(resolved).toEqual(POLICY);
    expect(resolved).not.toBe(POLICY);
  });

  test("a ceiling flag overrides minRemainingPercent only", () => {
    expect(resolveQuotaGate({ config: POLICY, ceiling: "50" })).toEqual({
      ...POLICY,
      minRemainingPercent: 50,
    });
    expect(() => resolveQuotaGate({ config: POLICY, ceiling: "101" })).toThrow(
      "--quota-ceiling must be a number from 0 to 100"
    );
  });

  test("quotaTimeoutSecondsFor resolves the agent's map entry, then the default (audit round 2, B2)", () => {
    // One number covers every agent; a map names agents per agent and
    // `default` fills the rest (config validation requires it).
    expect(quotaTimeoutSecondsFor(POLICY, "claude")).toBe(15);
    const mapped = { ...POLICY, timeoutSeconds: { default: 60, claude: 90 } };
    expect(quotaTimeoutSecondsFor(mapped, "claude")).toBe(90);
    expect(quotaTimeoutSecondsFor(mapped, "codex")).toBe(60);
  });

  test("a ceiling value is judged even under a disabled gate (round 11, contracts 3)", () => {
    // A bad option value is the caller's mistake whatever the switch
    // says: exit 64, not a silent accept.
    expect(() => resolveQuotaGate({ config: POLICY, disabled: true, ceiling: "banana" })).toThrow(
      "--quota-ceiling must be a number from 0 to 100"
    );
    expect(() => resolveQuotaGate({ config: false, ceiling: "101" })).toThrow(
      "--quota-ceiling must be a number from 0 to 100"
    );
    // A valid ceiling under a disabled gate is ignored, with one stderr
    // note saying it has no effect.
    const notes: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => void notes.push(String(message));
    try {
      expect(resolveQuotaGate({ config: POLICY, disabled: true, ceiling: "50" })).toBeNull();
      expect(resolveQuotaGate({ config: false, ceiling: "50" })).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(notes).toEqual([
      "Warning: --quota-ceiling has no effect: the quota gate is disabled",
      "Warning: --quota-ceiling has no effect: the quota gate is disabled",
    ]);
  });

  // Review round 3, edges finding: the usage protocol accepts control
  // characters in provider-supplied strings; every string the gate prints
  // must go through the same escaping `codemux usage` applies.
  test("provider messages and window kinds print escaped, never raw", () => {
    const message = "lo\x1bgged out\x7f";
    const warnings = captureWarnings();
    try {
      gateOnResult("claude", result({ status: "error", message, windows: [] }), POLICY);
    } finally {
      warnings.restore();
    }
    expect(warnings.lines[0]).toContain("lo\\x1bgged out\\x7f");
    expect(warnings.lines[0]).not.toContain("\x1b");
    // A control character inside a window kind now rides a warning (audit
    // round 2, B1: a kind merely containing "weekly" no longer refuses),
    // and the warning escapes it the same way.
    const kindWarnings = captureWarnings();
    try {
      expect(() =>
        gateOnResult(
          "claude",
          result({ windows: [window({ kind: "we\x1bkly", remainingPercent: 5 })] }),
          POLICY
        )
      ).not.toThrow();
    } finally {
      kindWarnings.restore();
    }
    expect(kindWarnings.lines[0]).toContain("we\\x1bkly");
    expect(kindWarnings.lines.join()).not.toContain("\x1b");
  });
});
