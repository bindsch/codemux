import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_LOG_ENV, readCallLog } from "../src/call-log.js";
import type { CallRecord } from "../src/call-log.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { RUN_ARGS, SIGNAL_TEST_TIMEOUT_MS, ledgerFile } from "./helpers/call-ledger.js";

describe("the interrupted call ledger", () => {
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

});
