/**
 * Full `codemux session` drives whose harness output ends in a tier-3
 * fatal: bytes no decoder accepts or a line no parser accepts. These are
 * the only drives that execute the driver-facing onFatal callbacks
 * (src/session/cli.ts for the single-process agents,
 * src/session/cli-drivers.ts for the per-turn spawn), so they live in
 * their own file beside the other drive suites.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { outcomeEvents, runSessionCommand, tempWorkdir, waitForEvent } from "./helpers/session-command.js";

const FAKE_KIMI = fileURLToPath(new URL("./fixtures/live/fake-kimi-run.ts", import.meta.url));

const fakeHarness = (fixture: string): string => `exec bun '${fixture}' "$@"`;

const withVersion = (body: string, version: string): string =>
  `if [ "$1" = "--version" ]; then printf '${version}\\n'; exit 0; fi\n${body}`;

const userLine = (text: string): string => `${JSON.stringify({ type: "user", text })}\n`;

describe("the session command driven in process", () => {
  test("claude: a harness line that is not UTF-8 is a tier-3 fatal", async () => {
    const root = tempWorkdir("drive-badutf");
    const regRoot = tempWorkdir("drive-badutf-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--no-sandbox", "--auto", "high", "--cwd", workdir, "--shutdown-grace", "1"],
        // One undecodable line on stdout: the process layer's fatal
        // channel, which reaches the driver through its onFatal arrow.
        { claude: `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi\nprintf '\\xff\\xfe\\n'\nsleep 5` },
        { registryFile: registry, stdin }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(JSON.stringify(events)).toContain("invalid-utf8");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("kimi: bytes no decoder accepts end the turn's spawn through onFatal", async () => {
    const root = tempWorkdir("drive-garbage");
    const regRoot = tempWorkdir("drive-garbage-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const stateDir = join(root, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2", "--pass-env", "FAKE_STATE_DIR",
        ],
        // The badbytes scenario writes undecodable bytes and stays open,
        // so the turn's own child — not the session process — reports
        // the fatal the spawn's onFatal arrow carries to the driver.
        { kimi: withVersion(fakeHarness(FAKE_KIMI), "2.5.2") },
        {
          registryFile: registry,
          stdin,
          env: { FAKE_STATE_DIR: stateDir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:badbytes one"));
            await waitForEvent(chunks, "session_ended", (event) => event.type === "session_ended");
          },
        }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(JSON.stringify(events)).toContain("fatal");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
