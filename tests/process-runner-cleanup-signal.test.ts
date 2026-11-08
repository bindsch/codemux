/**
 * Review round 401, item 2: a signal that lands inside the runner's
 * cleanup window — while closeProtocol awaits real I/O — used to
 * terminate nothing. The kill condition was read once at finally entry,
 * and terminateRun saw cleanup already started, so no SIGTERM went out
 * and no force-kill was armed; codemux exited 143 leaving members of the
 * dead child's process group alive. The fix is in two parts: the first
 * termination now signals whatever the window (terminateRun sends the
 * group SIGTERM and arms the force-kill deadline during cleanup too), and
 * the kill condition is re-read after the protocol cleanup closes, before
 * the exit that would kill the timers. Every observation here is
 * synthetic: the group sends are recorded by a wrapped process.kill in
 * the runner subprocess, and the process table is stubbed to the
 * unknown-table mode (the degraded mode that fires the group signal
 * unconditionally), so the test holds whatever the host's ps access is.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a signal inside the cleanup window still SIGTERMs and SIGKILLs the tree", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-cleanup-signal-"));
  const markerFile = join(cwd, "cleanup-started");
  const recordFile = join(cwd, "group-signals");
  const pidFile = join(cwd, "child.pid");
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    import { spyOn } from "bun:test";
    import * as processTable from ${JSON.stringify(join(import.meta.dir, "../src/process-table.ts"))};
    import { appendFileSync, writeFileSync } from "node:fs";
    // Unknown-table mode: the group signal fires without consulting ps,
    // so the case does not depend on the host's process-table access.
    spyOn(processTable, "readProcessTable").mockImplementation(() => new Map());
    const realKill = process.kill;
    process.kill = (pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        appendFileSync(${JSON.stringify(recordFile)}, pid + ":" + signal + "\\n");
      }
      return realKill(pid, signal);
    };
    const spawn = Bun.spawn;
    let child;
    Bun.spawn = (...args) => {
      const proc = spawn(...args);
      if (!child) {
        child = proc;
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      }
      return proc;
    };
    const sink = {
      push() {}, finish() { return ""; }, keptBytes() { return 0; },
      closeProtocol() {
        // Real I/O in flight: the marker tells the parent the window is
        // open, and the promise never settles — the runner's own cleanup
        // grace bounds it, exactly like a relay drain that hangs.
        writeFileSync(${JSON.stringify(markerFile)}, "1");
        return new Promise(() => {});
      },
    };
    const watchdog = setTimeout(() => process.exit(98), 9000);
    await runCapturedCommand([process.execPath, "-e", "process.exit(0)"], {
      cwd: ${JSON.stringify(cwd)}, env: {}, timeoutMs: 30000, stdoutSink: sink,
    });
    clearTimeout(watchdog);
  `;
  const runner = Bun.spawn([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  try {
    // The window is open once the protocol cleanup began.
    const opened = Date.now() + 5000;
    while (!existsSync(markerFile)) {
      if (Date.now() > opened) throw new Error("the cleanup window never opened");
      await Bun.sleep(20);
    }
    process.kill(runner.pid, "SIGINT");
    const exited = await Promise.race([
      runner.exited,
      Bun.sleep(8000).then(() => null),
    ]);
    expect(exited).toBe(143);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    const signals = existsSync(recordFile) ? readFileSync(recordFile, "utf8").trim().split("\n") : [];
    // The SIGTERM left at signal time (terminateRun), the SIGKILL at the
    // re-read before the exit. Pre-fix, no group send went out at all.
    expect(signals).toEqual([`-${childPid}:SIGTERM`, `-${childPid}:SIGKILL`]);
  } finally {
    try { process.kill(runner.pid, "SIGKILL"); } catch {}
    await runner.exited;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 10000);
