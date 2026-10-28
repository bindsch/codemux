import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseAdapter } from "../src/adapters/base.js";
import { CALL_LOG_ENV, readCallLog } from "../src/call-log.js";
import type { CallRecord } from "../src/call-log.js";
import { launchRunRequest } from "../src/launch.js";
import type { AdapterCapabilities, RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { ENVELOPE, RUN_ARGS, ledgerFile } from "./helpers/call-ledger.js";

/**
 * The launched-CLI side of the call ledger: a spawned `codemux run` over a
 * fake claude that prints the result envelope proves the whole chain — the
 * plain stdout contract byte for byte, the record's fields, the `check`
 * kind, the provider field under an override, relocation, and `off` — the
 * same road every real run takes. One test drives launchRunRequest in
 * process for the failure receipt's post-processing arm, where a spawned
 * CLI has no lever.
 */

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
        "labels",
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
  test("a 40 MiB opencode tool line fails the run at the capture limit: one rule, no classifier (ul5, al37)", async () => {
    // The ul5 shape under round al37's one rule: one wire-shaped line of
    // ~2.5x the capture bound is the first thing on the stream. The al19
    // classifier once dropped a tool_use head harmlessly with a note; al37
    // deleted it — the retained-bytes check counts bytes retained, nothing
    // more — so the latch fires the moment the line crosses and the run
    // fails at the capture limit: exit 125, the capture-limit stderr, the
    // output that preceded the line (nothing did — the reply lines that
    // follow never fold), never a silent truncation. Tool volume spread
    // over LINES under the cap still cannot kill the run; one line past
    // the bound itself does.
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
      expect(exitCode).toBe(125); // the capture-limit failure, al37's one rule
      expect(stdout).toBe(""); // nothing preceded the line
      expect(stderr).toContain("capture limit");
      const record = readCallLog(ledger.path).entries[0]!.record as CallRecord;
      expect(record.kind).toBe("run");
      expect(record.agent).toBe("opencode");
      expect(record.exit_code).toBe(125);
      // Nothing folded before the latch: the receipt's usage is nulls,
      // never a guess.
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
});
