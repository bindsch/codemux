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
 * sandbox mount would hide it. It is removed at exit and swept once it is
 * stale (two days) and its owning codemux process is gone.
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pidProbeAlive } from "./process-table.js";
import { recordTrustedParent, removeUnderTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import type { ProviderOverride } from "./provider-override.js";
import type { ReasoningEffort } from "./types.js";
import { UsageRefusalError } from "./validation.js";

export interface DroidProviderSettings {
  /** The value for `--settings`: the file droid merges in. */
  path: string;
  /** Removes the file and its directory. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const DIR_PREFIX = "provider-";
const TUI_DIR_PREFIX = "tui-";

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
 *
 * Braces are refused: droid expands `${VAR}` templates in this settings
 * file at read time (the base URL refuses them for the same reason), and
 * the model lands in the file verbatim — in the `model` and `id` fields —
 * so a model carrying them could splice an environment variable's value
 * into the config codemux writes (h6 review).
 */
export function droidProviderModelId(model: string): string {
  if (model.includes("{") || model.includes("}")) {
    throw new UsageRefusalError(
      "the droid provider override model must not contain '{' or '}': droid expands ${VAR} templates inside the settings file, so a brace could splice another value into it"
    );
  }
  return `custom:codemux:${model}-0`;
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
    const match = /^(?:provider|tui)-(\d+)-/.exec(entry);
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
      console.error(`droid: could not remove the stale provider settings directory ${path}${detail}`);
    }
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
  model: string,
  printOnly = false
): DroidProviderSettings {
  // Refused before anything is created: an unusable model leaves no
  // directory behind for the sweep to find.
  const entryId = droidProviderModelId(model);
  if (printOnly) return { path: join(brandHome, PARENT_DIR_NAME, "preview", "settings.json"), finalize: () => {} };
  return writeDroidSettingsFile(brandHome, DIR_PREFIX, "provider", () => ({
    // The session's default model, so subagents and any path that ignores
    // `-m` still land on the override rather than a Factory catalog id.
    model: entryId,
    customModels: [
      {
        model,
        id: entryId,
        index: 0,
        displayName: "codemux provider override",
        baseUrl: override.baseUrl,
        apiKey: `\${${DROID_PROVIDER_KEY_ENV}}`,
        // The documented provider for OpenAI Chat Completions-compatible
        // endpoints other than OpenAI's own API.
        provider: "generic-chat-completion-api",
        noImageSupport: true,
        // The reply budget droid's model selection honors (docs.factory.ai
        // model-independence/byok lists maxOutputTokens among the BYOK
        // fields); the conditional spread keeps an uncapped override's file
        // byte-identical to the pre-caps shape. There is no context-window
        // BYOK field — the adapter refuses that cap instead of dropping it.
        ...(override.maxOutputTokens !== undefined
          ? { maxOutputTokens: override.maxOutputTokens }
          : {}),
      },
    ],
  }));
}

/** The reasoning-effort value the settings file carries: the ThinkingEffort
 * enum's own spelling, with codemux's `none` on droid's `off` (the exec
 * flag's mapping, src/adapters/droid.ts). */
export function droidSettingsEffort(level: ReasoningEffort): string {
  return level === "none" ? "off" : level;
}

/** What an interactive session's settings file carries: the TUI selects
 * its model and reasoning effort through the settings schema's
 * sessionDefaultSettings object — `this.updateSettings({sessionDefault
 * Settings:{model:r}})` for a model change and the schema defaults
 * `ta={sessionDefaultSettings:{reasoningEffort:"high",autonomyMode:
 * "normal"}}` (droid 0.221.0 binary strings, read 2026-11-09); the
 * sessionDefaultSettings key sits at the FILE's root, not under a
 * "general" section (the binary's own settings-help correction). An
 * override session also carries the BYOK entry, so one file selects the
 * model, the effort, and the route. */
export interface DroidTuiSettingsSpec {
  /** The model id the session defaults to — the caller picks the
   * spelling: the BYOK entry's id under an override, the raw id
   * otherwise (a catalog model). */
  defaultModel?: string;
  /** The raw model id the BYOK entry routes; named only when an
   * override is in force. */
  model?: string;
  effort?: ReasoningEffort;
  override?: (ProviderOverride & { baseUrl: string; apiKey: string }) | null;
}

/**
 * Writes an interactive session's settings file — the TUI model, effort,
 * and (when an override is in force) the BYOK entry ride the same
 * root-level `--settings <path>` carrier the run path uses. The caller
 * validates the model first (droidProviderModelId refuses braces).
 */
export function writeDroidTuiSettings(
  brandHome: string,
  spec: DroidTuiSettingsSpec,
  printOnly = false
): DroidProviderSettings {
  const entryId = spec.model !== undefined ? droidProviderModelId(spec.model) : undefined;
  if (printOnly) return { path: join(brandHome, PARENT_DIR_NAME, "preview", "settings.json"), finalize: () => {} };
  return writeDroidSettingsFile(brandHome, TUI_DIR_PREFIX, "tui", () => ({
    sessionDefaultSettings: {
      ...(spec.defaultModel !== undefined ? { model: spec.defaultModel } : {}),
      ...(spec.effort !== undefined
        ? { reasoningEffort: droidSettingsEffort(spec.effort) }
        : {}),
    },
    ...(spec.override !== null && spec.override !== undefined && spec.model !== undefined
      ? {
        customModels: [
          {
            model: spec.model,
            id: entryId,
            index: 0,
            displayName: "codemux provider override",
            baseUrl: spec.override.baseUrl,
            apiKey: `\${${DROID_PROVIDER_KEY_ENV}}`,
            provider: "generic-chat-completion-api",
            noImageSupport: true,
            ...(spec.override.maxOutputTokens !== undefined
              ? { maxOutputTokens: spec.override.maxOutputTokens }
              : {}),
          },
        ],
      }
      : {}),
  }));
}

/** The shared lifecycle under both writers: the trusted parent, the stale
 * sweep, the guarded write, the retryable finalizer, and the exit hook
 * (the writeDroidProviderSettings rules, reviews 97/123/124). */
function writeDroidSettingsFile(
  brandHome: string,
  prefix: string,
  label: string,
  build: () => Record<string, unknown>
): DroidProviderSettings {
  const parent = join(brandHome, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the brand home could have replaced the parent
  // with a symlink, pointing the sweep's rm elsewhere; the record also lets
  // the finalizer revalidate the parent (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  sweepStaleDirectories(parent);
  const dir = join(parent, `${prefix}${process.pid}-${randomBytes(6).toString("hex")}`);
  // Guarded from the directory's creation to its finalizer's registration
  // (review round 123): a write that fails here removes the just-made
  // directory through the same revalidated removal the finalizer uses, and
  // the original error reaches the caller instead of a private directory
  // the days-later stale sweep has to reclaim.
  const path = join(dir, "settings.json");
  // Created outside the guard: a mkdir that fails made nothing, and what
  // already sits at the name is not this run's to remove (review round 124).
  mkdirSync(dir, { mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify(build(), null, 2) + "\n", { mode: 0o600 });
  } catch (error) {
    removeUnderTrustedParent(dir, parentRecord, `the droid ${label} settings directory ${dir}`);
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // Thrown when refused or failed, so the run's cleanup reports the kept
    // directory; it stays retryable, and the exit hook retries and reports
    // (review round 97).
    removeUnderTrustedParentOrThrow(dir, parentRecord, `the droid ${label} settings directory ${dir}`);
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);

  return { path, finalize };
}
