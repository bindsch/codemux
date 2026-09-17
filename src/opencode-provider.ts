/**
 * The per-run config file behind opencode's provider override.
 *
 * OpenCode has no environment variables for a custom provider; it reads them
 * from config layers. `OPENCODE_CONFIG` names a config file merged between
 * the global and project layers (opencode.ai/docs/config, precedence order),
 * so codemux writes its own file — a provider on `@ai-sdk/openai-compatible`
 * with the override's base URL, a declared model, and an `apiKey` of
 * `{env:…}` referencing a name the adapter itself provides — and points
 * `OPENCODE_CONFIG` at it. The key never touches disk, argv, or an operator
 * file: it rides the environment codemux provides, which is also what lets
 * the override survive `--hermetic` (there the env prefix carries the file's
 * path instead of the empty neutralizer, and nothing else changes).
 *
 * The file lives under the real OpenCode data directory in `.codemux/`, a
 * directory no OpenCode discovery scans (config comes from the XDG config
 * home, project directories, and the env passthroughs the hermetic run
 * neutralizes) and one scode keeps reachable as harness state; never under
 * the temp root, whose Linux sandbox mount would hide it. It is removed at
 * exit and swept once its owning codemux process is gone.
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

export interface OpencodeProviderConfig {
  /** The value for `OPENCODE_CONFIG`: the file OpenCode merges in. */
  path: string;
  /** Removes the file and its directory. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "provider-";

/**
 * The environment name the file's `{env:…}` apiKey references. The adapter
 * provides the value itself; the file records only the name.
 */
export const OPENCODE_PROVIDER_KEY_ENV = "CODEMUX_OPENCODE_PROVIDER_API_KEY";

/** The provider id the config declares; models select as `<id>/<model>`. */
export const OPENCODE_PROVIDER_ID = "codemux";

/** The `--model` value an override serves: the config's provider id plus model. */
export function opencodeProviderModel(model: string): string {
  return model.startsWith(`${OPENCODE_PROVIDER_ID}/`)
    ? model
    : `${OPENCODE_PROVIDER_ID}/${model}`;
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
 * Writes the provider config. `dataDir` is the real OpenCode data directory
 * (`<XDG data parent>/opencode`); `model` is the bare model id the provider
 * serves, already validated.
 */
export function writeOpencodeProviderConfig(
  dataDir: string,
  override: ProviderOverride & { baseUrl: string; apiKey: string },
  model: string
): OpencodeProviderConfig {
  const parent = join(dataDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the data directory could have replaced the
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
  sweepStaleDirectories(parent);
  const dir = join(parent, `${DIR_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "codemux provider override",
        options: {
          baseURL: override.baseUrl,
          apiKey: `{env:${OPENCODE_PROVIDER_KEY_ENV}}`,
        },
        models: {
          [model]: { name: model },
        },
      },
    },
    model: opencodeProviderModel(model),
  };
  const path = join(dir, "opencode.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

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
