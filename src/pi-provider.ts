/**
 * The per-run agent directory behind pi's provider override.
 *
 * Pi reads custom providers only from `models.json` inside its agent
 * directory (`~/.pi/agent`; `getAgentDir`, config.js at 0.85.1), and
 * `PI_CODING_AGENT_DIR` is the only knob that relocates that directory —
 * the command line has no models-file path. The override therefore writes
 * a private agent directory holding a single-provider `models.json`:
 * `baseUrl` from the override, `apiKey` as a `${VAR}` reference — pi
 * expands `$VAR`/`${VAR}` templates from the environment at auth time
 * (`resolve-config-value.js`) — `api: "openai-completions"`, and one
 * model entry carrying the override's model id. The key never touches
 * disk, argv, or an operator file: the file records only the name
 * `CODEMUX_PI_PROVIDER_API_KEY`, and the value rides the environment
 * codemux itself provides, which is also what lets the override survive
 * `--hermetic` should pi ever gain that mode.
 *
 * The private directory replaces pi's agent directory for the run: the
 * operator's `settings.json` (extension sources), stored `auth.json`
 * logins, prompts, themes, tools and sessions do not load — the run
 * authenticates with the override's key alone and `--no-session` (every
 * headless codemux run) keeps session state out of it.
 *
 * The directory lives under the real agent directory in `.codemux/`, a
 * location no pi discovery scans (extensions, skills, prompts and themes
 * load from named siblings under the agent directory, never from
 * `.codemux`), and one scode keeps reachable as harness state; never
 * under the temp root, whose Linux sandbox mount would hide it. It is
 * removed at exit and swept once its owning codemux process is gone.
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

export interface PiProviderAgentDir {
  /** The value for `PI_CODING_AGENT_DIR`: pi's agent directory for the run. */
  path: string;
  /** Removes the directory and its parent-owned siblings. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "provider-";

/**
 * The environment name the `models.json` `${VAR}` apiKey reference
 * resolves. The adapter provides the value itself; the file records only
 * the name.
 */
export const PI_PROVIDER_KEY_ENV = "CODEMUX_PI_PROVIDER_API_KEY";

/** The environment variable pi reads its agent directory from. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** The `models.json` provider id the override registers under. */
export const PI_PROVIDER_ID = "codemux";

/** The `--model` value that selects the override's provider-qualified model. */
export function piProviderModelSelector(model: string): string {
  return `${PI_PROVIDER_ID}/${model}`;
}

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
 * Writes the private agent directory. `realAgentDir` is the agent
 * directory a plain run reads (`~/.pi/agent`); `model` is the model id
 * the provider entry routes, already validated.
 */
export function writePiProviderAgentDir(
  realAgentDir: string,
  override: ProviderOverride & { baseUrl: string; apiKey: string },
  model: string
): PiProviderAgentDir {
  const parent = join(realAgentDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the agent directory could have replaced
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
  const dir = join(parent, `${DIR_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  // The model entry stays minimal on purpose: capabilities such as the
  // thinking format or the context window are the provider's to know, and
  // pinning one provider's shape would silently misdescribe another
  // endpoint's models. Only what pi needs to route and stream is set.
  const models = {
    providers: {
      [PI_PROVIDER_ID]: {
        name: "codemux provider override",
        baseUrl: override.baseUrl,
        apiKey: `\${${PI_PROVIDER_KEY_ENV}}`,
        api: "openai-completions",
        models: [
          {
            id: model,
            name: model,
            api: "openai-completions",
          },
        ],
      },
    },
  };
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify(models, null, 2) + "\n", { mode: 0o600 });

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
