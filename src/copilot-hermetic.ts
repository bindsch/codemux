/**
 * A private config directory for hermetic Copilot runs.
 *
 * Copilot keeps every operator customization under one roof: settings.json
 * and config.json (user settings, hooks, allowed/denied URLs, trusted
 * folders), copilot-instructions.md, the modular instruction files under
 * instructions/, skills, custom agents, plugins, the MCP config, memories
 * and the session state, all in $HOME/.copilot. `COPILOT_HOME` moves the
 * whole directory
 * ("override the directory where configuration and state files are stored",
 * `copilot help environment` at 1.0.85), the two user-level instruction
 * locations follow it (docs.github.com, "Add custom instructions" for
 * Copilot CLI), and setting it also stops skills loading from
 * ~/.agents/skills (changelog 1.0.66). A hermetic run points COPILOT_HOME at
 * a fresh directory and closes the repo channels with flags in the adapter.
 *
 * The login is the one thing that must survive: the OAuth token lives in the
 * operating system's keychain under the service name "copilot-cli"
 * (docs.github.com, "Authenticate Copilot CLI"), which is not keyed by the
 * config directory, so an empty private home still authenticates. A
 * plaintext fallback token in the real config.json (keychain-less systems)
 * does not follow, and such a run fails authentication with Copilot's own
 * error; that is recorded in docs/HERMETIC.md rather than worked around,
 * because linking the whole config.json would import trusted folders, hooks
 * and settings along with the token.
 *
 * The private home lives inside the real config directory
 * (`~/.copilot/.codemux-hermetic/`, or the operator's passed-through
 * COPILOT_HOME), never under the temp root (the Linux sandbox mounts a fresh
 * /tmp that would hide it). It holds no login, so a codemux that dies between
 * creating it and launching the run leaves only an empty directory behind;
 * the sweep below removes it on a later run. While a run is in flight the
 * process runner owns signals and the exit event finalizes, so this module
 * installs none of its own.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface CopilotHermeticHome {
  /** The private COPILOT_HOME. */
  home: string;
  /** Removes the home. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux-hermetic";
const RUN_PREFIX = "run-";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler may leave a Copilot child
// running in its home for as long as a run is allowed to last; a home is
// swept only once it is older than the longest run plus a margin.
const STALE_HOME_MS = 2 * 86_400_000;

/** Removes homes left behind by codemux processes that no longer exist. */
function sweepStaleHomes(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^run-(\d+)-/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    const path = join(parent, entry);
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (age < STALE_HOME_MS) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Creates the private home. `realConfigDir` is the config directory a plain
 * run reads (~/.copilot, or the operator's passed-through COPILOT_HOME); the
 * home is created under it, in `.codemux-hermetic/`.
 */
export function createCopilotHermeticHome(
  realConfigDir: string
): CopilotHermeticHome {
  const parent = join(realConfigDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the config directory could have replaced the
  // parent with a symlink, pointing the sweep's rm elsewhere.
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid())
  ) {
    throw new Error(`${parent} must be a directory owned by the current user`);
  }
  sweepStaleHomes(parent);
  const home = mkdtempSync(join(parent, `${RUN_PREFIX}${process.pid}-`));

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    rmSync(home, { recursive: true, force: true });
    process.off("exit", finalize);
  };
  process.once("exit", finalize);

  return { home, finalize };
}
