/**
 * The per-run settings file behind qwen's reasoning effort.
 *
 * Qwen has no `--effort`-style flag; the tier is a settings key:
 * `model.reasoningEffort`, read by the CLI's generation-config resolver
 * from the merged settings layers (qwen 0.24.0,
 * `resolveCliGenerationConfig`: `const rawReasoningEffort =
 * settings.model?.reasoningEffort`, "none" sets `generationConfig.reasoning
 * = false`, the tiers low/medium/high/xhigh/max become
 * `generationConfig.reasoning.effort`, an unknown string is warned about
 * and ignored — read 2026-11-09). The delivery channel codemux owns is the
 * SYSTEM settings layer: `getSystemSettingsPath()` returns
 * `process.env["QWEN_CODE_SYSTEM_SETTINGS_PATH"]` before its platform
 * default, and `mergeSettings` merges `systemDefaults, user, workspace,
 * system` — the system layer last, so it wins: a user or repository
 * settings file cannot override the tier this run asked for. Safe mode
 * does not touch the settings layers (it disables "context files, hooks,
 * extensions, skills, MCP servers"), so the file rides the `--safe-mode`
 * every codemux qwen run already carries.
 *
 * The file lives under the qwen brand home in `.codemux/` (a directory no
 * qwen settings layer reads), is removed at exit, and is swept once stale
 * and its owning codemux process is gone — the droid provider-settings
 * lifecycle (src/droid-provider.ts).
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pidProbeAlive } from "./process-table.js";
import { recordTrustedParent, removeUnderTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import type { ReasoningEffort } from "./types.js";

export interface QwenEffortSettings {
  /** The value for QWEN_CODE_SYSTEM_SETTINGS_PATH: the system layer file. */
  path: string;
  /** Removes the file and its directory. */
  finalize: () => void;
}

/** The environment name that points qwen at its system settings layer. */
export const QWEN_EFFORT_SETTINGS_ENV = "QWEN_CODE_SYSTEM_SETTINGS_PATH";

/** The tiers the settings value accepts: "none" plus the five ranked tiers
 * (qwen 0.24.0 normalizeReasoningEffort and the "none" branch; an unknown
 * value is ignored with a warning, so codemux writes exact tiers only). */
export const QWEN_EFFORT_LEVELS: readonly ReasoningEffort[] = [
  "none", "low", "medium", "high", "xhigh", "max",
];

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "effort-";

/**
 * The qwen brand home whose `.codemux/` holds the per-run file: the
 * `QWEN_HOME` redirect (resolved against the cwd exactly the way qwen's
 * own path resolver treats a relative value), else `~/.qwen`
 * (0.24.0: `SETTINGS_DIRECTORY_NAME = ".qwen"`, `getGlobalQwenDirLite`
 * reads QWEN_HOME first — read 2026-11-09).
 */
export function qwenBrandHome(environment: NodeJS.ProcessEnv): string {
  const redirected = environment.QWEN_HOME;
  if (redirected !== undefined && redirected !== "") {
    return isAbsolute(redirected) ? redirected : resolve(redirected);
  }
  return join(homedir(), ".qwen");
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
    const match = /^effort-(\d+)-/.exec(entry);
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
    // stays, the sweep moves on, and the operator learns why.
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      console.error(`qwen: could not remove the stale effort settings directory ${path}${detail}`);
    }
  }
}

/** What the per-run system settings file carries: an effort tier, a
 * context-window cap (the provider override's maxContextTokens), or
 * both. Every value rides the system layer, so user and workspace
 * settings cannot override either for this run. */
export interface QwenRunSettingsInput {
  effort?: ReasoningEffort;
  contextWindowTokens?: number;
}

/**
 * Writes the system settings file carrying the tier and/or the context
 * cap. The context cap is `model.generationConfig.contextWindowSize`:
 * `resolveCliGenerationConfig` hands `settings.model?.generationConfig`
 * to `resolveModelConfig` (chunk-WX4W3FCV.js, "generationConfig:
 * settings.model?.generationConfig", read 2026-11-09), which honors a
 * defined `contextWindowSize` and only computes one from tokenLimit when
 * it is undefined (chunk-366JNNY7.js:23482) — a number written here is
 * the number the run uses. `brandHome` is the real qwen brand home
 * (`~/.qwen` or QWEN_HOME).
 */
export function writeQwenRunSettings(
  brandHome: string,
  input: QwenRunSettingsInput
): QwenEffortSettings {
  return writeSettings(brandHome, input);
}

/**
 * Writes the system settings file carrying the tier. `brandHome` is the
 * real qwen brand home (`~/.qwen` or QWEN_HOME); `effort` is one of
 * QWEN_EFFORT_LEVELS.
 */
export function writeQwenEffortSettings(
  brandHome: string,
  effort: ReasoningEffort
): QwenEffortSettings {
  return writeSettings(brandHome, { effort });
}

function writeSettings(
  brandHome: string,
  input: QwenRunSettingsInput
): QwenEffortSettings {
  const parent = join(brandHome, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the brand home could have replaced the parent
  // with a symlink, pointing the sweep's rm elsewhere; the record also lets
  // the finalizer revalidate the parent (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  sweepStaleDirectories(parent);
  const dir = join(parent, `${DIR_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  const path = join(dir, "settings.json");
  // Created outside the guard: a mkdir that fails made nothing, and what
  // already sits at the name is not this run's to remove.
  mkdirSync(dir, { mode: 0o700 });
  const model: Record<string, unknown> = {};
  if (input.effort !== undefined) model.reasoningEffort = input.effort;
  if (input.contextWindowTokens !== undefined) {
    model.generationConfig = { contextWindowSize: input.contextWindowTokens };
  }
  try {
    writeFileSync(path, `${JSON.stringify({ model })}\n`, { mode: 0o600 });
  } catch (error) {
    removeUnderTrustedParent(dir, parentRecord, `the qwen effort settings directory ${dir}`);
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // Thrown when refused or failed, so the run's cleanup reports the kept
    // directory; it stays retryable, and the exit hook retries and reports.
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the qwen effort settings directory ${dir}`);
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);

  return { path, finalize };
}
