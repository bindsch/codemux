import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import * as runtime from "../src/cli-runtime.js";
import { CALL_LOG_ENV, readCallLog } from "../src/call-log.js";
import type { CallRecord } from "../src/call-log.js";
import { launchRunRequest } from "../src/launch.js";
import { UsageRefusalError } from "../src/validation.js";
import type { RunRequest, RunResult } from "../src/types.js";

const done: RunResult = { stdout: "answer\n", stderr: "", exitCode: 0, success: true };

/** A sandboxed claude launch with every seam stubbed except the launcher's
 * own guards: validateRunRequest records that the launch got PAST them,
 * and the runner answers a finished result. */
function harness(request: RunRequest, options: Parameters<typeof launchRunRequest>[2]) {
  const adapter = new ClaudeAdapter({});
  let validated = 0;
  let spawned = 0;
  const spies = [
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {
      validated++;
    }),
    spyOn(adapter, "beforeLaunch").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue({}),
    spyOn(adapter, "prepareSandbox").mockImplementation(() => {}),
    spyOn(adapter, "getEnv").mockReturnValue({}),
    spyOn(adapter, "getRunEnv").mockReturnValue({}),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic-harness"]),
    spyOn(adapter, "getStdinInput").mockReturnValue(null),
    spyOn(adapter, "processRunResult").mockImplementation((raw: RunResult) => raw),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => {}),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => {
      spawned++;
      return done;
    }),
  ];
  return {
    validated: () => validated,
    spawned: () => spawned,
    run: () => launchRunRequest(adapter, request, options),
    restore() {
      for (const spy of spies.reverse()) spy.mockRestore();
    },
  };
}

