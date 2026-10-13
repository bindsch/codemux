import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import { callLogPath } from "../src/call-log.js";

const read = (path: string): string =>
  readFileSync(join(import.meta.dir, "..", path), "utf8");
const reference = read("docs/results-and-usage.md");

describe("published results and ledger contract", () => {
  test("documents HOME-derived state and the explicit override", () => {
    expect(callLogPath({ HOME: "/example", XDG_STATE_HOME: "/ignored" }, "linux"))
      .toBe("/example/.local/state/codemux/calls.jsonl");
    expect(callLogPath({ CODEMUX_CALL_LOG: "off" }, "linux")).toBeNull();
    for (const value of ["HOME", "XDG_STATE_HOME", "CODEMUX_CALL_LOG", "CODEMUX_TEST_LEDGER"]) {
      expect(reference).toContain(value);
    }
  });

  test("documents every ledger and usage field", () => {
    for (const field of [
      "ts", "kind", "agent", "provider", "cwd", "model", "model_effective",
      "session_id", "turn_id", "autonomy", "hermetic", "sandboxed", "exit_code",
      "finish", "duration_ms", "usage", "input_tokens", "cached_input_tokens",
      "output_tokens", "total_tokens", "cost_usd",
    ]) expect(reference).toContain("`" + field + "`");
  });

  test("separates line, retained output, and stderr bounds", () => {
    expect(reference).toContain(MAX_CAPTURE_BYTES / (1024 * 1024) + " MiB");
    expect(reference).toMatch(/individual input line/);
    expect(reference).toMatch(/retained[\s\S]*?reply\/output/);
    expect(reference).toMatch(/Stderr remains bounded/);
    expect(reference).toContain("exit 125");
    expect(reference).not.toContain("cannot outgrow");
    // Existing end-to-end tests exercise both aggregate and individual limits.
    expect(read("tests/call-ledger-e2e.test.ts")).toContain("40 MiB opencode tool line");
  });

  test("states driver-invocation tokens, lifetime cost, and partial-history limits", () => {
    expect(reference).toMatch(/resumed driver starts token counters empty/);
    expect(reference).toMatch(/reports 20, not 120/);
    expect(reference).toContain("session-lifetime cost");
    expect(reference).toContain("no invocation ID");
    expect(reference).toContain("interval-attributable spending");
  });

  test("documents completion ordering and mixed JSON/totals output", () => {
    expect(reference).toContain("reverse append order");
    expect(reference).toContain("JavaScript Date");
    expect(reference).toContain("`--json --sum`");
    expect(reference).toMatch(/not a pure JSONL stream/);
  });

  test("the current reference is discoverable without duplicating it in README", () => {
    expect(read("README.md")).toContain("/docs/results-and-usage.md");
    expect(read("docs/index.md")).toContain("(results-and-usage.md)");
  });
});
