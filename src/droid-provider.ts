/**
 * The per-run settings file behind droid's provider override.
 *
 * Droid has no environment variables for a custom provider; BYOK models are
 * `customModels` entries in settings.json (docs.factory.ai
 * /model-independence/byok: `model`, `baseUrl` and `provider` are required,
 * and `apiKey` expands `${VAR_NAME}` references from the environment). The
 * CLI's root-level `--settings <path>` — "Path to runtime settings file
 * merged for this process only" (0.221.0 `--help`) — is the per-run delivery
 * channel: codemux writes its own file carrying one `customModels` entry and
 * the session's default `model`, and points the flag at it. The key never
 * touches disk, argv, or an operator file: the file records only the name
 * `CODEMUX_DROID_PROVIDER_API_KEY`, and the value rides the environment
 * codemux itself provides, which is also what lets the override survive
 * `--hermetic` should droid ever gain that mode.
 *
 * The provider type is `generic-chat-completion-api`, the documented value
 * for "most open-source providers" speaking the OpenAI Chat Completions API
 * — the dialect the Z.AI-style endpoints the override targets use. The
 * entry sets `noImageSupport`, because an unknown endpoint's image support
 * is unverified, not because the model lacks it.
 *
 * The file lives under the real brand home in `.codemux/`, a directory no
 * droid discovery scans (skills come from `~/.factory/skills`, hooks and
 * custom droids from named files under `~/.factory`) and one scode keeps
 * reachable as harness state; never under the temp root, whose Linux
 * sandbox mount would hide it. It is removed at exit and swept once its
 * owning codemux process is gone.
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

export interface DroidProviderSettings {
  /** The value for `--settings`: the file droid merges in. */
  path: string;
  /** Removes the file and its directory. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "provider-";

/**
 * The environment name the file's `${VAR_NAME}` apiKey references. The
 * adapter provides the value itself; the file records only the name.
 */
export const DROID_PROVIDER_KEY_ENV = "CODEMUX_DROID_PROVIDER_API_KEY";

/**
 * The selector id `-m` and the session's default `model` key use for the
 * entry. Droid selects a custom model by its `id` field, not its `model`
 * name — the operator's own entries resolve the same way (a session
 * running one records `custom:CC:…` as its model, and a `-m` naming only
 * the API model id falls through to Factory inference and fails
 * authentication). The `custom:` prefix is the observed shape; the middle
 * tag and trailing index are ours.
 */
export function droidProviderModelId(model: string): string {
  return `custom:codemux:${model}-0`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler leaves the file behind; it is
// swept only once older than any run could still be reading it.
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
 * Writes the provider settings. `brandHome` is the real droid brand home
 * (the directory holding `.factory`'s contents: `~/.factory`); `model` is
 * the model id the entry routes, already validated.
 */
export function writeDroidProviderSettings(
  brandHome: string,
  override: ProviderOverride & { baseUrl: string; apiKey: string },
  model: string
): DroidProviderSettings {
  const parent = join(brandHome, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the brand home could have replaced the parent
  // with a symlink, pointing the sweep's rm elsewhere.
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
  const dir = join(parent, `${DIR_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  const settings = {
    // The session's default model, so subagents and any path that ignores
    // `-m` still land on the override rather than a Factory catalog id.
    model: droidProviderModelId(model),
    customModels: [
      {
        model,
        id: droidProviderModelId(model),
        index: 0,
        displayName: "codemux provider override",
        baseUrl: override.baseUrl,
        apiKey: `\${${DROID_PROVIDER_KEY_ENV}}`,
        // The documented provider for OpenAI Chat Completions-compatible
        // endpoints other than OpenAI's own API.
        provider: "generic-chat-completion-api",
        noImageSupport: true,
      },
    ],
  };
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    rmSync(dir, { recursive: true, force: true });
    process.off("exit", finalize);
  };
  process.once("exit", finalize);

  return { path, finalize };
}