describe("sandboxed launch agreement (review round 100)", () => {
  test("a request claiming --sandbox-no-net is refused before validation when the options omit it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const launch = harness(
      { agent: "claude", prompt: "t", sandboxed: true, cwd, sandboxNoNet: true },
      { sandbox: true, requestedAutonomy: "read-only", cwd }
    );
    try {
      const refusal = await launch.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain("network-restricted sandbox");
      // Refused before anything spawns: no validation, no runner call.
      expect(launch.validated()).toBe(0);
      expect(launch.spawned()).toBe(0);
    } finally {
      launch.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a request claiming untrusted sandbox trust is refused before validation when the options omit it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const launch = harness(
      { agent: "claude", prompt: "t", sandboxed: true, cwd, sandboxTrust: "untrusted" },
      { sandbox: true, requestedAutonomy: "read-only", cwd }
    );
    try {
      const refusal = await launch.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain("sandbox trust 'untrusted'");
      expect(launch.validated()).toBe(0);
      expect(launch.spawned()).toBe(0);
    } finally {
      launch.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test.each([
    ["a request timeout the options do not carry", 5_000, undefined],
    ["an options timeout the request does not name", undefined, 5_000],
    ["different timeouts", 5_000, 30 * 60_000],
  ])("the launch refuses %s before validation", async (_label, requestMs, optionsMs) => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const launch = harness(
      { agent: "claude", prompt: "t", sandboxed: true, cwd, timeoutMs: requestMs },
      { sandbox: true, requestedAutonomy: "read-only", cwd, timeoutMs: optionsMs }
    );
    try {
      const refusal = await launch.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain("timeout");
      expect(launch.validated()).toBe(0);
      expect(launch.spawned()).toBe(0);
    } finally {
      launch.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("options that weaken the default trust are refused; stricter options-only trust runs (review round 101)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    // The request names no trust, so it validated the default `standard`.
    const weaker = harness(
      { agent: "claude", prompt: "t", sandboxed: true, cwd },
      { sandbox: true, requestedAutonomy: "read-only", cwd, sandboxPolicyOverrides: { trust: "trusted" } }
    );
    try {
      const refusal = await weaker.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain("sandbox trust 'trusted', weaker than the default");
      expect(weaker.validated()).toBe(0);
      expect(weaker.spawned()).toBe(0);
    } finally {
      weaker.restore();
    }
    const stricter = harness(
      { agent: "claude", prompt: "t", sandboxed: true, cwd },
      { sandbox: true, requestedAutonomy: "read-only", cwd, sandboxPolicyOverrides: { trust: "untrusted" } }
    );
    try {
      const result = await stricter.run();
      expect(result.success).toBe(true);
      expect(stricter.spawned()).toBe(1);
    } finally {
      stricter.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("options that spawn a sandbox the request does not claim are refused before validation (review round 162)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    // The request never set `sandboxed` (left undefined here) or set it
    // false: both validated no sandbox, so the sandboxed branch must not
    // spawn one for them.
    for (const sandboxed of [undefined, false] as const) {
      const launch = harness(
        { agent: "claude", prompt: "t", sandboxed, cwd },
        { sandbox: true, requestedAutonomy: "read-only", cwd }
      );
      try {
        const refusal = await launch.run().then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(UsageRefusalError);
        expect((refusal as Error).message).toContain(
          "sandboxed launch options must match the request: the launch options run a sandbox the request does not claim"
        );
        // Refused before anything spawns: no validation, no runner call.
        expect(launch.validated()).toBe(0);
        expect(launch.spawned()).toBe(0);
      } finally {
        launch.restore();
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  test("the sandbox-claim refusal is named first, before the constraint refusals (review round 162)", async () => {
    // A request that claims no sandbox but asks for --sandbox-no-net has
    // two disagreements with sandboxed options. The mode disagreement is
    // the fundamental one — the request validated no sandbox at all — so
    // its message is the refusal the caller sees.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const launch = harness(
      { agent: "claude", prompt: "t", cwd, sandboxNoNet: true },
      { sandbox: true, requestedAutonomy: "read-only", cwd }
    );
    try {
      const refusal = await launch.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain("run a sandbox the request does not claim");
      expect((refusal as Error).message).not.toContain("network-restricted");
      expect(launch.validated()).toBe(0);
      expect(launch.spawned()).toBe(0);
    } finally {
      launch.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a launch whose options name another working directory than the request is refused before validation (round 372)", async () => {
    // The adapters mint the medium-autonomy Edit grant for request.cwd
    // while the child runs in options.cwd; the launcher used to check the
    // pair only on the experiment, agy and project-settings paths.
    const requested = mkdtempSync(join(tmpdir(), "codemux-agree-req-"));
    const spawnIn = mkdtempSync(join(tmpdir(), "codemux-agree-opt-"));
    for (const sandbox of [false, true]) {
      const launch = harness(
        { agent: "claude", prompt: "t", cwd: requested, autonomy: "medium", sandboxed: sandbox },
        { sandbox, requestedAutonomy: "medium", cwd: spawnIn }
      );
      try {
        const refusal = await launch.run().then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(UsageRefusalError);
        // The sandboxed agreement names the split first (review round 64);
        // the direct launch has its own refusal now.
        expect((refusal as Error).message).toContain(
          sandbox ? "validated working directory" : "must run in the request's working directory"
        );
        expect(launch.validated()).toBe(0);
        expect(launch.spawned()).toBe(0);
      } finally {
        launch.restore();
      }
    }
    rmSync(requested, { recursive: true, force: true });
    rmSync(spawnIn, { recursive: true, force: true });
  });

  test("a direct launch refuses a request claiming --sandbox-no-net before validation (round 341)", async () => {
    // The pre-fix direct branch ignored the claim and ran unrestricted
    // while the request said restricted.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const launch = harness(
      { agent: "claude", prompt: "t", cwd, sandboxNoNet: true },
      { sandbox: false, requestedAutonomy: "read-only", cwd }
    );
    try {
      const refusal = await launch.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain(
        "cannot honor sandbox policy flags on a direct run"
      );
      expect(launch.validated()).toBe(0);
      expect(launch.spawned()).toBe(0);
    } finally {
      launch.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a direct launch refuses a request claiming a sandbox trust level before validation (round 341)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const launch = harness(
      { agent: "claude", prompt: "t", cwd, sandboxTrust: "untrusted" },
      { sandbox: false, requestedAutonomy: "read-only", cwd }
    );
    try {
      const refusal = await launch.run().then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(UsageRefusalError);
      expect((refusal as Error).message).toContain(
        "cannot honor sandbox policy flags on a direct run"
      );
      expect(launch.validated()).toBe(0);
      expect(launch.spawned()).toBe(0);
    } finally {
      launch.restore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an untrusted sandbox counts as network-restricted in the guard and on the receipt (review round 102)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const ledger = join(cwd, "calls.jsonl");
    const previous = process.env[CALL_LOG_ENV];
    process.env[CALL_LOG_ENV] = ledger;
    // The untrusted preset implies --no-net: a request that claims the
    // restriction agrees with options that carry only the trust level.
    const launch = harness(
      { agent: "claude", prompt: "t", sandboxed: true, cwd, sandboxNoNet: true, sandboxTrust: "untrusted" },
      { sandbox: true, requestedAutonomy: "read-only", cwd, sandboxPolicyOverrides: { trust: "untrusted" } }
    );
    try {
      expect((await launch.run()).success).toBe(true);
      expect(launch.spawned()).toBe(1);
      const log = readCallLog(ledger);
      expect(log.entries).toHaveLength(1);
      const record = log.entries[0]!.record as CallRecord;
      expect(record.sandbox_trust).toBe("untrusted");
      expect(record.sandbox_no_net).toBe(true);
    } finally {
      launch.restore();
      if (previous === undefined) delete process.env[CALL_LOG_ENV];
      else process.env[CALL_LOG_ENV] = previous;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("matching sandbox fields still launch, and the runner runs on the request's deadline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agree-"));
    const adapter = new ClaudeAdapter({});
    const seen: { timeoutMs?: number }[] = [];
    const spies = [
      spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
      spyOn(adapter, "beforeLaunch").mockImplementation(() => {}),
      spyOn(adapter, "prepareRun").mockReturnValue({}),
      spyOn(adapter, "prepareSandbox").mockImplementation(() => {}),
      spyOn(adapter, "getEnv").mockReturnValue({}),
      spyOn(adapter, "getRunEnv").mockReturnValue({}),
      spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic-harness"]),
      spyOn(adapter, "getStdinInput").mockReturnValue(null),
      spyOn(adapter, "processRunResult").mockImplementation((raw: RunResult) => raw),
      spyOn(adapter, "cleanupRun").mockImplementation(async () => {}),
      spyOn(runtime, "runSandboxedWithStdin").mockImplementation(
        async (_command, _stdin, _cwd, _env, _autonomy, _policy, timeoutMs) => {
          seen.push({ timeoutMs });
          return done;
        }
      ),
    ];
    try {
      const result = await launchRunRequest(
        adapter,
        { agent: "claude", prompt: "t", sandboxed: true, cwd,
          sandboxNoNet: true, sandboxTrust: "untrusted", timeoutMs: 5_000 },
        { sandbox: true, requestedAutonomy: "read-only", cwd,
          sandboxPolicyOverrides: { noNet: true, trust: "untrusted" }, timeoutMs: 5_000 }
      );
      expect(result).toBe(done);
      // One deadline governs the sandboxed path: the request's own.
      expect(seen).toEqual([{ timeoutMs: 5_000 }]);
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
