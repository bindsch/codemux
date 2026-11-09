import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedWait, hasActiveSignalOwner } from "../src/process-runner.js";
import { trackPrivateDir, untrackPrivateDir } from "../src/private-dir-signals.js";

const bun = process.execPath;

// The SIGINT burst window's fixed-window contract (review round 351); the
// rest of guardedWait's interrupt cases live in base-guarded-wait.test.ts,
// which sits at the 500-line cap.
describe("guardedWait SIGINT burst window", () => {
  test("interrupts paced just under a second apart never fall inside one window (review 351)", async () => {
    // The window is fixed from the first interrupt, not re-armed on each:
    // presses at 0, 0.9 and 1.8 s never put three inside one second, so
    // the third must not escalate. Under the old sliding window it did.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-guarded-paced-"));
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
      const waiting = guardedWait(() => proc);
      process.emit("SIGINT");
      await Bun.sleep(900);
      process.emit("SIGINT");
      await Bun.sleep(900);
      // 1.8 s after the first: the first window has closed, this press
      // opens a new one as its first interrupt.
      process.emit("SIGINT");
      await Bun.sleep(400);
      expect(() => process.kill(proc.pid, 0)).not.toThrow();
      // Three inside one window still escalate: the contract's other half.
      process.emit("SIGINT");
      process.emit("SIGINT");
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

  test("a Ctrl-C during an interactive wait never exits through a private directory's handler (F47)", async () => {
    // Before the fix the private-directory handler saw no captured command,
    // finalized the directory and exited 130 under the running child; in
    // the full suite a leaked directory from an earlier file ended the runner.
    const finalize = (): void => { finalized++; };
    let finalized = 0;
    const exits: unknown[] = [];
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { exits.push(code); }) as typeof process.exit);
    trackPrivateDir(finalize);
    const proc = Bun.spawn([bun, "-e", "setTimeout(() => process.exit(0), 300)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const waiting = guardedWait(() => proc);
      expect(hasActiveSignalOwner()).toBe(true);
      process.emit("SIGINT");
      expect(exits).toEqual([]);
      expect(finalized).toBe(0);
      expect(await waiting).toBe(0);
      expect(hasActiveSignalOwner()).toBe(false);
    } finally {
      untrackPrivateDir(finalize);
      exit.mockRestore();
      try { process.kill(proc.pid, "SIGKILL"); } catch { /* already ended */ }
    }
  }, 10_000);
});
