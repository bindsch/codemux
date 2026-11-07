/**
 * Concurrent captured commands and a signal (review round 169, finding 1):
 * every active runCapturedCommand handles the signal itself, and the first
 * one to finish must not exit the process under the others — their SIGKILL
 * escalations and interruption receipts would be cut off, leaving a child
 * that ignores SIGTERM running in its own process group. The last signaled
 * command to finish exits with the signal code. The code under test exits,
 * so it runs in a child process this test owns.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRAP_SCRIPT =
  'process.on("SIGTERM", () => {});' +
  'require("node:fs").writeFileSync(process.env.TRAP_READY, "ready");' +
  'process.stdout.write("trapping\\n");' +
  'setInterval(() => {}, 1000);';
const PLAIN_SCRIPT =
  'require("node:fs").writeFileSync(process.env.PLAIN_READY, "ready");' +
  'process.stdout.write("plain\\n");' +
  'setInterval(() => {}, 1000);';

test("a signal while two captured commands run waits for every tree", async () => {
  if (process.platform === "win32") return;
  const cwd = mkdtempSync(join(tmpdir(), "codemux-concurrent-signal-"));
  const pidFile = join(cwd, "pids");
  const trapReady = join(cwd, "trap-ready");
  const plainReady = join(cwd, "plain-ready");
  // The child wraps Bun.spawn only to learn the grandchildren's pids; the
  // commands themselves run exactly what runCapturedCommand would spawn.
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    import { writeFileSync } from "node:fs";
    const pids = [];
    const real = Bun.spawn;
    Bun.spawn = (command, options) => {
      const proc = real(command, options);
      pids.push(proc.pid);
      writeFileSync(${JSON.stringify(pidFile)}, pids.join(" "));
      return proc;
    };
    const base = { cwd: ${JSON.stringify(cwd)}, env: {
      TRAP_READY: ${JSON.stringify(trapReady)}, PLAIN_READY: ${JSON.stringify(plainReady)},
    }, timeoutMs: 30_000 };
    await Promise.all([
      runCapturedCommand([process.execPath, "-e", ${JSON.stringify(TRAP_SCRIPT)}], base),
      runCapturedCommand([process.execPath, "-e", ${JSON.stringify(PLAIN_SCRIPT)}], base),
    ]);
  `;
  const runner = Bun.spawn([process.execPath, "-e", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pidsOf = (): number[] =>
    existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number) : [];
  try {
    // Wait for readiness, not a fixed delay: the trapping grandchild must
    // have its SIGTERM handler installed before the signal goes out.
    const deadline = Date.now() + 15_000;
    while (!(existsSync(trapReady) && existsSync(plainReady)) || pidsOf().length < 2) {
      if (Date.now() > deadline) throw new Error("the test child never became ready");
      await Bun.sleep(20);
    }
    runner.kill("SIGTERM");
    const [exit, stderr] = await Promise.all([
      runner.exited,
      new Response(runner.stderr).text(),
    ]);
    expect(exit).toBe(143);
    // One line for the whole stop, from the run that takes the exit.
    expect(stderr.split("codemux: interrupted; the agent's process tree was terminated").length - 1).toBe(1);
    // The trapping grandchild got the escalation the first finisher used to
    // cut off: it is gone once the process has exited.
    const pids = pidsOf();
    const trapPid = pids[0] as number;
    const plainPid = pids[1] as number;
    const gone = (pid: number): boolean => {
      try { process.kill(pid, 0); return false; }
      catch { return true; }
    };
    const reapDeadline = Date.now() + 5_000;
    while (!gone(trapPid) && Date.now() < reapDeadline) await Bun.sleep(20);
    expect(gone(trapPid)).toBe(true);
    expect(gone(plainPid)).toBe(true);
  } finally {
    for (const pid of pidsOf()) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    try { runner.kill("SIGKILL"); } catch {}
    await runner.exited;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

const LATE_SCRIPT =
  'require("node:fs").writeFileSync(process.env.LATE_READY, "ready");' +
  'setInterval(() => {}, 1000);';

test("no captured command starts while a signaled one is still terminating its tree", async () => {
  if (process.platform === "win32") return;
  const cwd = mkdtempSync(join(tmpdir(), "codemux-late-start-signal-"));
  const pidFile = join(cwd, "pids");
  const trapReady = join(cwd, "trap-ready");
  const lateReady = join(cwd, "late-ready");
  const lateAsked = join(cwd, "late-asked");
  // The first command traps SIGTERM, so its cleanup lasts the whole
  // force-kill delay. The script asks for a second command inside that
  // window, the way a caller between two steps would. Started, its child
  // would sit in its own process group when the first command's cleanup
  // exits codemux.
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    import { writeFileSync } from "node:fs";
    const pids = [];
    const real = Bun.spawn;
    Bun.spawn = (command, options) => {
      const proc = real(command, options);
      pids.push(proc.pid);
      writeFileSync(${JSON.stringify(pidFile)}, pids.join(" "));
      return proc;
    };
    const base = { cwd: ${JSON.stringify(cwd)}, env: {
      TRAP_READY: ${JSON.stringify(trapReady)}, LATE_READY: ${JSON.stringify(lateReady)},
    }, timeoutMs: 30_000 };
    process.on("SIGTERM", () => {
      setTimeout(() => {
        writeFileSync(${JSON.stringify(lateAsked)}, "asked");
        void runCapturedCommand([process.execPath, "-e", ${JSON.stringify(LATE_SCRIPT)}], base);
      }, 100);
    });
    await runCapturedCommand([process.execPath, "-e", ${JSON.stringify(TRAP_SCRIPT)}], base);
  `;
  const runner = Bun.spawn([process.execPath, "-e", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pidsOf = (): number[] =>
    existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number) : [];
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(trapReady) || pidsOf().length < 1) {
      if (Date.now() > deadline) throw new Error("the test child never became ready");
      await Bun.sleep(20);
    }
    runner.kill("SIGTERM");
    const [exit, stderr] = await Promise.all([
      runner.exited,
      new Response(runner.stderr).text(),
    ]);
    expect(exit).toBe(143);
    expect(stderr).toContain("codemux: interrupted; the agent's process tree was terminated");
    // The second command was asked for well before the exit (the trapped
    // SIGTERM costs the first one its two-second grace) and never spawned.
    expect(existsSync(lateAsked)).toBe(true);
    expect(pidsOf().length).toBe(1);
    expect(existsSync(lateReady)).toBe(false);
  } finally {
    for (const pid of pidsOf()) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    try { runner.kill("SIGKILL"); } catch {}
    await runner.exited;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

/** Runs `body` as a child script with runCapturedCommand imported and
 * Bun.spawn wrapped to record the pids it starts, signals it once every
 * ready file exists, and returns what the child did. */
