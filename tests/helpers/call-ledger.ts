import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The envelope the fake claude answers with: the same shape the real one
// prints under --output-format json (result-envelope.test.ts's fixture).
export const ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: null,
  result: "OK",
  usage: { input_tokens: 24114, output_tokens: 98, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 },
  total_cost_usd: 0.12735,
  modelUsage: { "claude-opus-5": {} },
});

export const RUN_ARGS = ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"];

// The signal tests spawn the CLI, run a fake harness, and stop it through
// the runner's grace windows; that is seconds of wall time, past bun's 5 s
// default. The budget is not an assertion about the receipt.
export const SIGNAL_TEST_TIMEOUT_MS = 30_000;
// Two CLI launches each stream more than 16 MiB; throughput is not the assertion.
export const LARGE_STREAM_TEST_TIMEOUT_MS = 30_000;

export function ledgerFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codemux-ledger-e2e-"));
  return {
    path: join(dir, "calls.jsonl"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
