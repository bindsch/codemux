// The hermetic-check declaration's fallback arm: an agent with no entry in
// the instruction-channel table is an OPEN limitation that names the
// check's refusal, so a new agent cannot reach the declaration gate as
// supported by omission. No shipped agent's declaration reaches the arm
// (cursor, the one agent without an entry, is declared directly), so a
// synthetic id exercises it.
import { expect, test } from "bun:test";
import { hermeticCheckDeclaration } from "../src/parity/reasons-run-check.js";
import type { AgentId } from "../src/types.js";

test("an agent missing from the channel table is an OPEN limitation with the check's refusal", () => {
  const state = hermeticCheckDeclaration("unlisted" as AgentId, "tests/parity-hermetic-check-declaration.test.ts");
  expect(state).toMatchObject({ state: "harness-limitation" });
  if (state.state !== "harness-limitation") throw new Error("unreachable");
  expect(state.reason).toStartWith("OPEN: unlisted has no hermetic instruction-check channel");
  expect(JSON.stringify(state)).toContain("unlisted does not support a hermetic instruction check");
});
