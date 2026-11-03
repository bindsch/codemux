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
