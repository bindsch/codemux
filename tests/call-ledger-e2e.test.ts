/**
 * The launched-CLI side of the call ledger: a spawned `codemux run` over a
 * fake claude that prints the result envelope proves the whole chain — the
 * plain stdout contract byte for byte, the record's fields, the `check`
 * kind, the provider field under an override, relocation, and `off` — the
 * same road every real run takes. One test drives launchRunRequest in
 * process for the failure receipt's post-processing arm, where a spawned
 * CLI has no lever.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseAdapter } from "../src/adapters/base.js";
import { CALL_LOG_ENV, readCallLog, type CallRecord } from "../src/call-log.js";
import { launchRunRequest } from "../src/launch.js";
import type {
  AdapterCapabilities,
  RunRequest,
  RunResult,
} from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

// The envelope the fake claude answers with: the same shape the real one
// prints under --output-format json (result-envelope.test.ts's fixture).
const ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: null,
  result: "OK",
  usage: { input_tokens: 24114, output_tokens: 98, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 },
  total_cost_usd: 0.12735,
  modelUsage: { "claude-opus-5": {} },
});

const RUN_ARGS = ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "-p", "test"];

// The signal tests spawn the CLI, run a fake harness, and stop it through
// the runner's grace windows; that is seconds of wall time, past bun's 5 s
// default. The budget is not an assertion about the receipt.
const SIGNAL_TEST_TIMEOUT_MS = 30_000;

function ledgerFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codemux-ledger-e2e-"));
  return {
    path: join(dir, "calls.jsonl"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("the launched call ledger", () => {
  test("a plain run records its receipt while stdout stays the reply alone", async () => {
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${ENVELOPE}'` });
    const ledger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      // The stdout contract: the final message and nothing else — the
      // envelope never leaks and no ledger chatter rides along. (The
      // launcher's own "Running with claude..." notes go to stderr.)
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      expect(stderr).not.toContain("call log");

      const log = readCallLog(ledger.path);
      expect(log.malformed).toBe(0);
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.agent).toBe("claude");
      expect(record.model).toBeNull(); // no -m was passed
      expect(record.model_effective).toBe("claude-opus-5");
      expect(record.provider).toBe("default");
      expect(record.session_id).toBeNull();
      expect(record.turn_id).toBeNull();
      expect(record.autonomy).toBe("high");
      expect(record.hermetic).toBe(false);
      expect(record.sandboxed).toBe(false);
      expect(record.exit_code).toBe(0);
      expect(record.finish).toBeNull();
      expect(record.duration_ms).toBeGreaterThanOrEqual(0);
      expect(record.cwd).toBe(join(import.meta.dir, ".."));
      expect(record.usage).toEqual({
        input_tokens: 24114,
        output_tokens: 98,
        cached_input_tokens: 320,
        total_tokens: 24532,
        cost_usd: 0.12735,
      });
      // The record line carries no prompt text and no secrets: the fixed
      // field set only.
      expect(Object.keys(record).sort()).toEqual([
        "agent",
        "autonomy",
        "cwd",
        "duration_ms",
        "exit_code",
        "finish",
        "hermetic",
        "kind",
        "model",
        "model_effective",
        "provider",
        "sandboxed",
        "session_id",
        "ts",
        "turn_id",
        "usage",
      ]);
      expect(log.entries[0]!.line).not.toContain("test");
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a run against a provider override records the endpoint's host, never its key", async () => {
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${ENVELOPE}'` });
    const ledger = ledgerFile();
    try {
      const { exitCode, stdout } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://localhost:8011/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "ledger-secret-key",
        CODEMUX_CLAUDE_PROVIDER_MODEL: "test-model",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.provider).toBe("localhost:8011");
      const text = readFileSync(ledger.path, "utf8");
      expect(text).not.toContain("ledger-secret-key");
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a harness that answers plain text still runs and records null usage", async () => {
    // The escape hatch, honestly ledged: an unparseable stdout records
    // nothing rather than guessing, and the run succeeds as before.
    const fake = createFakeBinaryEnv({ claude: "printf 'OK\\n'" });
    const ledger = ledgerFile();
    try {
      const { stdout, exitCode } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      });
      expect(record.model_effective).toBeNull();
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a failed run is receipted too, with its exit code", async () => {
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${ENVELOPE}'; exit 3` });
    const ledger = ledgerFile();
    try {
      const { exitCode, stdout } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      expect(exitCode).not.toBe(0);
      // The unwrap still happened: stdout is the reply, not the envelope.
      expect(stdout).toBe("OK\n");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.exit_code).toBe(3);
      expect(record.usage.input_tokens).toBe(24114);
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a failed plain run prints the harness's error text, never the wire (ul2)", async () => {
    const errorEnvelope = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "the tool run failed",
      usage: { input_tokens: 900, output_tokens: 5 },
      total_cost_usd: 0.004,
      modelUsage: { "claude-opus-5": {} },
    });
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${errorEnvelope}'` });
    const ledger = ledgerFile();
    try {
      const { stdout, exitCode } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      expect(exitCode).not.toBe(0);
      // The stdout contract holds on failure: the error text plain mode
      // would have printed, never the JSON wire.
      expect(stdout).toBe("the tool run failed\n");
      expect(stdout).not.toContain('"subtype"');
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.exit_code).toBe(1);
      expect(record.usage.input_tokens).toBe(900);
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a JSON array on a plain run fails as a broken stream, never the reply (ul7)", async () => {
    // The ul7 defect, end to end: the escape hatch checked only for a
    // leading `{`, so a harness whose JSON output was an array had that
    // array passed through as the reply — a successful run, no usage, the
    // wire on stdout. JSON on a launch that asked for JSON is a broken
    // structured stream: diagnostic on stderr, nothing on stdout, null
    // usage in the ledger.
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '[{"items":[]}]'` });
    const ledger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("truncated or unrecognized");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.exit_code).toBe(1);
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

  test("a processRunResult throw is receipted; a pre-spawn refusal is not (ul8, in process)", async () => {
    // The same gap's other arm, driven in process because a spawned CLI
    // has no lever that makes post-processing throw: the capture succeeded,
    // so the harness ran, and the post-processor's throw must not lose the
    // receipt. A refusal before the spawn (the binary cannot be resolved)
    // ran nothing and records nothing — recordCompletedLaunch's contract
    // keeps its word through the fix.
    const ledger = ledgerFile();
    const previous = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = ledger.path;
    class ThrowingAdapter extends BaseAdapter {
      readonly id = "claude" as const;
      readonly binaryName = "claude";
      capabilities(): AdapterCapabilities {
        return {
          supportsNonInteractive: true,
          supportsInteractive: true,
          supportsModel: false,
          supportsAutonomy: true,
          autonomyLevels: ["read-only", "low", "medium", "high"],
          supportsEffort: false,
          effortLevels: [],
          supportsHermetic: false,
          supportsToolSelection: false,
          supportsResultJson: false,
        };
      }
      buildRunCommand(): string[] {
        // A real command shape, so the launch spawns a real (harmless)
        // process whose capture succeeds before the throw.
        return [process.execPath, "-e", "process.stdout.write('hello\\n')"];
      }
      buildTuiCommand(): string[] {
        return ["claude"];
      }
      override processRunResult(): RunResult {
        throw new Error("post-processing exploded");
      }
    }
    class MissingBinaryAdapter extends ThrowingAdapter {
      override buildRunCommand(): string[] {
        // A binary no PATH holds: resolution fails after prepareRun, before
        // any spawn.
        return ["codemux-no-such-harness-binary"];
      }
    }
    const request: RunRequest = {
      agent: "claude",
      prompt: "t",
      autonomy: "high",
      sandboxed: false,
    };
    try {
      await expect(
        launchRunRequest(new ThrowingAdapter(), request, {
          sandbox: false,
          requestedAutonomy: "high",
        })
      ).rejects.toThrow("post-processing exploded");
      await expect(
        launchRunRequest(new MissingBinaryAdapter(), request, {
          sandbox: false,
          requestedAutonomy: "high",
        })
      ).rejects.toThrow(/was not found/);
      const log = readCallLog(ledger.path);
      expect(log.malformed).toBe(0);
      // Only the run that reached its spawn is ledgered.
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.agent).toBe("claude");
      expect(record.exit_code).toBe(1);
      expect(record.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      });
    } finally {
      if (previous === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previous;
      ledger.cleanup();
    }
  });

  test("check records its probe under the check kind", async () => {
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${ENVELOPE}'` });
    const ledger = ledgerFile();
    try {
      const { exitCode } = await runCli(
        ["check", "-a", "claude", "--no-sandbox", "--auto", "high"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(0);
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.kind).toBe("check");
      expect(record.agent).toBe("claude");
      expect(record.autonomy).toBe("high");
      expect(record.usage.input_tokens).toBe(24114);
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("a long plain codex run succeeds and receipts the stderr figure, not a 16 MiB stream (ul3)", async () => {
    // The regression: forcing --json onto plain runs made codex stream
    // every event — tool output included — into the 16 MiB capture bound,
    // so an agentic run died at exit 125 with the reply lost and no
    // receipt. The fake emits exactly that stream when it sees --json and
    // answers the way human mode does without it, so the test fails if
    // the flag ever comes back unconditionally.
    const fake = createFakeBinaryEnv({
      codex: [
        'pad=$(head -c 16384 /dev/zero | tr "\\0" x)',
        'case " $* " in',
        '  *" --json "*)',
        "    i=0",
        "    while [ $i -lt 1100 ]; do",
        '      printf \'{"type":"item.updated","item":{"id":"i%d","type":"other","data":"%s"}}\\n\' "$i" "$pad"',
        "      i=$((i+1))",
        "    done",
        "    ;;",
        "  *)",
        '    printf \'the reply\\n\'',
        '    printf \'tokens used\\n2,048\\n\' >&2',
        "    ;;",
        "esac",
      ].join("\n"),
    });
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
      // The blended figure lands in total_tokens alone; the parts cannot
      // be recovered from it.
      expect(record.usage).toEqual({
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: 2048,
        cost_usd: null,
      });
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

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

  test("a 40 MiB opencode tool line still succeeds: dropped unread, reply and usage kept (ul5)", async () => {
    // The ul5 defect end to end: one wire-shaped line of ~2.5x the capture
    // bound. The first 16 MiB tripped the drop as designed, but every
    // later chunk of the same line piled back into the buffer keptBytes
    // counted, so the runner threw the output-limit error and the run
    // died at exit 125 with the reply lost. The tail is dropped chunk by
    // chunk now: exit 0, the reply, the usage — never the capture failure.
    const text = JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: "the reply" } });
    const finish = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens: { input: 8, output: 3, total: 11 }, cost: 0 },
    });
    const fake = createFakeBinaryEnv({
      opencode: [
        // One tool_use line of about 40 MiB, streamed so no argv grows.
        `printf '%s' '{"type":"tool_use","sessionID":"ses_0123456789abcdef","part":{"id":"cal_1","tool":"read","state":{"status":"completed","input":{},"output":"'`,
        'head -c 41943040 /dev/zero | tr "\\0" x',
        `printf '%s\\n' '"}}'`,
        `printf '%s\\n' '${text}'`,
        `printf '%s\\n' '${finish}'`,
      ].join("\n"),
    });
    const ledger = ledgerFile();
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "opencode", "-p", "test"],
        { ...fake.env, [CALL_LOG_ENV]: ledger.path }
      );
      expect(exitCode).toBe(0); // 125 would be the output-limit kill
      expect(stdout).toBe("the reply\n");
      expect(stdout).not.toContain('"type"');
      // The process-runner never threw the output-limit error.
      expect(stderr).not.toContain("capture limit");
      expect(stderr).toContain("dropped unread");
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

  test("an oversized opencode line as the last output, unterminated, still succeeds (ul5)", async () => {
    // The partial-line path: the oversized line is the LAST thing printed,
    // with no trailing newline before the process exits, so the stream
    // ends inside the discarded line.
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
      expect(exitCode).toBe(0);
      expect(stdout).toBe("the reply\n");
      expect(stdout).not.toContain('"type"');
      expect(stderr).not.toContain("capture limit");
      expect(stderr).toContain("dropped unread");
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

  test("a run interrupted by SIGTERM exits 143 and still writes its receipt (ul6)", async () => {
    // The regression: the runner's signal path exited 143 from inside the
    // run, so the launch's recordCompletedLaunch never ran and an
    // interrupted run left no record — tokens spent, ledger silent. The
    // pre-exit onSignaled hook now writes the receipt through the same
    // never-fail append: signal exit code, null usage (nothing structured
    // reported), model_effective null.
    const ledger = ledgerFile();
    const home = mkdtempSync(join(tmpdir(), "codemux-signal-home-"));
    const markerDir = mkdtempSync(join(tmpdir(), "codemux-signal-marker-"));
    const marker = join(markerDir, "started");
    // The marker path is embedded, not an env var: the harness environment
    // is built, not inherited, so a $MARKER the test exports never reaches
    // the fake. The fake's first act inside the launch's run — past the
    // version probe, with the receipt hook armed — is to write it.
    const fake = createFakeBinaryEnv({
      claude: [
        'case " $* " in',
        '  *" --version "*) printf \'2.1.220\\n\'; exit 0;;',
        "esac",
        `printf 'started\\n' > '${marker}'`,
        "sleep 30",
      ].join("\n"),
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), ...RUN_ARGS],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            ...fake.env,
            [CALL_LOG_ENV]: ledger.path,
          } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      process.kill(proc.pid, "SIGTERM");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted");
      const log = readCallLog(ledger.path);
      expect(log.malformed).toBe(0);
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.agent).toBe("claude");
      expect(record.exit_code).toBe(143);
      expect(record.model_effective).toBeNull();
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
      rmSync(home, { recursive: true, force: true });
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, SIGNAL_TEST_TIMEOUT_MS);

  test("an interrupted opencode run receipts the usage folded so far (ul6)", async () => {
    // The streamed fold is the one interrupted run with real usage to
    // keep: the step_finish counts of the steps that already finished,
    // read off the sink by the pre-exit hook — never a guess, all-null
    // when no step reported any.
    const text = JSON.stringify({ type: "text", sessionID: "ses_0123456789abcdef", part: { text: "the reply so far" } });
    const finish = JSON.stringify({
      type: "step_finish",
      sessionID: "ses_0123456789abcdef",
      part: { tokens: { input: 8, output: 3, total: 11 }, cost: 0 },
    });
    const ledger = ledgerFile();
    const home = mkdtempSync(join(tmpdir(), "codemux-signal-home-"));
    const markerDir = mkdtempSync(join(tmpdir(), "codemux-signal-marker-"));
    const marker = join(markerDir, "folded");
    // Same embedded-marker rule as the claude variant: the harness env is
    // built, so the path rides in the fake's body, not an exported var.
    const fake = createFakeBinaryEnv({
      opencode: [
        'case " $* " in',
        '  *" --version "*) printf \'1.18.18\\n\'; exit 0;;',
        "esac",
        `printf '%s\\n' '${text}'`,
        `printf '%s\\n' '${finish}'`,
        `printf 'folded\\n' > '${marker}'`,
        "sleep 30",
      ].join("\n"),
    });
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "run",
          "--no-sandbox",
          "--auto",
          "high",
          "-a",
          "opencode",
          "-p",
          "test",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            ...fake.env,
            [CALL_LOG_ENV]: ledger.path,
          } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
      // The marker says the fake wrote its lines; give the fold a beat to
      // read them before the signal.
      await Bun.sleep(200);
      process.kill(proc.pid, "SIGTERM");
      const [, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.agent).toBe("opencode");
      expect(record.exit_code).toBe(143);
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
      rmSync(home, { recursive: true, force: true });
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, SIGNAL_TEST_TIMEOUT_MS);

  test("an escape-carrying model name from the wire is stored clean (ul6)", async () => {
    // The print-side finding, end to end at the store seam: a provider
    // override can serve any model string, and one carrying an ANSI
    // sequence used to reach the ledger verbatim. The envelope's
    // modelUsage key is what the receipt's model_effective comes from.
    const poisoned = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: null,
      result: "OK",
      usage: { input_tokens: 10, output_tokens: 2 },
      total_cost_usd: 0.001,
      modelUsage: { "claude-\u001b[31mopus": {} },
    });
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${poisoned}'` });
    const ledger = ledgerFile();
    try {
      const { exitCode, stdout } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: ledger.path,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.model_effective).toBe("claude-opus");
      // The stored line carries no escape byte at all.
      expect(readFileSync(ledger.path, "utf8")).not.toContain("\x1b");
    } finally {
      fake.cleanup();
      ledger.cleanup();
    }
  });

  test("off disables the ledger and the run is unaffected", async () => {
    const fake = createFakeBinaryEnv({ claude: `printf '%s\\n' '${ENVELOPE}'` });
    const home = mkdtempSync(join(tmpdir(), "codemux-ledger-off-"));
    try {
      const { stdout, exitCode } = await runCli(RUN_ARGS, {
        ...fake.env,
        [CALL_LOG_ENV]: "off",
        HOME: home,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe("OK\n");
      // Nothing appeared at the state-directory rule's path either.
      expect(existsSync(`${home}/Library/Application Support/codemux/calls.jsonl`)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
