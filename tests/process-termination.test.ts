import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["protocol", "limit", "timeout"])("throwing protocol termination preserves %s and reaps the child", async (kind) => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-termination-"));
  const pidFile = join(cwd, "child.pid");
  const script = `
    import { runCapturedCommand, MAX_CAPTURE_BYTES, FORCE_KILL_DELAY_MS } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    import { writeFileSync } from "node:fs";
    const kind = ${JSON.stringify(kind)};
    const spawn = Bun.spawn;
    let child;
    let exited = false;
    const watchdog = setTimeout(() => { child?.kill("SIGKILL"); process.exit(99); }, 6000);
    Bun.spawn = (...args) => {
      const proc = spawn(...args);
      if (!child) {
        child = proc;
        void proc.exited.then(() => { exited = true; });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      }
      return proc;
    };
    const schedule = globalThis.setTimeout;
    let forceKillArmed = false;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === FORCE_KILL_DELAY_MS) forceKillArmed = true;
      return schedule(callback, delay, ...args);
    };
    let armedBeforeHook = false;
    let reapedBeforeClose = false;
    const sink = {
      push() { if (kind === "protocol") throw new Error("original capture failure"); },
      finish() { return ""; }, keptBytes() { return 0; },
      terminateProtocol() { armedBeforeHook = forceKillArmed; throw new Error("termination hook failed"); },
      closeProtocol() { reapedBeforeClose = exited; }
    };
    const output = kind === "limit"
      ? "process.stderr.write(Buffer.alloc(" + (MAX_CAPTURE_BYTES + 1) + ", 65));"
      : 'process.stdout.write("ready");';
    let result, error;
    try {
      result = await runCapturedCommand([process.execPath, "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); ' + output],
        { cwd: ${JSON.stringify(cwd)}, env: {}, timeoutMs: kind === "timeout" ? 200 : 10000, stdoutSink: sink });
    } catch (caught) { error = caught.message; }
    console.log(JSON.stringify({ exitCode: result?.exitCode, stderr: result?.stderr.slice(-500), error,
      armedBeforeHook, reapedBeforeClose }));
    clearTimeout(watchdog);
  `;
  const runner = Bun.spawn([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  try {
    const [exit, stdout, stderr] = await Promise.all([
      runner.exited, new Response(runner.stdout).text(), new Response(runner.stderr).text(),
    ]);
    expect(stderr).not.toContain("error: termination hook failed");
    expect(exit).toBe(0);
    const result = JSON.parse(stdout);
    if (kind === "protocol") expect(result.error).toContain("original capture failure");
    else expect(result.exitCode).toBe(kind === "timeout" ? 124 : 125);
    expect(result.error ?? result.stderr).toContain("termination hook failed");
    expect(result.armedBeforeHook).toBe(true);
    expect(result.reapedBeforeClose).toBe(true);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    }
    runner.kill("SIGKILL");
    await runner.exited;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 10000);
