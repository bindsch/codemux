/**
 * Pinned production values (audit finding 14): every timing test injects
 * its own constants, so a change to the shipped figure passed the whole
 * suite. Each constant is asserted against the figure its documentation
 * names. The OK_LINE corpus (audit finding 13) pins `codemux check`'s
 * verdict grammar the same way.
 */

import { describe, expect, test } from "bun:test";
import { OK_LINE } from "../src/check-command.js";
import { RELAY_SSE_KEEPALIVE_MS, RELAY_SSE_SWITCH_MS } from "../src/experiment-relay-response.js";
import { ROLLOUT_POLL_MS } from "../src/experiment-codex.js";
import { WIRE_POLL_MS } from "../src/experiment-kimi.js";
import { registerRunExitCleanup } from "../src/run-exit-cleanup.js";
import type { BaseAdapter, RunContext } from "../src/adapters/base.js";

describe("documented timing constants", () => {
  test("a pending tools/call switches to SSE after two seconds", () => {
    expect(RELAY_SSE_SWITCH_MS).toBe(2_000);
  });

  test("an SSE stream writes a keepalive comment every 15 seconds", () => {
    expect(RELAY_SSE_KEEPALIVE_MS).toBe(15_000);
  });

  test("Codex polls its private rollout every 250 ms", () => {
    expect(ROLLOUT_POLL_MS).toBe(250);
  });

  test("Kimi tails the private wire.jsonl every 250 ms", () => {
    expect(WIRE_POLL_MS).toBe(250);
  });
});

describe("check verdict grammar (OK_LINE)", () => {
  test.each([
    "OK", "OK\n", "OK.", "OK!", "  OK", "  OK!  ", "before\nOK\nafter",
    "OK\r\n", "\n\tOK.\n", "reply\nOK",
  ])("accepts %j", (stdout) => {
    expect(OK_LINE.test(stdout)).toBe(true);
  });

  test.each([
    "OKAY", "OKAY THERE", "OK there", "TOKEN OK", "OKOK", "ok", "ok!",
    "NOT OK", "OK-ISH", "OK?", "AYS OK",
  ])("rejects %j", (stdout) => {
    expect(OK_LINE.test(stdout)).toBe(false);
  });
});

describe("run exit cleanup error branches", () => {
  test("a failing protocol termination reports and still runs the adapter cleanup", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      const cleanups: string[] = [];
      const adapter = {
        cleanupRunSync: () => {
          cleanups.push("adapter");
        },
      } as unknown as Pick<BaseAdapter, "cleanupRunSync">;
      const context = {
        stdoutSink: {
          terminateProtocol: () => {
            throw new Error("sink is gone");
          },
        },
      } as unknown as RunContext;
      const dispose = registerRunExitCleanup(adapter, context);
      process.emit("exit");
      // The emitted exit also runs hooks other test files left in this
      // shared process; only this registration's report is judged.
      expect(errors.filter((message) => message.includes("per-run state at exit"))).toEqual([
        "codemux: could not clean up per-run state at exit: sink is gone",
      ]);
      expect(cleanups).toEqual(["adapter"]);
      dispose();
    } finally {
      console.error = original;
    }
  });

  test("a failing adapter cleanup reports the error", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      const adapter = {
        cleanupRunSync: () => {
          throw new Error("mirror locked");
        },
      } as unknown as Pick<BaseAdapter, "cleanupRunSync">;
      const context = {} as RunContext;
      const dispose = registerRunExitCleanup(adapter, context);
      process.emit("exit");
      expect(errors.filter((message) => message.includes("per-run state at exit"))).toEqual([
        "codemux: could not clean up per-run state at exit: mirror locked",
      ]);
      // The handler is registered with prependOnceListener, so one exit
      // consumed it; a second exit runs nothing.
      errors.length = 0;
      process.emit("exit");
      expect(errors.filter((message) => message.includes("per-run state at exit"))).toEqual([]);
      dispose();
    } finally {
      console.error = original;
    }
  });

  test("the disposer unregisters the handler", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      const adapter = {
        cleanupRunSync: () => {
          throw new Error("must not run");
        },
      } as unknown as Pick<BaseAdapter, "cleanupRunSync">;
      const dispose = registerRunExitCleanup(adapter, {} as RunContext);
      dispose();
      process.emit("exit");
      expect(errors.filter((message) => message.includes("per-run state at exit"))).toEqual([]);
    } finally {
      console.error = original;
    }
  });
});
