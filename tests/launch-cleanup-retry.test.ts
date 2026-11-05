/**
 * The launcher keeps its exit backstop after a failed cleanup that can
 * be retried (review rounds 138 and 141). An adapter may keep its state
 * for a retry when its cleanup fails (agy's private home, review round
 * 137). The launcher used to release the exit handler after the first
 * attempt whatever its outcome, so a launched run never retried and the
 * adapter's held descriptors were never closed. The handler now stays
 * registered while the adapter says a retry is pending, and the exit
 * call is the last attempt. A failure with nothing to retry releases it,
 * so failed launches in one process do not pile up exit handlers.
 */

import { expect, spyOn, test } from "bun:test";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import * as runtime from "../src/cli-runtime.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunContext } from "../src/run-context.js";
import { claudeFamilyResult } from "../src/result-envelope.js";
import type { RunRequest } from "../src/types.js";
import { CLAUDE_ENVELOPE, finished } from "./helpers/result-envelope.js";

type ExitHandler = () => void;

/** One synthetic launch whose adapter cleanup fails or succeeds. Returns
 * the exit handlers the launch registered, whether each is still
 * registered afterwards, and the synchronous cleanup calls the handlers
 * make when run by hand. */
async function launchWith(cleanupFails: boolean, retryPending = cleanupFails): Promise<{
  stillRegistered: boolean[];
  syncCalls: unknown[][];
  stderr: string;
}> {
  const adapter = new ClaudeAdapter({});
  const request: RunRequest = {
    agent: "claude", prompt: "fixture", sandboxed: true, autonomy: "read-only", resultJson: true,
  };
  const context = {} as RunContext;
  const registered: ExitHandler[] = [];
  const realPrepend = process.prependOnceListener.bind(process);
  const syncCalls: unknown[][] = [];
  const spies = [
    spyOn(process, "prependOnceListener").mockImplementation(((event: string, listener: ExitHandler) => {
      if (event === "exit") registered.push(listener);
      return realPrepend(event, listener);
    }) as typeof process.prependOnceListener),
    spyOn(adapter, "validateRunRequest").mockImplementation(() => {}),
    spyOn(adapter, "prepareRun").mockReturnValue(context),
    spyOn(adapter, "buildRunCommand").mockReturnValue(["synthetic-harness"]),
    spyOn(runtime, "assertHarnessSupported").mockImplementation(async () => "2.1.280"),
    spyOn(runtime, "runSandboxedWithStdin").mockImplementation(async () => finished(CLAUDE_ENVELOPE)),
    spyOn(adapter, "processRunResult").mockImplementation((raw, effective) =>
      claudeFamilyResult(raw, effective, "claude")),
    spyOn(adapter, "cleanupRun").mockImplementation(async () => {
      if (cleanupFails) throw new Error("private home is busy");
    }),
    spyOn(adapter, "cleanupRetryPending").mockReturnValue(retryPending),
    spyOn(adapter, "cleanupRunSync").mockImplementation(((...args: unknown[]) => {
      syncCalls.push(args);
    }) as typeof adapter.cleanupRunSync),
  ];
  try {
    const result = await launchRunRequest(adapter, request, { sandbox: true, requestedAutonomy: "read-only" });
    const stillRegistered = registered.map((handler) => process.listeners("exit").includes(handler));
    // Run what the exit would run, by hand, then take the handlers off so
    // nothing of this test is left for a later exit event.
    for (const handler of registered) {
      if (process.listeners("exit").includes(handler)) handler();
      process.off("exit", handler);
    }
    return { stillRegistered, syncCalls, stderr: result.stderr };
  } finally {
    for (const handler of registered) process.off("exit", handler);
    for (const spy of spies) spy.mockRestore();
  }
}

test("a failed cleanup keeps the exit backstop, and the exit makes the last attempt", async () => {
  const failed = await launchWith(true);
  expect(failed.stderr).toContain("Note: cleanup failed: private home is busy");
  expect(failed.stillRegistered.length).toBeGreaterThanOrEqual(1);
  expect(failed.stillRegistered.every(Boolean)).toBe(true);
  // The exit call tells the adapter it is the last one.
  expect(failed.syncCalls.length).toBeGreaterThanOrEqual(1);
  expect(failed.syncCalls.every((args) => args[1] === true)).toBe(true);
});

test("a successful cleanup releases the exit backstop: nothing runs at exit", async () => {
  const clean = await launchWith(false);
  expect(clean.stderr).not.toContain("cleanup failed");
  expect(clean.stillRegistered.length).toBeGreaterThanOrEqual(1);
  expect(clean.stillRegistered.some(Boolean)).toBe(false);
  expect(clean.syncCalls).toEqual([]);
});

test("a failed cleanup with nothing to retry releases the exit backstop too", async () => {
  const failed = await launchWith(true, false);
  expect(failed.stderr).toContain("Note: cleanup failed: private home is busy");
  expect(failed.stillRegistered.length).toBeGreaterThanOrEqual(1);
  expect(failed.stillRegistered.some(Boolean)).toBe(false);
  expect(failed.syncCalls).toEqual([]);
});
