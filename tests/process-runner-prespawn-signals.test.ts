/**
 * runCapturedCommand's pre-spawn signal wiring (review round 169, finding
 * 2): the three signal handlers and the active-command count are installed
 * before Bun.spawn, so no window exists in which a signal has no
 * operating-system handler while the child is being born, and a spawn that
 * throws leaves neither the count nor a listener behind.
 */
import { expect, test } from "bun:test";
import { hasActiveCapturedCommand, runCapturedCommand } from "../src/process-runner.js";

/** A child that exits 0 at once with closed streams, the shape
 * base-capture-stdin.test.ts established for in-process runner tests. */
function fakeChild(): unknown {
  const closed = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  return {
    pid: 2147483647,
    stdin: { write() { return 0; }, end() { return 0; } },
    stdout: closed(),
    stderr: closed(),
    exited: Promise.resolve(0),
    kill() {},
  };
}

test("the signal handlers and the active count are installed before the spawn", async () => {
  if (process.platform === "win32") return;
  const originalSpawn = Bun.spawn;
  const originalSpawnSync = Bun.spawnSync;
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    sighup: process.listenerCount("SIGHUP"),
  };
  // Read at the moment the spawn is called, inside the mock.
  let atSpawn: { counted: boolean; sigint: number; sigterm: number; sighup: number } | null = null;
  try {
    Bun.spawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
    })) as unknown as typeof Bun.spawnSync;
    Bun.spawn = (() => {
      atSpawn = {
        counted: hasActiveCapturedCommand(),
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
        sighup: process.listenerCount("SIGHUP"),
      };
      return fakeChild() as never;
    }) as unknown as typeof Bun.spawn;
    const result = await runCapturedCommand(["fixture"], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(atSpawn!.counted).toBe(true);
    expect(atSpawn!.sigint).toBe(before.sigint + 1);
    expect(atSpawn!.sigterm).toBe(before.sigterm + 1);
    expect(atSpawn!.sighup).toBe(before.sighup + 1);
    // The run finished: everything it installed came back down.
    expect(hasActiveCapturedCommand()).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    expect(process.listenerCount("SIGHUP")).toBe(before.sighup);
  } finally {
    Bun.spawn = originalSpawn;
    Bun.spawnSync = originalSpawnSync;
  }
}, 15_000);

test("a spawn that throws leaves no active count and no listener behind", async () => {
  if (process.platform === "win32") return;
  const originalSpawn = Bun.spawn;
  const originalSpawnSync = Bun.spawnSync;
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    sighup: process.listenerCount("SIGHUP"),
  };
  try {
    Bun.spawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from("1 0 1 S Sat Sep 5 00:00:00 2026\n"),
    })) as unknown as typeof Bun.spawnSync;
    Bun.spawn = (() => { throw new Error("spawn refused"); }) as unknown as typeof Bun.spawn;
    const rejection = await runCapturedCommand(["fixture"], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
    }).then(
      () => { throw new Error("expected a rejection"); },
      (error: Error) => error
    );
    expect(rejection.message).toBe("spawn refused");
    // The undo of the pre-spawn install ran exactly once: the count the
    // finally would have decremented never leaked, and no handler stays.
    expect(hasActiveCapturedCommand()).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    expect(process.listenerCount("SIGHUP")).toBe(before.sighup);
  } finally {
    Bun.spawn = originalSpawn;
    Bun.spawnSync = originalSpawnSync;
  }
}, 15_000);
