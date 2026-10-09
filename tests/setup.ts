/**
 * The test-run ledger redirect: `--preload` loads this file before every
 * test module, and it points `CODEMUX_TEST_LEDGER` at a per-process temp
 * file so the suite's appends never touch the operator's real ledger
 * (call-log.ts consults the variable only when `CODEMUX_CALL_LOG` is
 * unset — round ul4; the old `NODE_ENV=test` detection is gone, because a
 * generic variable another process may set silently discarded real
 * records). An exported `CODEMUX_TEST_LEDGER` (CI pinning one path for a
 * whole run) keeps its word.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "codemux-test-ledger-"));
process.env.CODEMUX_TEST_LEDGER ??= join(dir, "calls.jsonl");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort; a leftover temp directory is not a failure.
  }
});
