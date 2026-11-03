/**
 * The runner timeout must sit above the shared waitFor helper's 8 s default
 * (audit finding 11): every package test script passes --timeout=10000, so
 * a never-true condition reports waitFor's "timed out waiting for"
 * diagnostic instead of the runner's generic timeout. This test runs the
 * real helper against a condition that never becomes true and proves the
 * rejection is the helper's, inside the runner budget.
 */

import { describe, expect, test } from "bun:test";
import { waitFor } from "./session-codex-e2e-helpers.ts";

describe("waitFor vs the runner timeout", () => {
  test(
    "a never-true condition reports waitFor's diagnostic, not a runner timeout",
    async () => {
      const events = [{ type: "started" }];
      await expect(
        waitFor(events, () => undefined, "a condition that never becomes true")
      ).rejects.toThrow(
        "timed out waiting for a condition that never becomes true; saw: started"
      );
    },
    // The helper's own 8 s default is the deadline under test; the runner
    // budget (10 s via the package scripts) must stay above it.
    9_500
  );
});
