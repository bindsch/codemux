/**
 * usagemux 1.0.1 adds `placeholder` to every usage window (its PROTOCOL.md):
 * true for a window the provider reports without a measurement, false for a
 * measured one. The parser listed the window's fields exactly and refused
 * the new one, so with usagemux 1.0.1 every snapshot was unreadable: `usage
 * --json` exited 1 and the quota gate ran blind (live gate, 2026-11-06).
 */

import { describe, expect, test } from "bun:test";
import { gateOnResult } from "../src/quota-gate.js";
import { formatUsageSnapshot, parseUsageSnapshot } from "../src/usage-protocol.js";
import { POLICY, captureWarnings, refusal, result, window } from "./helpers/quota-gate.js";

const snapshot = (windows: unknown[]): string => JSON.stringify({
  schemaVersion: "1",
  generatedAt: "2026-11-06T12:00:00.000Z",
  results: [{
    client: "codex", provider: "openai", status: "ok", source: "codex-cli", plan: "pro", account: null,
    windows, credits: null, subscriptionRenewsAt: null, subscriptionExpiresAt: null, message: null,
  }],
});

const measured = { kind: "secondary", usedPercent: 79, remainingPercent: 21, windowMinutes: 10_080, resetsAt: "2026-11-08T09:00:00.000Z" };
const unmeasured = { kind: "primary", usedPercent: null, remainingPercent: null, windowMinutes: 300, resetsAt: null };

describe("the placeholder window field of usagemux 1.0.1", () => {
  test("a 1.0.1 snapshot parses, and the field is kept as answered", () => {
    const parsed = parseUsageSnapshot(snapshot([{ ...unmeasured, placeholder: true }, { ...measured, placeholder: false }]));
    expect(parsed.results[0]!.windows).toEqual([{ ...unmeasured, placeholder: true }, { ...measured, placeholder: false }]);
  });

  test("a 1.0.0 snapshot, which has no such field, parses without gaining one", () => {
    const parsed = parseUsageSnapshot(snapshot([measured]));
    expect(parsed.results[0]!.windows).toEqual([measured]);
    expect("placeholder" in parsed.results[0]!.windows[0]!).toBe(false);
  });

  test("a placeholder that is not a boolean, or one beside a percentage, fails the snapshot", () => {
    expect(() => parseUsageSnapshot(snapshot([{ ...measured, placeholder: "yes" }]))).toThrow("placeholder must be a boolean");
    expect(() => parseUsageSnapshot(snapshot([{ ...measured, placeholder: null }]))).toThrow("placeholder must be a boolean");
    expect(() => parseUsageSnapshot(snapshot([{ ...measured, placeholder: true }])))
      .toThrow("a placeholder window must report null percentages");
    // Any other unknown window field is still refused.
    expect(() => parseUsageSnapshot(snapshot([{ ...measured, synthetic: true }])))
      .toThrow("usage window contains unknown field 'synthetic'");
  });

  test("the text form prints an unmeasured window as unknown", () => {
    const text = formatUsageSnapshot(parseUsageSnapshot(snapshot([{ ...unmeasured, placeholder: true }])));
    expect(text).toContain("  primary: remaining unknown");
  });

  test("the quota gate judges the measured windows beside an unmeasured primary", async () => {
    const placeholderPrimary = window({ kind: "primary", usedPercent: null, remainingPercent: null, windowMinutes: 300, placeholder: true });
    // An exhausted weekly tier still refuses: the unmeasured window hides nothing.
    expect(await refusal(() => gateOnResult("codex", result({
      client: "codex",
      windows: [placeholderPrimary, window({ kind: "secondary", usedPercent: 97, remainingPercent: 3, placeholder: false })],
    }), POLICY))).toContain("quota gate: codex: secondary window has 3% left");
    // Alone, it is no evidence of spent quota: the launch proceeds with the
    // note that nothing bounds it.
    const warnings = captureWarnings();
    try {
      expect(() => gateOnResult("codex", result({ client: "codex", windows: [placeholderPrimary] }), POLICY)).not.toThrow();
      expect(warnings.lines).toEqual([
        "Warning: quota gate: codex: no window that bounds model calls reports a remaining percent; proceeding",
      ]);
    } finally {
      warnings.restore();
    }
  });
});