async function signalScript(
  prefix: string,
  readyNames: string[],
  body: (cwd: string) => string
): Promise<{ exit: number; stderr: string; pids: number[]; cwd: string; elapsedMs: number; done(): void }> {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const pidFile = join(cwd, "pids");
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    import { writeFileSync } from "node:fs";
    const pids = [];
    const real = Bun.spawn;
    Bun.spawn = (command, options) => {
      const proc = real(command, options);
      pids.push(proc.pid);
      writeFileSync(${JSON.stringify(pidFile)}, pids.join(" "));
      return proc;
    };
    ${body(cwd)}
  `;
  const runner = Bun.spawn([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const pidsOf = (): number[] =>
    existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number) : [];
  const done = (): void => {
    for (const pid of pidsOf()) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    try { runner.kill("SIGKILL"); } catch {}
    rmSync(cwd, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 15_000;
    while (!readyNames.every((name) => existsSync(join(cwd, name)))) {
      if (Date.now() > deadline) throw new Error("the test child never became ready");
      await Bun.sleep(20);
    }
    const signaledAt = Date.now();
    runner.kill("SIGTERM");
    const [exit, stderr] = await Promise.all([runner.exited, new Response(runner.stderr).text()]);
    return { exit, stderr, pids: pidsOf(), cwd, elapsedMs: Date.now() - signaledAt, done };
  } catch (error) {
    done();
    await runner.exited;
    throw error;
  }
}

const gone = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch { return true; }
};

async function allGone(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (!pids.every(gone) && Date.now() < deadline) await Bun.sleep(20);
  return pids.every(gone);
}

test("a command started inside the signal's dispatch is signaled with the others", async () => {
  if (process.platform === "win32") return;
  // Review round 171: a listener registered before the first command's
  // handlers starts a second command while the signal is being
  // dispatched. Its own listeners are installed too late for that
  // dispatch, so the first command's handler has to signal it; otherwise
  // its child outlives the exit in its own process group.
  const run = await signalScript("codemux-dispatch-start-signal-", ["trap-ready"], (cwd) => `
    const base = { cwd: ${JSON.stringify(cwd)}, env: {
      TRAP_READY: ${JSON.stringify(join(cwd, "trap-ready"))}, LATE_READY: ${JSON.stringify(join(cwd, "late-ready"))},
    }, timeoutMs: 30_000 };
    process.on("SIGTERM", () => {
      void runCapturedCommand([process.execPath, "-e", ${JSON.stringify(LATE_SCRIPT)}], base);
    });
    await runCapturedCommand([process.execPath, "-e", ${JSON.stringify(TRAP_SCRIPT)}], base);
  `);
  try {
    expect(run.exit).toBe(143);
    expect(run.pids.length).toBe(2);
    expect(await allGone(run.pids)).toBe(true);
    expect(run.stderr.split("codemux: interrupted; the agent's process tree was terminated").length - 1).toBe(1);
  } finally {
    run.done();
  }
}, 30_000);

const HUNG_SINK = `
    let kept = "";
    const hungSink = {
      push(chunk) { kept += chunk; },
      finish() { return kept; },
      keptBytes() { return kept.length; },
      closeProtocol() { return new Promise(() => {}); },
    };
`;

test("a peer whose protocol cleanup never settles still writes its receipt and cannot hold the exit", async () => {
  if (process.platform === "win32") return;
  // Review rounds 171 and 174: closeProtocol has no deadline of its own.
  // After a signal it gets the cleanup grace, then the run goes on to its
  // interruption receipt; the first command to finish waits for that one
  // instead of exiting under it.
  const run = await signalScript("codemux-hung-peer-signal-", ["trap-ready", "plain-ready"], (cwd) => `
    const base = { cwd: ${JSON.stringify(cwd)}, env: {
      TRAP_READY: ${JSON.stringify(join(cwd, "trap-ready"))}, PLAIN_READY: ${JSON.stringify(join(cwd, "plain-ready"))},
    }, timeoutMs: 30_000 };
    ${HUNG_SINK}
    await Promise.all([
      runCapturedCommand([process.execPath, "-e", ${JSON.stringify(TRAP_SCRIPT)}], {
        ...base,
        stdoutSink: hungSink,
        onSignaled: () => { writeFileSync(${JSON.stringify(join(cwd, "receipt"))}, "interrupted"); },
      }),
      runCapturedCommand([process.execPath, "-e", ${JSON.stringify(PLAIN_SCRIPT)}], base),
    ]);
  `);
  try {
    expect(run.exit).toBe(143);
    expect(existsSync(join(run.cwd, "receipt"))).toBe(true);
    expect(run.stderr).toContain("protocol cleanup remains incomplete after the cleanup grace");
    expect(run.elapsedMs).toBeLessThan(15_000);
    expect(await allGone(run.pids)).toBe(true);
    expect(run.stderr.split("codemux: interrupted; the agent's process tree was terminated").length - 1).toBe(1);
  } finally {
    run.done();
  }
}, 40_000);

test("one command whose protocol cleanup never settles exits after a signal", async () => {
  if (process.platform === "win32") return;
  // The same grace with no peer: the run used to wait on closeProtocol
  // forever, so the signal never produced the receipt or the exit code.
  const run = await signalScript("codemux-hung-close-signal-", ["plain-ready"], (cwd) => `
    ${HUNG_SINK}
    await runCapturedCommand([process.execPath, "-e", ${JSON.stringify(PLAIN_SCRIPT)}], {
      cwd: ${JSON.stringify(cwd)},
      env: { PLAIN_READY: ${JSON.stringify(join(cwd, "plain-ready"))} },
      timeoutMs: 30_000,
      stdoutSink: hungSink,
      onSignaled: () => { writeFileSync(${JSON.stringify(join(cwd, "receipt"))}, "interrupted"); },
    });
  `);
  try {
    expect(run.exit).toBe(143);
    expect(existsSync(join(run.cwd, "receipt"))).toBe(true);
    expect(run.elapsedMs).toBeLessThan(10_000);
    expect(await allGone(run.pids)).toBe(true);
  } finally {
    run.done();
  }
}, 30_000);
