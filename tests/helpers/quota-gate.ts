// Shared fixtures for the quota-gate test files: the policy under test,
// usage-result factories, and the refusal-capture helper. The gate lives
// in src/quota-gate.ts; tests/quota-gate.test.ts owns the decision table.
import { UsageRefusalError } from "../../src/validation.js";
import type { QuotaPolicy } from "../../src/types.js";
import type { UsageResult, UsageWindow } from "../../src/usage-protocol.js";

export const POLICY: QuotaPolicy = {
  minRemainingPercent: 10,
  weeklyWarnUsedPercent: 50,
  timeoutSeconds: 15,
};

export const window = (overrides: Partial<UsageWindow> = {}): UsageWindow => ({
  kind: "weekly",
  usedPercent: 39,
  remainingPercent: 61,
  windowMinutes: 10_080,
  resetsAt: "2026-11-07T09:00:00.000Z",
  ...overrides,
});

export const result = (overrides: Partial<UsageResult> = {}): UsageResult => ({
  client: "claude",
  provider: "claude",
  status: "ok",
  source: null,
  plan: null,
  account: null,
  windows: [window()],
  credits: null,
  subscriptionRenewsAt: null,
  subscriptionExpiresAt: null,
  message: null,
  ...overrides,
});

export const refusal = async (fn: () => Promise<void> | void): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof UsageRefusalError) return error.message;
    throw error;
  }
  throw new Error("expected a UsageRefusalError");
};

/** Captures console.error lines (the gate's warnings) until restore(). */
export const captureWarnings = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => void lines.push(String(message));
  return { lines, restore: () => { console.error = original; } };
};
