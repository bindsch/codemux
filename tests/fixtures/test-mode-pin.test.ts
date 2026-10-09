/**
 * The child of tests/test-mode-ledger.test.ts: one test, run by a
 * `bun test --preload ./tests/setup.ts` with both ledger variables
 * stripped from the environment, that fails unless the preload's redirect
 * carries — `CODEMUX_TEST_LEDGER` is set, the append path resolves to it
 * (not the neutral HOME's state directory), and a record appended with
 * the default environment lands in it (review ul4). It also runs as part
 * of the ordinary suite, where the same assertions hold in-process.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendCallRecord,
  appendLedgerPath,
  CALL_LOG_ENV,
  CALL_LOG_TEST_ENV,
  callLogPath,
} from "../../src/call-log.js";

test("the preload's CODEMUX_TEST_LEDGER owns the append, never the real ledger", () => {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env[CALL_LOG_ENV];
  const redirected = env[CALL_LOG_TEST_ENV];
  // The preload ran: the redirect variable is set and named by the append
  // path, and the record lands in it.
  expect(typeof redirected).toBe("string");
  expect(redirected).not.toBe("");
  expect(appendLedgerPath(env)).toBe(resolve(redirected!));
  expect(appendLedgerPath(env)).not.toBe(callLogPath(env));
  appendCallRecord(
    {
      ts: "2026-10-08T12:00:00.000Z",
      kind: "run",
      agent: "claude",
      model: null,
      model_effective: null,
      provider: "default",
      session_id: null,
      turn_id: null,
      autonomy: null,
      hermetic: false,
      sandboxed: false,
      exit_code: 0,
      finish: null,
      duration_ms: 454545,
      cwd: "/tmp",
      usage: {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      },
    },
    env
  );
  const lines = readFileSync(redirected!, "utf8").split("\n").filter((line) => line !== "");
  expect(JSON.parse(lines[lines.length - 1]!).duration_ms).toBe(454545);
});
