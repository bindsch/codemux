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
 * removed at exit and swept once it is stale (two days) and its owning
 * codemux process is gone.
 */

import { randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pidProbeAlive } from "./process-table.js";
import type { ProviderOverride } from "./provider-override.js";
import { recordTrustedParent, removeUnderTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { UsageRefusalError } from "./validation.js";

export interface PiProviderAgentDir {
  /** The value for `PI_CODING_AGENT_DIR`: pi's agent directory for the run. */
  path: string;
  /** Removes this run's own directory; other runs' siblings are swept
   *  separately, once stale and their owning process is gone. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "provider-";
const HERMETIC_PREFIX = "hermetic-";

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

/**
 * The model id as `models.json` carries it, verbatim or not at all: pi
 * expands `$VAR`/`${VAR}` templates in models.json from the environment
 * at auth time (the same expansion the `${…}` key reference rides), and
 * the model lands in the file verbatim — in the entry's `id` and `name`
 * — so a model carrying a `$` or a brace could splice an environment
 * variable's value into the config codemux writes (h6 review; round 259
 * added the bare `$VAR` form; the base URL refuses braces for the same
 * reason).
 */
export function piProviderBareModel(model: string): string {
  if (model.includes("$") || model.includes("{") || model.includes("}")) {
    throw new UsageRefusalError(
      "the pi provider override model must not contain '$', '{', or '}': pi expands $VAR/${VAR} templates inside models.json, so one of them could splice another value into it"
    );
  }
  return model;
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
    const match = /^(?:provider|hermetic)-(\d+)-/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pidProbeAlive(pid)) continue;
    const path = join(parent, entry);
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (age < STALE_DIR_MS) continue;
    // One bad entry must not block the run, or every later run: the entry
    // stays, the sweep moves on, and the operator learns why (an entry the
    // sweep cannot remove is never cleaned up by retrying it either).
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.error(`pi: could not remove the stale agent directory ${path}${detail}`);
    }
  }
}

/**
 * The `models.json` content a private agent directory carries for an
 * override run. The model entry stays minimal on purpose: capabilities
 * such as the thinking format or the context window are the provider's to
 * know, and pinning one provider's shape would silently misdescribe
 * another endpoint's models. Only what pi needs to route and stream is
 * set, with one exception: `reasoning: true`, because pi 0.85.1 defaults
 * a custom model's reasoning to false, and that default clamps the
 * `--thinking` flag --effort maps to (0.85.1's model composer answered
 * {"reasoning":false,"requested":"high","effective":"off"} for the bare
 * entry), so an override run with --effort high would silently disable
 * reasoning (h4 review).
 */
export function piProviderModelsJson(
  override: ProviderOverride & { baseUrl: string; apiKey: string },
  bareModel: string
): string {
  const models = {
    providers: {
      [PI_PROVIDER_ID]: {
        name: "codemux provider override",
        baseUrl: override.baseUrl,
        apiKey: `\${${PI_PROVIDER_KEY_ENV}}`,
        api: "openai-completions",
        models: [
          {
            id: bareModel,
            name: bareModel,
            api: "openai-completions",
            reasoning: true,
            // The caps, when the override carries them: maxTokens is the
            // reply budget pi requests and contextWindow the window it
            // truncates to (both first-class models.json fields). The
            // conditional spreads keep an uncapped override's file
            // byte-identical to the pre-caps shape.
            ...(override.maxOutputTokens !== undefined
              ? { maxTokens: override.maxOutputTokens }
              : {}),
            ...(override.maxContextTokens !== undefined
              ? { contextWindow: override.maxContextTokens }
              : {}),
          },
        ],
      },
    },
  };
  return JSON.stringify(models, null, 2) + "\n";
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
  const bareModel = piProviderBareModel(model);
  const parent = join(realAgentDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the agent directory could have replaced
  // the parent with a symlink, pointing the sweep's rm elsewhere; the
  // record also lets the finalizer revalidate the parent
  // (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  sweepStaleDirectories(parent);
  const dir = join(parent, `${DIR_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  // Guarded from the directory's creation to its finalizer's registration
  // (review round 123): a write that fails here removes the just-made
  // directory through the same revalidated removal the finalizer uses, and
  // the original error reaches the caller instead of a private directory
  // the days-later stale sweep has to reclaim.
  // Created outside the guard: a mkdir that fails made nothing, and what
  // already sits at the name is not this run's to remove (review round 124).
  mkdirSync(dir, { mode: 0o700 });
  try {
    const path = join(dir, "models.json");
    writeFileSync(path, piProviderModelsJson(override, bareModel), { mode: 0o600 });
  } catch (error) {
    removeUnderTrustedParent(dir, parentRecord, `the pi agent directory ${dir}`);
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // Thrown when refused or failed, so the run's cleanup reports the kept
    // directory; it stays retryable, and the exit hook retries and reports
    // (review round 97).
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the pi agent directory ${dir}`);
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);

  return { path: dir, finalize };
}

