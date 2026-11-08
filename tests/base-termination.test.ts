import { describe, expect, spyOn, test } from "bun:test";
import { trackFixtureProcess } from "./setup.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedWait, runCapturedCommand } from "../src/process-runner.js";
import { processTableReadable } from "../src/process-table.js";
import { killDetachedFixture, stillRunning } from "./helpers/base.js";
import { childIdentityWrite } from "./helpers/fixture-leak.js";

const bun = process.execPath;

describe("captured process execution", () => {
  test("terminates a hung process at the configured deadline", async () => {
    const result = await runCapturedCommand(
      [bun, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutMs: 25,
      }
    );
    expect(result.exitCode).toBe(124);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("timed out");
  });

  test("terminates descendants that retain captured pipes", async () => {
    if (process.platform === "win32") return;
    const started = performance.now();
    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(childScript)}], { stdout: "inherit", stderr: "inherit" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const result = await runCapturedCommand([bun, "-e", parentScript], {
      cwd: process.cwd(),
      env: {},
      timeoutMs: 50,
    });
    expect(result.exitCode).toBe(124);
    // The deadline, not the pipes, ends the run — a hang blows far past
    // this; a slow runner's two interpreter launches fit inside it (audit
    // round 2, C-5).
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 15_000);

  test.skipIf(process.platform === "win32" || !processTableReadable())(
    "terminates descendants that close captured pipes and ignore SIGTERM after the grace period",
    async () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-descendant-"));
    const marker = join(cwd, "survived");
    const pidFile = join(cwd, "pid");
    // The descendant ignores SIGTERM, so it gets the two-second grace period
    // and then the SIGKILL, starting once the deadline fires — roughly 3.1 s
    // plus table reads. The marker is timed well past that, and checked only
    // after its time has come, so it fires only if the descendant survived.
    const markerAtMs = 6_000;
    const childScript = [
      "process.on('SIGTERM', () => {});",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setTimeout(() => Bun.write(${JSON.stringify(marker)}, "alive"), ${markerAtMs});`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(childScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      // The parent idles only once the descendant has written its pid file,
      // so the deadline cannot beat readiness and the pid-file assertion
      // below tests the fixture, not a startup race.
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(5);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        // One second: comfortably past two Bun launches and the readiness
        // write, without making the test crawl.
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(124);
      // The parent idled only after the pid file appeared, so a missing
      // file means the fixture itself broke — never a lost startup race.
      expect(existsSync(pidFile)).toBe(true);
      if (processTableReadable()) {
        await Bun.sleep(300);
        expect(stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      }
      // Absence is asserted only once the descendant is provably dead: a
      // SIGKILLed process cannot fire its 6 s marker timer later, so this
      // cannot pass through a parent-clock race under load (the child's
      // clock, not the parent's, governs the write). Polling kill(pid, 0)
      // replaces the old parent-clock wait to markerAtMs + 300.
      const descendant = Number(readFileSync(pidFile, "utf8"));
      // The SIGKILLed descendant may wait on a slow reaper; the window
      // covers a loaded runner without approaching the marker's own 6 s
      // (which only a survivor can fire, on the child's clock).
      const dead = Date.now() + 10_000;
      while (Date.now() < dead) {
        let alive: boolean;
        try {
          process.kill(descendant, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (!alive) break;
        await Bun.sleep(50);
      }
      expect(() => process.kill(descendant, 0)).toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // The expected path already killed and reaped the descendant.
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 25_000);

  // The tree-walk cases need process enumeration, which a host nested in a
  // sandbox may deny; they are reported as skipped there, never as passed.
  const treeWalk = test.skipIf(process.platform === "win32" || !processTableReadable());

  treeWalk("terminates descendants that escaped into their own process group", async () => {
    // Codex runs each tool command in a fresh process group, so a group kill
    // never reaches the shell loops it leaves behind. The runner must walk the
    // process tree by parent pid instead of trusting the group alone.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-escaped-"));
    const pidFile = join(cwd, "pid");
    // The grandchild reports its own pid only once its SIGTERM handler is
    // installed, so a pid file proves the escalation, not ordinary SIGTERM,
    // is what ended it.
    const grandchildScript = [
      "process.on('SIGTERM', () => {});",
      `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
      // Same readiness synchronization: idle only once the grandchild has
      // written its pid file (its SIGTERM handler is live by then).
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(5);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const result = await runCapturedCommand([bun, "-e", parentScript], {
        cwd,
        env: {},
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(124);
      // The parent idled only after the pid file appeared, so a missing
      // file means the fixture itself broke — never a lost startup race.
      expect(existsSync(pidFile)).toBe(true);
      // The grandchild ignored SIGTERM, so the runner waited out the grace
      // period and SIGKILLed it; once the reaper has collected it, it must
      // be gone from the process table.
      await Bun.sleep(300);
      expect(stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // The expected path already killed the escaped descendant.
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("returns from a timeout even when an unreachable orphan holds the output open", async () => {
    // The child hands its stdout to a detached grandchild and exits at once,
    // long before the timeout. No snapshot ever saw that grandchild under
    // the child, and it is in its own process group, so no signal can reach
    // it: the documented limitation. The run must still come back.
    // Establish the orphan before starting the timeout. Otherwise slow
    // interpreter startup can leave the parent alive when the timeout
    // fires, testing a different process tree and losing the note.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-orphan-"));
    const pidFile = join(cwd, "pid");
    const grandchildScript = [
      // pid\nstart, the identity format the exit guard reads: a reused pid
      // must not be mistaken for this fixture.
      childIdentityWrite(pidFile, "process.pid"),
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      `Bun.spawn([${JSON.stringify(bun)}, "-e", ${JSON.stringify(grandchildScript)}], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "ignore" });`,
      `while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(10);`,
      "process.exit(0);",
    ].join("\n");
    const command = [bun, "-e", parentScript];
    const untrack = trackFixtureProcess({ label: "codemux-orphan pid-file fixture", pidFile });
    const child = Bun.spawn(command, {
      cwd, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    try {
      expect(await child.exited).toBe(0);
      const started = performance.now();
      // Supply the already-exited parent with its still-open stdout pipe.
      const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
      let pending: ReturnType<typeof runCapturedCommand>;
      try {
        pending = runCapturedCommand(command, { cwd, env: {}, timeoutMs: 500 });
      } finally {
        spawn.mockRestore();
      }
      const result = await pending;
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("kept the output open");
      expect(performance.now() - started).toBeLessThan(6_000);
    } finally {
      await killDetachedFixture(untrack, pidFile, cwd);
    }
  }, 12_000);

  test("returns the child's exit code, with a note, when an unreachable orphan holds the input open", async () => {
    // Review round 372, item 10: after the captures and the exit settled,
    // the stdin wait had no give-up of its own — exitGiveUp is armed only
    // by a timeout, a signal, or a capture failure. A one-shot write past
    // the pipe buffer stayed pending forever when a descendant held the
    // stdin read end open after a clean exit, so the run parked until its
    // own timeout and reported 124 "agent timed out" with no note. The
    // wait is now bounded the way the pipe reads are, the run returns the
    // child's real exit code, and the note the output side prints names
    // the input orphan. The park is staged at the subprocess seam, the
    // same one the output-orphan test above uses: a real exited child
    // (its pid, kill, and empty output streams are real) whose stdin
    // write never settles — on this host Bun closes its stdin sink at
    // child exit (a pending write rejects EPIPE), so a live fixture
    // cannot hold the write open past the exit.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-stdin-orphan-"));
    const real = Bun.spawn(["/bin/sh", "-c", "exit 0"], {
      cwd, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    expect(await real.exited).toBe(0);
    const parked = new Promise<number>(() => {});
    const staged = {
      exited: real.exited,
      pid: real.pid,
      kill: (signal?: NodeJS.Signals) => real.kill(signal),
      stdin: { write: () => parked, end: () => parked },
      stdout: real.stdout,
      stderr: real.stderr,
    } as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
    const command = ["/bin/sh", "-c", "exit 0"];
    const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(staged);
    let pending: ReturnType<typeof runCapturedCommand>;
    try {
      pending = runCapturedCommand(command, {
        cwd,
        env: {},
        // Past the pipe buffer, the shape a real orphan parks: a write
        // that can never drain while nothing reads.
        stdinInput: "x".repeat(1024 * 1024),
        // Far past the bounded give-up the fix arms, and short of the
        // pre-fix parking: without the fix this run returns only once the
        // timeout (4 s) plus the kill grace (3 s) have run out, reporting
        // 124 with no input note.
        timeoutMs: 4_000,
      });
    } finally {
      spawn.mockRestore();
    }
    const started = performance.now();
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stderr).toContain("kept the input open");
    expect(performance.now() - started).toBeLessThan(3_500);
  }, 12_000);

  test("keeps the child's clean exit when the deadline lands in the stdin-wait window", async () => {
    // Review round 391, item 4: after the exit and both captures settle, the
    // runner still waits up to PIPE_GIVE_UP_MS (1 s) on stdin.settled(). The
    // timeout timer used to stay armed through that wait, so a deadline
    // landing inside it set timedOut and recast a child that exited 0 well
    // before the deadline as 124 "agent timed out". The timer is now cleared
    // the moment the exit and captures resolve, before the stdin wait: the
    // run's outcome is fixed and the timeout has nothing left to terminate.
    // The park is staged at the same subprocess seam as the test above.
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "codemux-stdin-window-"));
    const real = Bun.spawn(["/bin/sh", "-c", "exit 0"], {
      cwd, env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true,
    });
    expect(await real.exited).toBe(0);
    const parked = new Promise<number>(() => {});
    const staged = {
      exited: real.exited,
      pid: real.pid,
      kill: (signal?: NodeJS.Signals) => real.kill(signal),
      stdin: { write: () => parked, end: () => parked },
      stdout: real.stdout,
      stderr: real.stderr,
    } as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
    const command = ["/bin/sh", "-c", "exit 0"];
    const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(staged);
    let pending: ReturnType<typeof runCapturedCommand>;
    try {
      pending = runCapturedCommand(command, {
        cwd,
        env: {},
        // Past the pipe buffer, so the one-shot write parks like the
        // orphan case above.
        stdinInput: "x".repeat(1024 * 1024),
        // The deadline fires inside the bounded stdin wait (1 s), long
        // after this child exited 0.
        timeoutMs: 300,
      });
    } finally {
      spawn.mockRestore();
    }
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stderr).toContain("kept the input open");
    expect(result.stderr).not.toContain("agent timed out");
  }, 12_000);

  test("rejects invalid reusable timeout values before spawning", async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runCapturedCommand([bun, "-e", "process.exit(0)"], {
        cwd: process.cwd(),
        env: {},
        timeoutMs,
      })).rejects.toThrow("timeoutMs must be an integer");
    }
  });

  test("guardedWait rejects invalid timeout values before installing listeners", async () => {
    const proc = {
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
    await expect(guardedWait(() => proc, 0)).rejects.toThrow(
      "timeoutMs must be an integer"
    );
  });

});
