import { expect, test } from "bun:test";
import { assertSessionOptionsSupported } from "../src/session/cli-policy.js";
import { UsageRefusalError } from "../src/validation.js";

test("session options without run-only limits remain supported", () => {
  expect(() => assertSessionOptionsSupported({})).not.toThrow();
  expect(() => assertSessionOptionsSupported({ sandbox: true, final: true })).not.toThrow();
});

test.each([
  { sandboxAccount: "ledger.jsonl" },
  { sandboxAccountId: "call-1" },
])("sessions refuse each accounting option before launch: %j", (options) => {
  expect(() => assertSessionOptionsSupported(options)).toThrow(UsageRefusalError);
  expect(() => assertSessionOptionsSupported(options)).toThrow(
    "--sandbox-account and --sandbox-account-id are not supported for sessions"
  );
});

test("sessions refuse the headless spend limit before launch", () => {
  expect(() => assertSessionOptionsSupported({ maxBudgetUsd: "1" })).toThrow(UsageRefusalError);
  expect(() => assertSessionOptionsSupported({ maxBudgetUsd: "1" })).toThrow(
    "--max-budget-usd is not supported for sessions"
  );
});
