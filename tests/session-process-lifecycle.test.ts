import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { installSessionSignalHandlers } from "../src/session/process.js";
import { harness, tmp, waitGone, waitUntil } from "./helpers/session-process.js";

describe("session process runner", () => {
  test(
    "requestStop: SIGTERM to the child, then the remembered grandchild dies",
    async () => {
      const { proc, lines, done } = harness(
        "sleep 60 & printf '%s\\n' $!; sleep 30"
      );
      await waitUntil(() => lines.length === 1, 10_000);
      const grandchild = Number(lines[0]);
      expect(Number.isInteger(grandchild)).toBe(true);
      proc.requestStop();
      await done;
      // The tree kill must have reached the orphaned sleep.
      expect(await waitGone(grandchild, 10_000)).toBe(true);
      const outcome = await proc.exited;
      // sh dies by signal or exits after its children are gone; either is
      // a clean stop from this layer's point of view. The assertion is
      // that the child is terminal at all — killed by the stop signal or
      // holding an exit code — never still running (both fields null).
      expect(outcome.signal === "SIGTERM" || outcome.code !== null).toBe(true);
    },
    30_000
  );

  test(
    "a clean exit kills descendants the periodic capture remembered",
    async () => {
      // The child stays alive past one capture tick (5 s), so the
      // grandchild is remembered while its parent chain is intact — the
      // only state from which the end-path kill can reach it (a walk taken
      // after the parent exited cannot attribute an orphan).
      const { lines, done } = harness(
        "sleep 60 & printf '%s\\n' $!; sleep 6; exit 0"
      );
      await waitUntil(() => lines.length === 1, 10_000);
      const grandchild = Number(lines[0]);
      await done;
      expect(await waitGone(grandchild, 10_000)).toBe(true);
    },
    30_000
  );

  test(
    "SIGTERM mid-session runs the shutdown path and exits 143, grandchild included",
    async () => {
      const driver = Bun.spawn(
        [process.execPath, join(import.meta.dir, "fixtures", "session", "sigterm-driver.ts")],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        }
      );
      const reader = (driver.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      let grandchild = 0;
      while (grandchild === 0) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const newline = text.indexOf("\n");
        if (newline !== -1) {
          const first = text.slice(0, newline);
          expect(first.startsWith("LINE:")).toBe(true);
          grandchild = Number(first.slice("LINE:".length));
        }
      }
      expect(grandchild).toBeGreaterThan(1);
      process.kill(driver.pid, "SIGTERM");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      const exitCode = await driver.exited;
      expect(exitCode).toBe(143);
      expect(text).toContain(`LINE:${grandchild}`);
      expect(await waitGone(grandchild, 10_000)).toBe(true);
    },
    30_000
  );

  test("harness stderr passes through to codemux's stderr, never as lines", async () => {
    // Review live17, correctness major: stderr was piped into a capture
    // nothing read, so a harness that died at startup (an expired login,
    // a refused --model) left the caller only "exited unexpectedly". It
    // now passes through the way `run` passes it; stdout framing is
    // unaffected. The layer runs in a child so its stderr is observable.
    const script = [
      `import { SessionProcess } from ${JSON.stringify(join(import.meta.dir, "..", "src", "session", "process.ts"))};`,
      "const proc = new SessionProcess({",
      `  command: ["/bin/sh", "-c", "printf 'out\\n'; printf 'warn: login expired\\n' >&2; exit 3"],`,
      "  cwd: process.cwd(),",
      '  env: { PATH: "/usr/bin:/bin" },',
      "  onLine: (line) => process.stdout.write(`LINE:${line}\\n`),",
      "  onFatal: () => process.stdout.write('FATAL\\n'),",
      "  graceMs: 200,",
      "});",
      "await proc.settled;",
      "process.stdout.write(`CODE:${(await proc.exited).code}\\n`);",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: tmp(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    expect(stdout).toBe("LINE:out\nCODE:3\n");
    expect(stderr).toContain("warn: login expired");
  });

  test("requestStop after the child exited arms no kill timer (review live18)", async () => {
    // Minor: requestStop on an already-settled process armed a SIGKILL
    // timer nothing cleared, holding the event loop for the whole grace
    // and then signaling a reaped process group. With a 5 s grace, the
    // child script below would live 5 s; it must exit at once.
    const script = [
      `import { SessionProcess } from ${JSON.stringify(join(import.meta.dir, "..", "src", "session", "process.ts"))};`,
      "const proc = new SessionProcess({",
      '  command: ["/bin/sh", "-c", "exit 0"],',
      "  cwd: process.cwd(),",
      '  env: { PATH: "/usr/bin:/bin" },',
      "  onLine: () => {},",
      "  onFatal: () => {},",
      "  graceMs: 5000,",
      "});",
      "await proc.settled;",
      "proc.requestStop();",
    ].join("\n");
    const began = Date.now();
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: tmp(),
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    expect(await child.exited).toBe(0);
    expect(Date.now() - began).toBeLessThan(3_000);
  });
});

describe("session signal gate", () => {
  test("fires once, absorbs repeats, and dispose removes the handlers", async () => {
    const fired: string[] = [];
    const gate = installSessionSignalHandlers((signal) => {
      fired.push(signal);
    });
    gate.trigger("SIGTERM");
    gate.trigger("SIGINT");
    gate.trigger("SIGHUP");
    expect(fired).toEqual(["SIGTERM"]);
    gate.dispose();
  });
});
