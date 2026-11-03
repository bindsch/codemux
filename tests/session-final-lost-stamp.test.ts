/**
 * A --final session whose end stamp is lost after the private directory was
 * removed exits 1 (review round 56): the record would otherwise stay
 * claimable while pointing at deleted transcript state. The stamp failure is
 * injected through the registry module's release function.
 */

import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as registryModule from "../src/session/registry.js";
import { projectSettingsConfigRoot } from "../src/claude-project-config.js";
import { runSessionCommand, tempWorkdir, waitForEvent } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));
const SCODE_PASSTHROUGH = 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"';
const userLine = (text: string): string => `${JSON.stringify({ type: "user", text })}\n`;
const shutdownLine = (): string => `${JSON.stringify({ type: "shutdown" })}\n`;

registerNoLeakedSignals();

test("a lost end stamp after the --final removal fails the exit code", async () => {
  const root = tempWorkdir("final-lost-stamp");
  const regRoot = tempWorkdir("final-lost-stamp-reg");
  const home = tempWorkdir("final-lost-stamp-home");
  const registry = join(regRoot, "live-sessions.json");
  const workdir = join(root, "work");
  mkdirSync(workdir, { recursive: true });
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const stdin = new PassThrough();
  const configRoot = projectSettingsConfigRoot({ HOME: home });
  // The stamp is lost: the release reports failure without writing.
  const release = spyOn(registryModule, "releaseSessionRecord").mockImplementation(() => false);
  try {
    const outcome = await runSessionCommand(
      [
        "-a", "claude", "--sandbox", "--hermetic",
        "--experiment-project-settings", "--auto", "low", "--final",
        "--cwd", workdir, "--shutdown-grace", "2",
        "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
      ],
      { claude: `exec bun '${FAKE_CLAUDE}' "$@"`, scode: SCODE_PASSTHROUGH },
      {
        registryFile: registry,
        stdin,
        env: { HOME: home, FAKE_STATE_DIR: stateDir, FAKE_CWD: workdir },
        drive: async ({ chunks }) => {
          stdin.write(userLine("scenario:basic hello"));
          await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
          await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
          stdin.write(shutdownLine());
        },
      }
    );
    expect(release).toHaveBeenCalled();
    // The directory is gone, the stamp was lost: the exit code says so.
    const parent = join(configRoot, ".codemux-hermetic");
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    expect(outcome.exitCode).toBe(1);
  } finally {
    release.mockRestore();
    rmSync(root, { recursive: true, force: true });
    rmSync(regRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
