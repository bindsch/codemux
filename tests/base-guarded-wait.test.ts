import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedWait } from "../src/process-runner.js";
import { processTableReadable } from "../src/process-table.js";
import { stillRunning } from "./helpers/base.js";
import { trackFixtureProcess } from "./setup.ts";

const bun = process.execPath;

describe("BaseAdapter", () => {
  const treeWalk = test.skipIf(process.platform === "win32" || !processTableReadable());

  treeWalk("guardedWait still kills remembered descendants when the child exits on SIGTERM", async () => {
    // An interactive child that quits promptly on SIGTERM used to cancel the
    // tree-scoped SIGKILL with its own exit, leaving an escaped descendant
    // running for good.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-"));
    const pidFile = join(cwd, "pid");
    const grandchildScript = [
      "process.on('SIGTERM', () => {});",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const childScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const proc = Bun.spawn([bun, "-e", childScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const untrack = trackFixtureProcess({ label: "guarded-wait escaped descendant", pidFile });
    try {
      // Let the child spawn and record the grandchild before the deadline.
      while (!existsSync(pidFile)) await Bun.sleep(10);
      expect(await guardedWait(proc, 50)).toBe(124);
      await Bun.sleep(300);
      expect(stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // The expected path already killed the escaped descendant.
      }
      untrack();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("guardedWait forwards SIGTERM to the child only", async () => {
    // The child-directed SIGTERM path of the wait split out in review round
    // 169: like the SIGHUP case below, the escalation must reach the child
    // and let its handler answer 143, not the parent's default action.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-term-"));
    const handlerReady = join(cwd, "handler-ready");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "process.on('SIGTERM', () => process.exit(143));",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      process.emit("SIGTERM");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("guardedWait escalates to SIGKILL when the child traps SIGTERM", async () => {
    // A child that swallows SIGTERM must not outlive the grace period: the
    // timer armed with the escalation fires the tree-scoped SIGKILL, and
    // the wait reports the signal exit 143 codemux owes after a
    // termination signal, whatever the child then died of (round 211).
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-kill-"));
    const handlerReady = join(cwd, "handler-ready");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "process.on('SIGTERM', () => {});",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      process.emit("SIGTERM");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("a SIGTERM-received run reports 143 even when the child exits 0 (round 211)", async () => {
    // The child answers the forwarded SIGTERM with a clean 0; the wait
    // still owes the documented signal exit, so supervisor termination
    // cannot read as normal completion.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-zero-"));
    const handlerReady = join(cwd, "handler-ready");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "process.on('SIGTERM', () => process.exit(0));",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      process.emit("SIGTERM");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("a lone later interrupt does not escalate after the burst window resets", async () => {
    // Two interrupts arm the burst counter; the one-second window then
    // resets it, so one more interrupt starts from zero instead of hitting
    // the third-interrupt escalation. The run ends through SIGHUP.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-reset-"));
    const handlerReady = join(cwd, "handler-ready");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "process.on('SIGTERM', () => process.exit(143));",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      process.emit("SIGINT");
      process.emit("SIGINT");
      // Past the burst window: the counter resets to zero.
      await Bun.sleep(1300);
      process.emit("SIGINT");
      // Without the reset this third delivery would have escalated to
      // SIGTERM and ended the child; a bounded grace proves it did not.
      // kill(pid, 0) is the liveness probe: it works where the process
      // table cannot be read (a guarded stillRunning would skip here).
      await Bun.sleep(400);
      expect(() => process.kill(proc.pid, 0)).not.toThrow();
      process.emit("SIGHUP");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("a child that keeps running after a terminal Ctrl-C never receives a second interrupt (round 211)", async () => {
    // A terminal Ctrl-C reaches codemux and the foreground child together.
    // Codemux forwards nothing: a forward would be a second interrupt for a
    // harness that handled the first and kept running, and several quit on
    // two. The cost is the documented limit that a SIGINT sent to codemux
    // alone does not stop the child; SIGTERM and SIGHUP do.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-one-int-"));
    const handlerReady = join(cwd, "handler-ready");
    const signalsFile = join(cwd, "signals");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "const { appendFileSync } = require('node:fs');",
          `process.on('SIGINT', () => appendFileSync(${JSON.stringify(signalsFile)}, 'int\\n'));`,
          "process.on('SIGTERM', () => process.exit(0));",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      // The terminal's delivery: codemux and the child each get one.
      process.emit("SIGINT");
      process.kill(proc.pid, "SIGINT");
      await Bun.sleep(1500);
      expect(() => process.kill(proc.pid, 0)).not.toThrow();
      expect(readFileSync(signalsFile, "utf8")).toBe("int\n");
      process.emit("SIGHUP");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("a terminal Ctrl-C that reached the child is not delivered twice (round 211)", async () => {
    // A terminal Ctrl-C reaches the foreground child through the shared
    // process group, so codemux must not add a forwarded SIGINT to it: the
    // child leaves on its own inside the forward delay, the pending
    // forward is canceled with the wait, and the child saw exactly one.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-term-int-"));
    const handlerReady = join(cwd, "handler-ready");
    const signalsFile = join(cwd, "signals");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "const { appendFileSync } = require('node:fs');",
          `process.on('SIGINT', () => { appendFileSync(${JSON.stringify(signalsFile)}, 'int\\n'); process.exit(130); });`,
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      // The terminal's own delivery: the process group gets SIGINT with
      // codemux, so the child receives it directly as well.
      process.emit("SIGINT");
      process.kill(proc.pid, "SIGINT");
      expect(await waiting).toBe(130);
      expect(readFileSync(signalsFile, "utf8")).toBe("int\n");
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("guardedWait always removes signal listeners on rejection", async () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
    };
    const proc = {
      exited: Promise.reject(new Error("wait failed")),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;

    await expect(guardedWait(proc)).rejects.toThrow("wait failed");
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
  });

  test("guardedWait escalates SIGHUP through the bounded termination path", async () => {
    // Round al32 moved the child-directed stop onto process.kill — the
    // honest ESRCH on a pid that no longer exists — so the fake kill()
    // seam this test rode is gone: the child is real now, and its exit
    // 143 (the code a SIGTERM handler exits with) is the proof the
    // escalation sent the signal.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-hup-"));
    const handlerReady = join(cwd, "handler-ready");
    const proc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "process.on('SIGTERM', () => process.exit(143));",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      // The child writes once its handler is installed; a fixed sleep
      // raced a slow runner's interpreter launch (audit round 2, C-5).
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const waiting = guardedWait(proc);
      process.emit("SIGHUP");
      expect(await waiting).toBe(143);
    } finally {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test("guardedWait handles triple interrupt and interactive deadlines", async () => {
    // The same al32 seam change: both halves run real children — the
    // burst's third SIGINT escalates to SIGTERM and the child's handler
    // answers 143, while the deadline's SIGTERM kills a plain child and
    // the wait reports the timeout's 124.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-burst-"));
    const handlerReady = join(cwd, "handler-ready");
    const interruptProc = Bun.spawn(
      [
        bun,
        "-e",
        [
          "process.on('SIGTERM', () => process.exit(143));",
          `await Bun.write(${JSON.stringify(handlerReady)}, "1");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      // Same readiness rule as the SIGHUP case: the handler must be live
      // before the burst, or the default disposition ends the child the
      // wrong way on a slow runner.
      const ready = Date.now() + 10_000;
      while (!existsSync(handlerReady) && Date.now() < ready) await Bun.sleep(10);
      expect(existsSync(handlerReady)).toBe(true);
      const interrupted = guardedWait(interruptProc);
      process.emit("SIGINT");
      process.emit("SIGINT");
      process.emit("SIGINT");
      expect(await interrupted).toBe(143);
    } finally {
      try {
        process.kill(interruptProc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
      rmSync(cwd, { recursive: true, force: true });
    }
    const timeoutProc = Bun.spawn(
      [bun, "-e", "setInterval(() => {}, 1000);"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    try {
      expect(await guardedWait(timeoutProc, 10)).toBe(124);
    } finally {
      try {
        process.kill(timeoutProc.pid, "SIGKILL");
      } catch {
        // The expected path already ended it.
      }
    }
  });
});
