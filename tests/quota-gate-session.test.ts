/**
 * The session happy path (same fake harness as tests/session-cli-happy-path.test.ts)
 * with a usagemux the gate would refuse and --no-quota-gate set: the
 * session must start, run one turn, and end cleanly.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { result, window } from "./helpers/quota-gate.js";

describe("CLI quota gate - session bypass", () => {
  test("session --no-quota-gate starts past a refused window", async () => {
    const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));
    const snapshot = JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      results: [
        result({ windows: [window({ kind: "primary", remainingPercent: 0, usedPercent: 100 })] }),
      ],
    });
    const fake = createFakeBinaryEnv({
      claude: `exec bun '${FAKE}' "$@"`,
      usagemux: `printf '%s' '${snapshot}'`,
    });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-gate-session-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir, { recursive: true });
    const stateDir = mkdtempSync(join(tmpdir(), "codemux-gate-state-"));
    try {
      // The suite-wide in-process switch (tests/setup.ts) must not reach
      // either child: this spawn's bypass must come from --no-quota-gate,
      // and the contrast spawn below must be refused by the real gate.
      const startedEnv = {
        ...process.env,
        CODEMUX_NO_KEYCHAIN_SYNC: "1",
        HOME: isolatedHome,
        XDG_CONFIG_HOME: join(isolatedHome, ".config"),
        ...fake.env,
        FAKE_STATE_DIR: stateDir,
        FAKE_CWD: workdir,
      } as Record<string, string>;
      delete startedEnv.CODEMUX_TEST_NO_QUOTA_GATE;
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
          "--no-quota-gate",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: startedEnv,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const found = events.find(pred);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
            );
          }
          await Bun.sleep(10);
        }
      };

      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("claude");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      expect(exitCode).toBe(0);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");

      // And the same session without the flag never starts: the gate is
      // what --no-quota-gate skipped, not a broken session.
      const refusedEnv = {
        ...process.env,
        CODEMUX_NO_KEYCHAIN_SYNC: "1",
        HOME: mkdtempSync(join(tmpdir(), "codemux-gate-home2-")),
        XDG_CONFIG_HOME: join(mkdtempSync(join(tmpdir(), "codemux-gate-cfg2-")), ".config"),
        ...fake.env,
        FAKE_STATE_DIR: stateDir,
        FAKE_CWD: workdir,
      } as Record<string, string>;
      // This spawn must be refused by the real gate; the suite-wide
      // in-process switch (tests/setup.ts) must not reach the child.
      delete refusedEnv.CODEMUX_TEST_NO_QUOTA_GATE;
      const refused = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: refusedEnv,
        }
      );
      const [refusedCode, refusedStderr] = await Promise.all([
        refused.exited,
        new Response(refused.stderr).text(),
      ]);
      expect(refusedCode).toBe(64);
      expect(refusedStderr).toContain("quota gate: claude");
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});
