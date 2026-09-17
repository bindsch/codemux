/**
 * The per-run data directory behind cline's provider override.
 *
 * Cline reads provider credentials from a single JSON settings file —
 * `~/.cline/data/settings/providers.json` by default — and the
 * `openai-compatible` built-in ("OpenAI-compatible chat completions
 * endpoint", `builtins.ts`) takes an explicit `baseUrl` whose key,
 * however, has no environment form: `apiKeyEnv` is a configure-UI hint
 * and the runtime reads the key from the settings file only, while
 * `-k/--key` would put it in argv. The override therefore rides a
 * private settings file.
 *
 * Pointing `CLINE_PROVIDER_SETTINGS_PATH` at that file is not enough,
 * and the live exercise at 3.0.62 showed why: after the first run, a
 * one-shot `cline --` attaches the session to a long-lived hub daemon
 * (`forceLocalBackend: isYoloMode || config.sandbox === true`,
 * apps/cli/src/runtime/run-agent.ts — false on a plain run), and the
 * session config it sends carries the provider id, model and key but
 * not the base URL, so the daemon rebuilds the provider from its own
 * defaults: the very next run sent the override's key to
 * api.openai.com. `--data-dir <path>` ("Use isolated local state at
 * this directory path", 3.0.62 `--help`) fixes both at once —
 * `configureSandboxEnvironment` (apps/cli/src/utils/helpers.ts) sets
 * `CLINE_SANDBOX=1`, points every state path including
 * `CLINE_PROVIDER_SETTINGS_PATH` at `<dir>/settings/providers.json`,
 * and the sandbox flag forces the local, in-process backend that reads
 * that file. The override writes exactly that file into a private data
 * directory and passes the directory as `--data-dir`; provider, key
 * and base URL all resolve from it, the key never touches argv or an
 * operator file, and no environment variable is involved at all.
 *
 * The directory lives under the real cline directory in `.codemux/`, a
 * name no cline discovery scans (rules, skills, hooks, workflows,
 * agents and plugins load from named siblings of the cline directory
 * and the data directory, never from `.codemux`), and one scode keeps
 * reachable as harness state; never under the temp root, whose Linux
 * sandbox mount would hide it. It is removed at exit and swept once
 * its owning codemux process is gone.
 */

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProviderOverride } from "./provider-override.js";

export interface ClineProviderDataDir {
  /** The value for cline's `--data-dir`: the run's isolated state root. */
  path: string;
  /** Removes the directory and its parent-owned siblings. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "provider-";

/** The built-in provider id the override's settings entry configures. */
export const CLINE_PROVIDER_ID = "openai-compatible";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler leaves the directory
// behind; it is swept only once older than any run could still be reading
// it.
const STALE_DIR_MS = 2 * 86_400_000;

/** Removes directories left behind by codemux processes that no longer exist. */
function sweepStaleDirectories(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^provider-(\d+)-/.exec(entry);
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
    if (age < STALE_DIR_MS) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Writes the private data directory. `realClineDir` is the cline
 * directory a plain run reads (`~/.cline`, or the operator's passed
 * through `CLINE_DIR`); `model` is the model id the entry routes,
 * already validated.
 */
export function writeClineProviderDataDir(
  realClineDir: string,
  override: ProviderOverride & { baseUrl: string; apiKey: string },
  model: string
): ClineProviderDataDir {
  const parent = join(realClineDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the cline directory could have replaced
  // the parent with a symlink, pointing the sweep's rm elsewhere.
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid())
  ) {
    throw new Error(`${parent} must be a directory owned by the current user`);
  }
  sweepStaleDirectories(parent);
  const dir = join(
    parent,
    `${DIR_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`
  );
  mkdirSync(dir, { mode: 0o700 });
  // StoredProviderSettingsSchema (types/provider-settings.ts): the
  // version literal, and per-provider entries of settings/updatedAt/
  // tokenSource. An explicit baseUrl wins over the provider default in
  // toProviderConfig; `lastUsedProvider` plus the command's explicit
  // `--provider` keep the run on this entry.
  const stored = {
    version: 1,
    lastUsedProvider: CLINE_PROVIDER_ID,
    providers: {
      [CLINE_PROVIDER_ID]: {
        settings: {
          provider: CLINE_PROVIDER_ID,
          apiKey: override.apiKey,
          model,
          baseUrl: override.baseUrl,
        },
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      },
    },
  };
  // Where cline's own sandbox relocation resolves the settings path
  // (<data>/settings/providers.json, configureSandboxEnvironment).
  mkdirSync(join(dir, "settings"), { mode: 0o700 });
  const path = join(dir, "settings", "providers.json");
  writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    rmSync(dir, { recursive: true, force: true });
    process.off("exit", finalize);
  };
  process.once("exit", finalize);

  return { path: dir, finalize };
}
