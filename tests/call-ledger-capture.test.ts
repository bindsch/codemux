import { describe, expect, test } from "bun:test";
import { CALL_LOG_ENV, readCallLog } from "../src/call-log.js";
import type { CallRecord } from "../src/call-log.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { RUN_ARGS, LARGE_STREAM_TEST_TIMEOUT_MS, ledgerFile } from "./helpers/call-ledger.js";

describe("the launched call ledger capture paths", () => {
  test("a run whose stdout is not valid UTF-8 still writes its receipt (ul8)", async () => {
    // The ul8 defect: a capture rejection skipped recordCompletedLaunch
    // entirely — the harness ran and spent its tokens, but the ledger
    // stayed silent and the never-fail contract reported the miss nowhere.
    // The failure receipt now writes through the never-fail append before
    // the rejection travels: the CLI's failure exit code, null usage
    // (nothing structured was parsed), model_effective null.
    const fake = createFakeBinaryEnv({
      claude: [
        'case " $* " in',
        '  *" --version "*) printf \'2.1.220\\n\'; exit 0;;',
        "esac",
        // Octal escapes: the two bytes after "ok" are 0xff 0xfe, invalid
        // UTF-8 the fatal decoder refuses mid-stream.
        "printf 'ok\\377\\376ok\\n'",
      ].join("\n"),
    });
    const ledger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("not valid UTF-8");
      const log = readCallLog(ledger.path);
      expect(log.malformed).toBe(0);
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.agent).toBe("claude");
      expect(record.exit_code).toBe(1);
      expect(record.model_effective).toBeNull();
      expect(record.sandboxed).toBe(false);
      expect(record.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("the sandboxed path receipts a rejected capture the same way (ul8)", async () => {
    // The sandboxed twin: the harness runs under scode, its stdout is
    // scode's stdout, and the same invalid UTF-8 rejects the capture after
    // the harness ran. The fake scode passes the command through (exec), so
    // the rejection rides the sandboxed branch of the launch and the
    // receipt must say sandboxed.
    const fake = createFakeBinaryEnv({
      claude: [
        'case " $* " in',
        '  *" --version "*) printf \'2.1.220\\n\'; exit 0;;',
        "esac",
        "printf 'ok\\377\\376ok\\n'",
      ].join("\n"),
      scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    });
    const ledger = ledgerFile();
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--auto", "high", "-a", "claude", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("not valid UTF-8");
      const log = readCallLog(ledger.path);
      expect(log.malformed).toBe(0);
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.agent).toBe("claude");
      expect(record.exit_code).toBe(1);
      expect(record.sandboxed).toBe(true);
      expect(record.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a rejected opencode capture receipts the usage folded so far (ul8)", async () => {
    // The streamed fold is the one rejected capture with real usage to
    // keep: the step_finish counts of the steps that already finished,
    // read off the sink — the same never-guess rule as the signal
    // interrupt's receipt. The invalid bytes land after the finish line
    // (the sleep keeps the two writes apart on the pipe).
    const finish = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens: { input: 8, output: 3, total: 11 }, cost: 0 },
    });
    const fake = createFakeBinaryEnv({
      opencode: [
        'case " $* " in',
        '  *" --version "*) printf \'1.18.18\\n\'; exit 0;;',
        "esac",
        `printf '%s\\n' '${finish}'`,
        "sleep 0.2",
        "printf 'cut\\377\\376'",
      ].join("\n"),
    });
    const ledger = ledgerFile();
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "opencode", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("not valid UTF-8");
      const log = readCallLog(ledger.path);
      expect(log.malformed).toBe(0);
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.agent).toBe("opencode");
      expect(record.exit_code).toBe(1);
      expect(record.usage).toEqual({
        input_tokens: 8,
        output_tokens: 3,
        cached_input_tokens: null,
        total_tokens: 11,
        cost_usd: 0,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a long plain codex run folds the event stream, so the reply, the full usage block, and the byte-for-byte stdout contract all survive (ul3)", async () => {
    // The regression: forcing --json onto plain runs made codex stream
    // every event — tool output included — into the 16 MiB capture bound,
    // so an agentic run died at exit 125 with the reply lost and no
    // receipt. Since 0.12.0 the flag rides every run and the plain run
    // streams the events through a fold that keeps only the final message,
    // the usage snapshot, and the served model, so no volume of tool
    // output can reach the bound. The fake emits exactly that volume —
    // 1100 events of ~16 KiB, past 16 MiB — plus the blended "tokens used"
    // figure human mode prints on stderr, proving the receipt carries the
    // stream's full block, never the figure. The stdout contract is human
    // mode's byte for byte, and a failed run is held to it too: a failed
    // turn's message is discarded upstream, so its stdout is empty.
    const giantStream = (ending: string): string => [
      'pad=$(head -c 16384 /dev/zero | tr "\\0" x)',
      'printf \'{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}\\n\'',
      'printf \'{"type":"turn.started"}\\n\'',
      "i=0",
      "while [ $i -lt 1100 ]; do",
      '  printf \'{"type":"item.updated","item":{"id":"i%d","type":"other","data":"%s"}}\\n\' "$i" "$pad"',
      "  i=$((i+1))",
      "done",
      'printf \'{"type":"item.completed","item":{"id":"final","type":"agent_message","text":"the reply"}}\\n\'',
      ending,
      'printf \'tokens used\\n2,048\\n\' >&2',
    ].join("\n");
    const completed = giantStream(
      'printf \'{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}\\n\''
    );
    const fake = createFakeBinaryEnv({ codex: completed });
    const ledger = ledgerFile();
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "codex", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("the reply\n");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.agent).toBe("codex");
      // The stream's snapshot, every field: the uncached input (10 − 4
      // reads − 0 writes), the joined cached count, the output, and the
      // total computed from all of them — not the blended 2,048 figure.
      expect(record.usage).toEqual({
        input_tokens: 6,
        output_tokens: 6,
        cached_input_tokens: 4,
        total_tokens: 16,
        cost_usd: null,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }

    // The same volume ending in a failed turn: human mode prints nothing
    // for one, so the run fails with empty stdout — never the wire, never
    // the message the failed turn had completed — and reports no usage,
    // because a figure from a run the harness itself called failed is at
    // best incomplete.
    const failedTurn = giantStream(
      'printf \'{"type":"turn.failed","error":{"message":"Usage limit reached"}}\\n\''
    );
    const failing = createFakeBinaryEnv({ codex: failedTurn });
    const failedLedger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "codex", "-p", "test"],
        { ...failing.env, [CALL_LOG_ENV]: failedLedger.path }
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Usage limit reached");
      const record = readCallLog(failedLedger.path).entries[0]!.record as CallRecord;
      expect(record.exit_code).toBe(1);
      expect(record.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      });
    } finally {
      failing.cleanup();
      failedLedger.cleanup();
    }
  }, LARGE_STREAM_TEST_TIMEOUT_MS);

  test("a cut-off trailing opencode line keeps the reply and usage, never the wire (ul3)", async () => {
    // The timeout shape end to end: the fake streams a real text part and
    // a step_finish, then a line the kill cut mid-write (no trailing
    // newline). The reply and the usage survive; the JSON wire never
    // reaches stdout.
    const part = JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: "the reply so far" } });
    const finish = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens: { input: 8, output: 3, total: 11 }, cost: 0 },
    });
    const fake = createFakeBinaryEnv({
      opencode: `printf '%s\\n%s\\n' '${part}' '${finish}'; printf '%s' '{"type":"step_finish","timestamp":1'`,
    });
    const ledger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "opencode", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("the reply so far\n");
      expect(stdout).not.toContain('"type"');
      expect(stderr).toContain("not the wire");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.usage).toEqual({
        input_tokens: 8,
        output_tokens: 3,
        cached_input_tokens: null,
        total_tokens: 11,
        cost_usd: 0,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("an opencode run with more than 16 MiB of tool events still succeeds (ul4)", async () => {
    // The finding, end to end: `--format json` carries every tool's output
    // on the event lines, so a whole-capture run died at exit 125 with the
    // reply lost and no receipt. The fake emits exactly that volume —
    // 1100 tool_use lines of 16 KiB, ~17.9 MiB — around a real text part
    // and step_finish; the streamed fold drops the tool parts as they
    // arrive, so the run succeeds with the right reply and usage.
    const fake = createFakeBinaryEnv({
      opencode: [
        'pad=$(head -c 16384 /dev/zero | tr "\\0" x)',
        "i=0",
        "while [ $i -lt 1100 ]; do",
        '  printf \'{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"id":"cal_1","tool":"read","state":{"status":"completed","input":{},"output":"%s"}}}\\n\' "$pad"',
        "  i=$((i+1))",
        "done",
        `printf '%s\\n' '${JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: "the reply" } })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: "step_finish", sessionID: "ses_0123456789abcdef", part: { tokens: { input: 8, output: 3, total: 11 }, cost: 0 } })}'`,
      ].join("\n"),
    });
    const ledger = ledgerFile();
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "opencode", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("the reply\n");
      expect(stdout).not.toContain('"type"');
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.agent).toBe("opencode");
      expect(record.usage).toEqual({
        input_tokens: 8,
        output_tokens: 3,
        cached_input_tokens: null,
        total_tokens: 11,
        cost_usd: 0,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });


  test("an oversized opencode line as the last output, unterminated, fails the run at the capture limit (ul5, al37)", async () => {
    // The partial-line path under the one rule: the oversized line is the
    // LAST thing printed, with no trailing newline before the process
    // exits, so the stream ends inside the discarded line. The check runs
    // mid-accumulation (round al16): the run fails the moment the buffered
    // tail crosses, not at close — exit 125, the capture-limit stderr, and
    // the output that preceded the line kept.
    const text = JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: "the reply" } });
    const finish = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens: { input: 8, output: 3, total: 11 }, cost: 0 },
    });
    const fake = createFakeBinaryEnv({
      opencode: [
        `printf '%s\\n' '${text}'`,
        `printf '%s\\n' '${finish}'`,
        `printf '%s' '{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"id":"cal_1","tool":"read","state":{"status":"completed","input":{},"output":"'`,
        'head -c 41943040 /dev/zero | tr "\\0" x',
        // No newline after: the write simply stops.
        `printf '%s' '"}}'`,
      ].join("\n"),
    });
    const ledger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "opencode", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(125);
      // The reply folded before the line is the partial output the
      // capture-limit result owes the caller.
      expect(stdout).toBe("the reply\n");
      expect(stdout).not.toContain('"type"');
      expect(stderr).toContain("capture limit");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.exit_code).toBe(125);
      // The receipt keeps the usage folded before the line, like a signal
      // interrupt's receipt does.
      expect(record.usage).toEqual({
        input_tokens: 8,
        output_tokens: 3,
        cached_input_tokens: null,
        total_tokens: 11,
        cost_usd: 0,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

});
