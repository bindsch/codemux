/**
 * The spawn-throw catch's release survives a failing --final removal
 * (round 23, edges 2): the private directory's remove() throwing must not
 * skip releaseOwnedRecord() — the outer abort handler skips the release
 * because the spawn already began, so the record would be stranded — and
 * the failure is reported on stderr, naming the directory.
 */

import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as configModule from "../src/claude-project-config.js";
import * as spawnModule from "../src/session/spawn.js";
import { runSessionCommand, tempWorkdir, removeDir } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();

// --version answers the contract's floor; the spawn itself is stubbed, so
// no other invocation ever runs.
const FAKE_CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
exit 7`;
// A scode that only wraps: project-settings sessions require the sandbox,
// and the stubbed spawn never reaches the wrapper.
const SCODE_PASSTHROUGH = 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"';

test("a throwing --final removal still releases the record (round 23, edges 2)", async () => {
  const workdir = tempWorkdir("session-spawn-throw-final-");
  const regRoot = tempWorkdir("session-spawn-throw-final-reg-");
  const home = tempWorkdir("session-spawn-throw-final-home-");
  const registryFile = join(regRoot, "live-sessions.json");
  try {
    // The private directory's removal fails: the disk refuses it.
    const realOpen = configModule.openProjectSettingsSessionConfigDir;
    const open = spyOn(configModule, "openProjectSettingsSessionConfigDir").mockImplementation((
      ...args: Parameters<typeof realOpen>
    ) => {
      const staged = realOpen(...args);
      return {
        ...staged,
        remove: () => {
          throw new Error("disk refused the removal");
        },
      };
    });
    const spawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(async () => {
      throw new Error("spawn blew up");
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--cwd", workdir, "--sandbox", "--auto", "high",
          "--hermetic", "--experiment-project-settings", "--final"],
        { claude: FAKE_CLAUDE, scode: SCODE_PASSTHROUGH },
        { registryFile, env: { HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" } }
      );
      expect(outcome.exitCode).toBe(1);
      // The spawn failure itself is still reported, on stderr.
      expect(outcome.stderr).toContain("spawn blew up");
      // The removal failure is reported too, and names the directory it
      // could not remove.
      expect(outcome.stderr).toContain("disk refused the removal");
      expect(outcome.stderr).toContain(join(home, ".claude"));
      // The fresh record was discarded — the release ran despite the
      // throwing removal — so the registry holds no session.
      const registry = JSON.parse(readFileSync(registryFile, "utf8")) as {
        sessions: Array<{ id: string }>;
      };
      expect(registry.sessions).toHaveLength(0);
    } finally {
      spawn.mockRestore();
      open.mockRestore();
    }
  } finally {
    removeDir(workdir);
    removeDir(regRoot);
    removeDir(home);
  }
}, 20_000);
