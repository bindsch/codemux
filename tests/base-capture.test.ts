import { describe, expect, test } from "bun:test";
import { trackFixtureProcess } from "./setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CAPTURE_BYTES,
  OUTPUT_LIMIT_EXIT_CODE,
  runCapturedCommand,
} from "../src/process-runner.js";
import { killDetachedFixture } from "./helpers/base.js";

const bun = process.execPath;

describe("captured process execution", () => {
  test("captures stdout and stderr concurrently and forwards stdin, cwd, and env", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-base-"));
    try {
      const result = await runCapturedCommand(
        [
          bun,
          "-e",
          "const input=await Bun.stdin.text(); process.stdout.write(input); process.stderr.write(process.env.FLAG ?? '');",
        ],
        {
          cwd,
          env: { FLAG: "stderr" },
          stdinInput: "stdin",
          timeoutMs: 2_000,
        }
      );
      expect(result).toEqual({
        stdout: "stdin",
        stderr: "stderr",
        exitCode: 0,
        success: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("abandoning capture mid-character still returns the timeout result", async () => {
    // The cutoff can land between the bytes of a multibyte character. The
    // fatal decoder buffers the incomplete suffix and flushing it would
    // throw; the run must still return 124 with the output captured so far
    // instead of rejecting with an invalid-UTF-8 error.
    if (process.platform === "win32") return;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const originalKill = process.kill;
    try {
      let reads = 0;
      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          if (reads === 1) controller.enqueue(Buffer.from("ok\n", "utf8"));
          else if (reads === 2) controller.enqueue(Buffer.from([0xc3]));
          // otherwise: stall forever, holding the partial character
        },
      });
      const stderr = new ReadableStream<Uint8Array>({ start() {} });
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: { write() {}, end() {} },
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill() {},
      })) as unknown as typeof Bun.spawn;
      Bun.spawnSync = (() => ({
        exitCode: 0,
        stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
      })) as unknown as typeof Bun.spawnSync;
      process.kill = (() => true) as unknown as typeof process.kill;
      const result = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 50,
      });
      expect(result.exitCode).toBe(124);
      expect(result.success).toBe(false);
      expect(result.stdout).toBe("ok\n");
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
      process.kill = originalKill;
    }
  }, 15_000);

  test("captures thousands of small chunks in full", async () => {
    // The give-up reaction is registered once per stream; a chatty command
    // must still be captured completely.
    const result = await runCapturedCommand(
      [bun, "-e", "for (let i = 0; i < 5000; i++) process.stdout.write('x');"],
      { cwd: process.cwd(), env: {}, timeoutMs: 10_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("x".repeat(5000));
  }, 15_000);

  test("an output limit releases the other stream instead of stalling", async () => {
    // stdout floods past the capture limit while stderr is held open by a
    // process the kill cannot reach. The run failed already: it must come
    // back with 125 immediately, not when the timeout eventually fires.
    if (process.platform === "win32") return;
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const originalKill = process.kill;
    try {
      let floods = 0;
      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          floods += 1;
          if (floods === 1) controller.enqueue(Buffer.alloc(17 * 1024 * 1024, 120));
          // otherwise: stall, as a process past its kill would
        },
      });
      const stderr = new ReadableStream<Uint8Array>({ start() {} });
      Bun.spawn = (() => ({
        pid: 2147483647,
        stdin: { write() {}, end() {} },
        stdout,
        stderr,
        exited: Promise.resolve(0),
        kill() {},
      })) as unknown as typeof Bun.spawn;
      Bun.spawnSync = (() => ({
        exitCode: 0,
        stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
      })) as unknown as typeof Bun.spawnSync;
      process.kill = (() => true) as unknown as typeof process.kill;
      const started = performance.now();
      const result = await runCapturedCommand(["fixture"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 60_000,
      });
      const elapsed = performance.now() - started;
      expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("exceeded the");
      // Before this fix nothing released stderr until the timeout fired —
      // sixty seconds here, and forever when the holder was unreachable.
      // Well under one second proves the other stream was released by the
      // failure itself.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      Bun.spawn = originalSpawn;
      Bun.spawnSync = originalSpawnSync;
      process.kill = originalKill;
    }
  }, 15_000);

  test("a timed-out run whose sink folds past the capture bound fails at 125, not 124", async () => {
    // Round al32, edges major 1: the check after sink.finish() runs on
    // every exit branch, the give-up abandonment a timeout ends on
    // included. The unreachable orphan of the test above holds stdout
    // open past every signal and writes complete 64 KiB lines totaling
    // just under the capture bound, then one unterminated chunk over it;
    // the sink counts only complete lines while the stream runs, so no
    // per-push check trips, and exactly the fold inside finish() — the
    // wire-regime rule that does not count the buffered partial line
    // until close() folds it — carries the kept total past the bound.
    // Before al32 the give-up branch returned that fold unexamined and
    // the run exited 124 over the bound; it must fail at 125 with the
    // capture-limit error instead.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-fold-limit-"));
    const pidFile = join(cwd, "pid");
    // 242 complete 64 KiB lines (15.13 MiB, under the bound alone),
    // then a 1 MiB unterminated chunk (16.13 MiB once folded).
    const lineCount = Math.ceil((MAX_CAPTURE_BYTES * 0.945) / 65_536);
    const grandchildScript = [
      `const line = "x".repeat(65_535) + "\\n";`,
      `for (let i = 0; i < ${lineCount}; i++) await Bun.write(Bun.stdout, line);`,
      `await Bun.write(Bun.stdout, "y".repeat(1_048_576));`,
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "ignore" });`,
      // Idle only once the grandchild has written everything, then exit —
      // so the timeout's tree walk finds nobody and the orphan survives
      // to hold stdout open, exactly the abandonment shape.
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(5);`,
      "await Bun.sleep(50);",
      "process.exit(0);",
    ].join("\n");
    const untrack = trackFixtureProcess({ label: "capture-bound orphan line writer", pidFile });
    // The line-buffered sink: kept bytes are the complete lines alone
    // while pushes arrive; finish() folds the trailing partial in, and
    // keptBytes() answers for the fold too.
    let lines = "";
    let partial = "";
    let folded: string | null = null;
    const sink = {
      push(chunk: string): void {
        if (folded !== null) return;
        const text = partial + chunk;
        const cut = text.lastIndexOf("\n");
        if (cut === -1) {
          partial = text;
          return;
        }
        lines += text.slice(0, cut + 1);
        partial = text.slice(cut + 1);
      },
      finish(): string {
        if (folded === null) folded = lines + partial;
        return folded;
      },
      keptBytes(): number {
        return Buffer.byteLength(folded ?? lines);
      },
    };
    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        timeoutMs: 1_000,
        stdoutSink: sink,
      });
      expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
      expect(result.stderr).toContain("exceeded the");
      expect(result.stderr).toContain("capture limit");
      expect(result.success).toBe(false);
    } finally {
      await killDetachedFixture(untrack, pidFile, cwd);
    }
  }, 12_000);

  test("rejects invalid commands and malformed UTF-8 output", async () => {
    await expect(runCapturedCommand([], {
      cwd: process.cwd(),
      env: {},
    })).rejects.toThrow("command must contain");
    await expect(runCapturedCommand([
      bun,
      "-e",
      "process.stdout.write(Uint8Array.from([0x80]))",
    ], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
    })).rejects.toThrow("stdout is not valid UTF-8");
  });

  test("kills a process that exceeds the capture limit", async () => {
    const result = await runCapturedCommand(
      [
        bun,
        "-e",
        `process.stdout.write('x'.repeat(${MAX_CAPTURE_BYTES - 1}) + '😀')`,
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 5_000,
      }
    );
    expect(result.exitCode).toBe(125);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("capture limit");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThanOrEqual(
      MAX_CAPTURE_BYTES - 4
    );
    expect(result.stdout).not.toContain("\uFFFD");
  });

});

test("a capture-limit failure's partial output is itself bounded at the limit, on a character boundary (round 31, edges 5)", async () => {
  const { OutputLimitError, MAX_CAPTURE_BYTES } = await import("../src/process-capture.js");
  // 3-byte characters, well past the bound.
  const oversized = "\u20ac".repeat(Math.ceil(MAX_CAPTURE_BYTES / 3) + 1024);
  const error = new OutputLimitError("stdout", oversized);
  expect(Buffer.byteLength(error.partialOutput, "utf8")).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  expect(error.partialOutput.includes("\ufffd")).toBe(false);
  expect(new OutputLimitError("stderr", "small").partialOutput).toBe("small");
});