/**
 * The private agent directory a `--hermetic` pi run reads (the same
 * relocation `PI_CODING_AGENT_DIR` already performs for an override). The
 * directory starts empty and stays near-empty, so nothing the operator
 * placed in the real agent directory loads: no global SYSTEM.md or
 * APPEND_SYSTEM.md (`discoverSystemPromptFile` falls back to
 * `<agentDir>/SYSTEM.md` only when the project copy is absent, and the
 * private dir has neither), no settings.json extension sources, no
 * prompts, themes, skills or stored sessions (pi 0.85.1
 * chunk-JVUZSMYM.js, read 2026-11-09). With an override, the same
 * models.json the non-hermetic override run writes rides along; without
 * one, the run's login is the operator's `auth.json`, shared by HARD LINK
 * for the same reason codex's is (pi rewrites the file in place with
 * `writeFileSync`, never a rename, so a rotation through the link updates
 * the shared inode). A missing auth.json links nothing: the run then
 * authenticates with a provider key from the environment or fails pi's
 * own login check, which is the operator's to fix.
 *
 * The run additionally passes `--no-context-files` (the adapter) so the
 * cwd and its ancestors contribute no AGENTS.md/CLAUDE.md, and every
 * headless run already passes `--no-approve`, which at 0.85.1 means the
 * project is untrusted: `<cwd>/.pi/SYSTEM.md` and every other
 * project-local file pi gates on trust stays out.
 */
export function createPiHermeticAgentDir(
  realAgentDir: string,
  override: (ProviderOverride & { baseUrl: string; apiKey: string }) | null,
  model: string | undefined,
  copyLogin = true
): PiProviderAgentDir {
  const parent = join(realAgentDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentRecord = recordTrustedParent(parent);
  sweepStaleDirectories(parent);
  const dir = join(parent, `${HERMETIC_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  try {
    if (override !== null && model !== undefined) {
      writeFileSync(
        join(dir, "models.json"),
        piProviderModelsJson(override, piProviderBareModel(model)),
        { mode: 0o600 }
      );
    } else if (copyLogin) {
      // No override: the operator's own login is the only credential the
      // run may use. A symlink login file is refused rather than followed
      // (the codex rule): a swapped link is an attack on the run, not a
      // channel it should honor.
      const sourceAuth = join(realAgentDir, "auth.json");
      let stat;
      try {
        stat = lstatSync(sourceAuth);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stat !== undefined) {
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`pi hermetic runs need a file login: ${sourceAuth} is not a regular file`);
        }
        try {
          linkSync(sourceAuth, join(dir, "auth.json"));
        } catch {
          // A filesystem without hard links: a symlink still lets pi's
          // in-place rewrite reach the real file.
          symlinkSync(sourceAuth, join(dir, "auth.json"));
        }
      }
    }
  } catch (error) {
    removeUnderTrustedParent(dir, parentRecord, `the pi agent directory ${dir}`);
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the pi agent directory ${dir}`);
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);

  return { path: dir, finalize };
}
