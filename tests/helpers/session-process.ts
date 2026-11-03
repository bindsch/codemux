import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionProcess, type SessionFatal } from "../../src/session/process.js";

/** A SessionProcess over a /bin/sh script, collecting lines and fatals. */
export function harness(script: string, graceMs = 500): {
  proc: SessionProcess;
  lines: string[];
  fatals: SessionFatal[];
  done: Promise<void>;
} {
  const lines: string[] = [];
  const fatals: SessionFatal[] = [];
  const proc = new SessionProcess({
    command: ["/bin/sh", "-c", script],
    cwd: tmp(),
    env: { PATH: "/usr/bin:/bin" },
    onLine: (line) => {
      lines.push(line);
    },
    onFatal: (fatal) => {
      fatals.push(fatal);
    },
    graceMs,
  });
  return { proc, lines, fatals, done: proc.settled };
}

let tmpDir: string | null = null;

export function tmp(): string {
  if (tmpDir === null) {
    tmpDir = mkdtempSync(join(tmpdir(), "codemux-session-proc-"));
  }
  return tmpDir;
}

/** Poll until `pid` is gone (ESRCH), or fail after `ms`. */
export async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

export async function waitUntil(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

// Cleanup for the shared tmp dir once the tests are done.
process.on("beforeExit", () => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});
