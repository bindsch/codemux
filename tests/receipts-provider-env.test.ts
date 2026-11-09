/**
 * Receipts record the provider the launch ran against (review round 137):
 * the override is read from the adapter's environment view, the same read
 * its own provider wiring makes — never the ambient process.env, which a
 * launch through a custom-environment adapter never consulted. The finish
 * verdict for a provider quota refusal lives here too: the provider, not
 * codemux's own gate, refused the spawn.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CALL_LOG_ENV, readCallLog } from "../src/call-log.js";
import { launchProvider, recordCompletedLaunch } from "../src/launch/receipts.js";
import { emptyUsage } from "../src/result-envelope.js";
import type { LaunchOptions } from "../src/launch.js";
import type { RunRequest, RunResult } from "../src/types.js";

const AMBIENT = "CODEMUX_CLAUDE_PROVIDER_BASE_URL";

test("a receipt names the adapter environment's override, never process.env's", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-receipts-"));
  const ledger = join(dir, "calls.jsonl");
  const savedLog = process.env[CALL_LOG_ENV];
  const savedAmbient = process.env[AMBIENT];
  const options: LaunchOptions = { sandbox: false, requestedAutonomy: "read-only" };
  const request: RunRequest = { agent: "claude", prompt: "p", autonomy: "read-only" };
  const result: RunResult = { stdout: "", stderr: "", exitCode: 0, success: true, usage: emptyUsage() };
  const providerOf = (): string => {
    const entries = readCallLog(ledger).entries;
    return (entries[entries.length - 1]!.record as { provider: string }).provider;
  };
  process.env[CALL_LOG_ENV] = ledger;
  try {
    // The adapter's view carries the override; the ambient environment does not.
    delete process.env[AMBIENT];
    const overridden = new ClaudeAdapter({
      HOME: dir, CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://adapter-view.example/v1",
    });
    recordCompletedLaunch(launchProvider(overridden), request, options, result, Date.now());
    expect(providerOf()).toBe("adapter-view.example");
    // The reverse: the ambient environment carries one, the adapter's view does not.
    process.env[AMBIENT] = "http://ambient.example/v1";
    const plain = new ClaudeAdapter({ HOME: dir });
    recordCompletedLaunch(launchProvider(plain), request, options, result, Date.now());
    expect(providerOf()).toBe("default");
  } finally {
    if (savedLog === undefined) delete process.env[CALL_LOG_ENV];
    else process.env[CALL_LOG_ENV] = savedLog;
    if (savedAmbient === undefined) delete process.env[AMBIENT];
    else process.env[AMBIENT] = savedAmbient;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a launch's provider is read once and is its own, whatever happens to the adapter afterwards (review rounds 144, 145)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-receipts-pin-"));
  const ledger = join(dir, "calls.jsonl");
  const savedLog = process.env[CALL_LOG_ENV];
  const options: LaunchOptions = { sandbox: false, requestedAutonomy: "read-only" };
  const request: RunRequest = { agent: "claude", prompt: "p", autonomy: "read-only" };
  const result: RunResult = { stdout: "", stderr: "", exitCode: 0, success: true, usage: emptyUsage() };
  const providerOf = (): string => {
    const entries = readCallLog(ledger).entries;
    return (entries[entries.length - 1]!.record as { provider: string }).provider;
  };
  process.env[CALL_LOG_ENV] = ledger;
  try {
    // The adapter's environment is a live object. Two launches share the
    // adapter; the second starts, with another provider, before the
    // first writes its receipt.
    const environment: NodeJS.ProcessEnv = { HOME: dir, [AMBIENT]: "http://first.example/v1" };
    const adapter = new ClaudeAdapter(environment);
    const first = launchProvider(adapter);
    environment[AMBIENT] = "http://second.example/v1";
    const second = launchProvider(adapter);
    recordCompletedLaunch(first, request, options, result, Date.now());
    expect(providerOf()).toBe("first.example");
    recordCompletedLaunch(second, request, options, result, Date.now());
    expect(providerOf()).toBe("second.example");
  } finally {
    if (savedLog === undefined) delete process.env[CALL_LOG_ENV];
    else process.env[CALL_LOG_ENV] = savedLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider quota refusal in the captured stderr closes the row with that finish; other stderr stays null", () => {
  // The two evidenced spellings from the live gate of 2026-11-08: agy's
  // `error: Individual quota reached. ...` and kimi's
  // `provider.api_error: You've reached your weekly (7-day) usage
  // limit. ...`. The match is a substring, because the captured stderr
  // can be cut mid-line (the kimi case here ends without the period).
  // Any other failure text stays an ordinary failed run: finish null.
  const dir = mkdtempSync(join(tmpdir(), "codemux-receipts-quota-"));
  const ledger = join(dir, "calls.jsonl");
  const savedLog = process.env[CALL_LOG_ENV];
  const options: LaunchOptions = { sandbox: false, requestedAutonomy: "read-only" };
  const request: RunRequest = { agent: "agy", prompt: "p", autonomy: "read-only" };
  const finishOf = (): string | null => {
    const entries = readCallLog(ledger).entries;
    return (entries[entries.length - 1]!.record as { finish: string | null }).finish;
  };
  process.env[CALL_LOG_ENV] = ledger;
  try {
    const refused = (stderr: string): RunResult => ({
      stdout: "", stderr, exitCode: 1, success: false, usage: emptyUsage(),
    });
    recordCompletedLaunch(
      "default", request, options,
      refused("error: Individual quota reached. Current usage: 100%. Limit resets at 10:00 UTC.\n"),
      Date.now()
    );
    expect(finishOf()).toBe("provider-quota-refused");
    recordCompletedLaunch(
      "default", request, options,
      refused("provider.api_error: You've reached your weekly (7-day) usage limit. Limit resets 2026-11-10"),
      Date.now()
    );
    expect(finishOf()).toBe("provider-quota-refused");
    // A cut capture still matches: the kimi line truncated right after
    // the phrase, the sentence's rest gone. A cut inside the phrase
    // ("...usage li") must not match — fail closed, finish null.
    recordCompletedLaunch(
      "default", request, options,
      refused("provider.api_error: You've reached your weekly (7-day) usage limit"),
      Date.now()
    );
    expect(finishOf()).toBe("provider-quota-refused");
    recordCompletedLaunch(
      "default", request, options,
      refused("provider.api_error: You've reached your weekly (7-day) usage li"),
      Date.now()
    );
    expect(finishOf()).toBeNull();
    // Anything else is an ordinary failure.
    recordCompletedLaunch(
      "default", request, options,
      refused("error: connection refused\n"),
      Date.now()
    );
    expect(finishOf()).toBeNull();
  } finally {
    if (savedLog === undefined) delete process.env[CALL_LOG_ENV];
    else process.env[CALL_LOG_ENV] = savedLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
