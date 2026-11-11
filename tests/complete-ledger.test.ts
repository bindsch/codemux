import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCallRecord, costSourceFor, readCallLog, type CallRecord } from "../src/call-log.js";
import { printTotals } from "../src/calls-totals.js";
import { ledgerScratch } from "./helpers/complete-fakes.js";

function completeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    ts: "2026-11-09T10:00:00.000Z",
    kind: "complete",
    agent: null,
    model: "gpt-4o",
    model_effective: "gpt-4o-2024-08-06",
    model_alias: null,
    provider: "api.openai.com",
    session_id: null,
    turn_id: null,
    autonomy: null,
    hermetic: false,
    sandboxed: false,
    exit_code: null,
    finish: "stop",
    duration_ms: 5,
    cwd: "/repo",
    labels: null,
    usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, total_tokens: 12, cost_usd: 0.5 },
    ...overrides,
  };
}

describe("complete records in the call ledger", () => {
  test("the writer classifies a complete record's cost; the reader accepts only agent null for it", () => {
    const scratch = ledgerScratch();
    try {
      appendCallRecord(completeRecord(), scratch.environment);
      appendCallRecord(completeRecord({ cost_source: "billed" }), scratch.environment);
      appendCallRecord(completeRecord({ usage: { input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null } }), scratch.environment);
      expect(scratch.records().map((row) => row.cost_source)).toEqual(["price-table", "billed", null]);
      const path = scratch.environment.CODEMUX_CALL_LOG!;
      const good = JSON.stringify(completeRecord({ cost_source: "price-table" }));
      writeFileSync(join(path), [
        good,
        JSON.stringify({ ...completeRecord(), agent: "codex" }),
        JSON.stringify({ ...completeRecord(), kind: "run" }),
        JSON.stringify({ ...completeRecord(), cost_source: "invented" }),
      ].join("\n") + "\n");
      const read = readCallLog(path);
      expect(read.malformed).toBe(3);
      expect(read.entries.filter((entry) => entry.record !== null)).toHaveLength(1);
    } finally {
      scratch.cleanup();
    }
    expect(costSourceFor(null, 1)).toBe("price-table");
    expect(costSourceFor(null, null)).toBeNull();
  });

  test("--sum prints the price-table estimate on its own line, billed charges in the total", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printTotals([
        completeRecord({ cost_source: "price-table", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, total_tokens: 12, cost_usd: 0.25 } }),
        completeRecord({ cost_source: "billed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, total_tokens: 12, cost_usd: 1 } }),
        completeRecord({ cost_source: null }),
      ]);
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines[0]).toContain("cost=$1.0000");
      expect(lines[1]).toBe("Totals price-table estimate $0.7500 — codemux complete priced the reported tokens (src/complete/prices.ts)");
    } finally {
      log.mockRestore();
    }
  });
});
