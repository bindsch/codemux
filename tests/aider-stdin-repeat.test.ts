/**
 * Aider's repeating decline carrier (review round 153, finding 3): while
 * an aider child codemux started headless is alive, a read of its stdin
 * never returns EOF and always returns a decline — aider reads EOF as
 * acceptance of its yes-default prompts, and one canned block ran out.
 * Real /bin/sh fake children exercise both carriers: the run path
 * (runCapturedCommand with stdinRepeats) and the session turn path (the
 * driver's repeatRawUntilExit). Every test runs its scenario 25 times.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADLESS_NEGATIVE_RESPONSES } from "../src/adapters/aider.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { SessionProcess } from "../src/session/process.js";
import type { AiderSessionDriver } from "../src/session/aider-driver.js";
import { cleanups, startSession, waitFor, type Event } from "./helpers/session-aider-e2e.js";

const RUNS = 25;

const scratch: string[] = [];
afterAll(async () => {
  for (const clean of cleanups.reverse()) await clean();
  while (scratch.length > 0) {
    const dir = scratch.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The fake child: reads exactly 200 lines, counts the `n` ones, and
 * reports whether stdin hit EOF before the 200th read. Under the
 * repeating carrier every read returns a decline and EOF never arrives
 * while the child lives. */
function readerScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "codemux-decline-"));
  scratch.push(dir);
  const script = join(dir, "read-two-hundred");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      "n=0",
      "other=0",
      "i=0",
      'while [ "$i" -lt 200 ]; do',
      '  IFS= read -r line || break',
      '  if [ "$line" = "n" ]; then n=$((n+1)); else other=$((other+1)); fi',
      "  i=$((i+1))",
      "done",
      'if [ "$i" -lt 200 ]; then eof=yes; else eof=no; fi',
      'echo "lines=$i n=$n other=$other eof=$eof"',
    ].join("\n") + "\n"
  );
  return script;
}

/** The fake child that reads nothing and exits 3 a moment later — long
 * enough that the first block always flushes before the pipe breaks, so
 * the repeat mode and the one-shot mode are comparable. */
function nonReaderScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "codemux-decline-"));
  scratch.push(dir);
  const script = join(dir, "read-nothing");
  writeFileSync(script, "#!/bin/sh\nsleep 0.1\nexit 3\n");
  return script;
}

/** The fake child that exits at once without reading — the EPIPE window:
 * a repeat write after this child is gone must be swallowed, never an
 * unhandled rejection, and the run must still end. */
function instantExitScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "codemux-decline-"));
  scratch.push(dir);
  const script = join(dir, "exit-at-once");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  return script;
}

function parseSummary(stdout: string): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const part of stdout.trim().split(/\s+/)) {
    const [key, value] = part.split("=");
    if (key !== undefined && value !== undefined) summary[key] = value;
  }
  return summary;
}

describe("the repeating decline carrier", () => {
  test("the run path feeds declines for the child's whole lifetime", async () => {
    const script = readerScript();
    for (let attempt = 1; attempt <= RUNS; attempt++) {
      const result = await runCapturedCommand(["/bin/sh", script], {
        cwd: process.cwd(),
        env: { PATH: "/usr/bin:/bin" },
        stdinInput: HEADLESS_NEGATIVE_RESPONSES,
        stdinRepeats: true,
        timeoutMs: 10_000,
      });
      const summary = parseSummary(result.stdout);
      expect(summary, `attempt ${attempt}`).toEqual({
        lines: "200",
        n: "200",
        other: "0",
        eof: "no",
      });
      expect(result.exitCode, `attempt ${attempt}`).toBe(0);
    }
  }, 60_000);

  test("the session turn path feeds declines for the child's whole lifetime", async () => {
    const script = readerScript();
    for (let attempt = 1; attempt <= RUNS; attempt++) {
      let driver!: AiderSessionDriver;
      const session = await startSession({
        spawnTurn: async () => {
          const proc = new SessionProcess({
            command: ["/bin/sh", script],
            cwd: sessionWorkDir(),
            env: { PATH: "/usr/bin:/bin" },
            onLine: (line) => driver.handleHarnessLine(line),
            onFatal: (fatal) => driver.handleFatal(fatal),
            graceMs: 500,
          });
          return proc;
        },
      });
      driver = session.driver;
      session.driver.handleCallerLine(
        JSON.stringify({ type: "user", text: "read the declines" })
      );
      const summaryLine = await waitFor(
        session.events,
        (events: Event[]) =>
          events.find(
            (event) => event.type === "unknown" && typeof event.raw === "string" && event.raw.startsWith("lines=")
          ),
        `summary line (attempt ${attempt})`
      );
      const summary = parseSummary(summaryLine.raw as string);
      expect(summary, `attempt ${attempt}`).toEqual({
        lines: "200",
        n: "200",
        other: "0",
        eof: "no",
      });
      session.driver.handleCallerLine(JSON.stringify({ type: "shutdown" }));
      expect(await session.code, `attempt ${attempt}`).toBe(0);
    }
  }, 120_000);

  test("a child that exits without reading still ends the run cleanly", async () => {
    const script = instantExitScript();
    for (let attempt = 1; attempt <= RUNS; attempt++) {
      // The run settles — a resolved capture or the wrapped stdin
      // failure, never a hang and never an unhandled rejection (bun
      // fails the suite on one; the repeat's EPIPE is swallowed in the
      // feeder).
      const outcome = await runCapturedCommand(["/bin/sh", script], {
        cwd: process.cwd(),
        env: { PATH: "/usr/bin:/bin" },
        stdinInput: HEADLESS_NEGATIVE_RESPONSES,
        stdinRepeats: true,
        timeoutMs: 10_000,
      }).then(
        (result) => ({ ok: true as const, exitCode: result.exitCode }),
        (error: Error) => ({ ok: false as const, name: error.name })
      );
      if (outcome.ok) expect(outcome.exitCode, `attempt ${attempt}`).toBe(0);
      else expect(outcome.name, `attempt ${attempt}`).toBe("CapturedRunFailure");
    }
  }, 60_000);

  test("the result and exit code are unchanged for a child that reads nothing", async () => {
    const script = nonReaderScript();
    const outcome = (stdinRepeats: boolean) =>
      runCapturedCommand(["/bin/sh", script], {
        cwd: process.cwd(),
        env: { PATH: "/usr/bin:/bin" },
        stdinInput: HEADLESS_NEGATIVE_RESPONSES,
        stdinRepeats,
        timeoutMs: 10_000,
      }).then(
        (result) => ({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, success: result.success }),
        (error: Error) => ({ name: error.name, message: error.message })
      );
    for (let attempt = 1; attempt <= RUNS; attempt++) {
      const repeating = await outcome(true);
      const oneShot = await outcome(false);
      expect(repeating, `attempt ${attempt}`).toEqual(oneShot);
      expect(oneShot, `attempt ${attempt}`).toHaveProperty("exitCode", 3);
    }
    // 50 real child runs (25 pairs) with a deliberate 0.1 s exit delay
    // each sit inside this test: well past bun's 5 s default per test.
  }, 120_000);
});

/** A stable working directory for the fake turn children (each session's
 * own work dir is created inside the rig; the spawn closure only needs a
 * directory that exists for the child's cwd). */
let workDir: string | null = null;
function sessionWorkDir(): string {
  if (workDir === null) {
    workDir = mkdtempSync(join(tmpdir(), "codemux-decline-work-"));
    scratch.push(workDir);
  }
  return workDir;
}
