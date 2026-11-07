// Review round 286: the protocol cleanup grace was armed only for signals
// (round 174). After a timeout or a capture failure, a closeProtocol that
// never settles held the run open forever even though the configured
// timeout had expired and the child was dead. Both paths now arm the same
// bounded grace the signal path already had.
import { expect, test } from "bun:test";
import { runCapturedCommand, type StdoutSink } from "../src/process-runner.js";

const hungSink = (): StdoutSink => {
  let kept = "";
  return {
    push(chunk) { kept += chunk; },
    finish() { return kept; },
    keptBytes() { return kept.length; },
    terminateProtocol() {},
    closeProtocol() { return new Promise(() => {}); },
  };
};

test("a run whose protocol cleanup never settles still returns after a timeout", async () => {
  const result = await runCapturedCommand(
    [process.execPath, "-e", "await Bun.sleep(60_000)"],
    { cwd: process.cwd(), env: {}, timeoutMs: 200, stdoutSink: hungSink() }
  );
  expect(result.success).toBe(false);
  expect(result.timedOut).toBe(true);
  expect(result.stderr).toContain("agent timed out after 200ms");
  expect(result.stderr).toContain("protocol cleanup remains incomplete after the cleanup grace");
}, 15_000);

test("a run whose protocol cleanup never settles still fails after a capture failure", async () => {
  let failure: unknown;
  try {
    await runCapturedCommand(
      // Invalid UTF-8 on stdout fails the capture of a command that ran.
      [process.execPath, "-e", "process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd])); await Bun.sleep(300);"],
      { cwd: process.cwd(), env: {}, timeoutMs: 60_000, stdoutSink: hungSink() }
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("protocol cleanup remains incomplete after the cleanup grace");
}, 15_000);
