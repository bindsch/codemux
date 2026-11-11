// The override's config.toml: the environment knobs that shape it, the
// TOML rendering, and the per-run private CODEX_HOME a plain override
// run holds it in. src/codex-provider.ts owns the override and re-exports
// this.

import { randomBytes } from "node:crypto";
import { runDirectoryPrefix } from "../run-directory-owner.js";
import { mkdtempSync, rmSync } from "node:fs";
import { renameIntoPlaceSync, stageExclusiveSync } from "../fs-durable.js";
import { join } from "node:path";
import { assertTrustedDirectory, prepareRunDirParent } from "../hermetic-home.js";
import {
  recordTrustedParent,
  removeUnderTrustedParent,
  removeUnderTrustedParentOrThrow,
  reportingHook,
} from "../safe-remove.js";
import { UsageRefusalError } from "../validation.js";

import type { ProviderOverride } from "../provider-override.js";

export interface CodexProviderHome {
  /** The private CODEX_HOME holding this run's config.toml (a plain run). */
  codexHome: string;
  /** Removes the home. Only a plain run owns one; a hermetic run writes its
   * config into the hermetic home (`writeCodexProviderConfigInto`), which
   * the hermetic finalize removes, and never builds this object. */
  finalize: () => void;
}

export const PARENT_DIR_NAME = ".codemux-provider";

/**
 * The environment name the config's `env_key` names. The adapter provides
 * the value itself; the file records only the name.
 */
export const CODEX_PROVIDER_KEY_ENV = "CODEMUX_CODEX_PROVIDER_API_KEY";

/** The `model_providers` id the config declares (built-ins are reserved). */
export const CODEX_PROVIDER_ID = "codemux";

/**
 * The multi-agent knob's environment name. `off` writes
 * `features.multi_agent = false` into the config; `on` and unset write
 * nothing, leaving codex's own default (on) in force.
 */
export const CODEX_MULTI_AGENT_ENV = "CODEMUX_CODEX_PROVIDER_MULTI_AGENT";

/**
 * Reads the multi-agent knob: `true` (on), `false` (off), or `null` when
 * unset. Any value but on/off is refused — the knob names one feature's
 * state, and anything else is a typo codemux would otherwise drop
 * silently while the endpoint keeps rejecting the tool it was meant to
 * remove.
 */
export function readCodexMultiAgent(
  environment: NodeJS.ProcessEnv = process.env
): boolean | null {
  const raw = environment[CODEX_MULTI_AGENT_ENV]?.trim();
  if (raw === undefined || raw === "") return null;
  if (raw === "on") return true;
  if (raw === "off") return false;
  // A caller mistake in the knob itself: refusal (64), not a crash.
  throw new UsageRefusalError(
    `${CODEX_MULTI_AGENT_ENV} must be "on" or "off": "off" writes ` +
      "features.multi_agent = false into the override's config.toml, and " +
      '"on" leaves codex\'s own default in force'
  );
}

/**
 * The environment name of the response-storage knob that does not exist.
 * Nothing writes it into the config — see assertNoCodexStoreKnob.
 */
export const CODEX_PROVIDER_STORE_ENV = "CODEMUX_CODEX_PROVIDER_STORE";

/**
 * Refuses CODEMUX_CODEX_PROVIDER_STORE outright: no supported codex
 * release has a response-storage config key to write, so there is no
 * `on`/`off` to validate. Verified against the installed binary's own
 * config documentation, not guessed: the generated config.schema.json
 * shipped in codex-cli 0.159.3 (the session floor) and the 0.160.1
 * binary's strings and upstream config reference both enumerate every
 * ModelProviderInfo and ConfigToml key, and `disable_response_storage`
 * (or any storage key) appears in none of them. The knob's goal is
 * already hardcoded behavior: codex sends `store: false` on every
 * Responses request unconditionally, and its HTTP request shape has no
 * `previous_response_id` field at all (only the experimental websocket
 * shape carries one) — so turn 2+ never relies on server-side response
 * storage, and any non-empty value, `on` included, names a key that never
 * shipped. An EMPTY or whitespace-only value counts as unset — the same
 * convention as CODEMUX_CODEX_PROVIDER_MULTI_AGENT (round al18, made
 * explicit): an empty export expresses no preference, so an operator can
 * neutralize an inherited value without unsetting the variable, and the
 * refusal stays for a knob someone actually set. Refused before the
 * spawn, on every path, so the operator learns the launch never needed
 * it.
 */
export function assertNoCodexStoreKnob(
  environment: NodeJS.ProcessEnv = process.env
): void {
  const raw = environment[CODEX_PROVIDER_STORE_ENV]?.trim();
  if (raw === undefined || raw === "") return;
  throw new UsageRefusalError(
    `${CODEX_PROVIDER_STORE_ENV} is refused: no supported Codex release has ` +
      "a response-storage config key (codex-cli 0.159.3's generated config " +
      "schema and the 0.160.1 binary both lack it, and both already send " +
      "store: false on every Responses request — the HTTP wire never carries " +
      "previous_response_id). Unset it: there is nothing to turn on or off."
  );
}

/** TOML basic string: JSON escaping is a valid TOML basic string. */
const tomlString = (value: string): string => JSON.stringify(value);

/**
 * Renders the config.toml: model selection, the provider entry, the
 * context cap when one is set, and the multi-agent opt-out when the knob
 * is off. The output-token cap is not here because no supported Codex
 * reads one (the adapter refuses it before this point).
 */
function codexProviderToml(
  override: ProviderOverride & { baseUrl: string },
  model: string,
  maxContextTokens: number | undefined,
  multiAgent: boolean | null
): string {
  const lines = [
    "# Written by codemux for one launch; removed when the run ends.",
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    `model = ${tomlString(model)}`,
  ];
  if (maxContextTokens !== undefined) {
    lines.push(`model_context_window = ${maxContextTokens}`);
  }
  if (multiAgent === false) {
    // A top-level key, so it must precede the [model_providers] table
    // below. `on` and unset write nothing: codex's own default is on, and
    // restating it would pin a value a future release could change.
    lines.push("features.multi_agent = false");
  }
  // The key sits in codex's environment under CODEX_PROVIDER_KEY_ENV so
  // `env_key` can find it; the shell tool's environment must not carry it
  // on to commands the model runs. The private home replaces whatever
  // `shell_environment_policy` the operator keeps, so the exclusion is
  // written here rather than left to codex's default name filter.
  lines.push(
    "[shell_environment_policy]",
    `exclude = [${tomlString(CODEX_PROVIDER_KEY_ENV)}]`,
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString("codemux provider override")}`,
    `base_url = ${tomlString(override.baseUrl)}`,
    `env_key = ${tomlString(CODEX_PROVIDER_KEY_ENV)}`,
    // The only value every supported release accepts (src/codex-provider.ts's
    // module header carries the WireApi evidence);
    // written explicitly so the intent, and the Responses-API requirement,
    // is visible in the file itself.
    'wire_api = "responses"'
  );
  return `${lines.join("\n")}\n`;
}

/** Writes config.toml into an existing private home (the hermetic case,
 * and every session home) — atomically, never through a symlink.
 *
 * The session homes live in a directory the sandboxed child can write
 * (`~/.codex` is harness state on every platform codemux supports), so a
 * plain `writeFileSync` follows a symlink the child planted at the
 * config.toml path and truncates whatever the link names — the write
 * escapes codemux's own directory (review D1, security). The temp file is
 * created exclusively (`wx`: O_EXCL, which refuses any existing entry, a
 * symlink included) under an unguessable random name, and `rename`
 * replaces the target name itself: a symlink at `config.toml` is
 * swapped out for the regular file, never followed. The home directory
 * itself is re-asserted HERE (review D7, security, the aider per-turn
 * check's sibling): a resumed home's open-time assertion can go stale
 * across the registry claim — which may wait out the lock budget — and
 * another session's child could have swapped the home directory for a
 * symlink in that window; this write must never land through it. */
export function writeCodexProviderConfigInto(
  codexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null
): void {
  assertTrustedDirectory(codexHome);
  const target = join(codexHome, "config.toml");
  const temp = join(codexHome, `config.toml.${randomBytes(6).toString("hex")}.tmp`);
  // Exclusive staging with the mode stated on the descriptor and an fsync
  // before the rename (fs-durable.ts, review round 401, items 1 and 6).
  stageExclusiveSync(temp, codexProviderToml(override, model, override.maxContextTokens, multiAgent), 0o600);
  try {
    renameIntoPlaceSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Creates the private CODEX_HOME a plain override run owns: one
 * `run-<pid>-<random>` directory under `.codemux-provider/` in the real
 * CODEX_HOME (prepareRunDirParent makes, checks, and sweeps the parent),
 * holding the config.toml, removed at exit and by cleanupRun.
 */
export function writeCodexProviderConfig(
  realCodexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null,
  printOnly = false
): CodexProviderHome {
  if (printOnly) return { codexHome: join(realCodexHome, PARENT_DIR_NAME, "preview"), finalize: () => {} };
  const parent = prepareRunDirParent(realCodexHome, PARENT_DIR_NAME);
  // Recorded for the finalizer's revalidation (src/safe-remove.ts).
  const parentRecord = recordTrustedParent(parent);
  const codexHome = mkdtempSync(join(parent, runDirectoryPrefix()));
  try {
    writeCodexProviderConfigInto(codexHome, override, model, multiAgent);
  } catch (error) {
    // A run that never launches leaves nothing behind: the directory made a
    // moment ago is removed — under the creation-time record
    // (src/safe-remove.ts, review round 104: the removal must refuse a
    // parent that is no longer the one made, not resolve the path
    // elsewhere) — before the failure reaches the caller; the write error
    // stays the one reported.
    removeUnderTrustedParent(
      codexHome,
      parentRecord,
      `codex's provider-override home ${codexHome}`
    );
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    // The same revalidation the codex adapter applies to its scratch
    // directory: a run with write access to ~/.codex could have replaced
    // `.codemux-provider` with a symlink after prepareRun made it, and a
    // recursive removal resolves that component like any path operation
    // would — into a directory codemux never chose. rm does not follow a
    // link at the run directory's own name, so the parent is the component
    // to check; a parent that fails keeps its directory, and the throw
    // reaches the adapter's cleanup, which says so. A failed removal
    // stays retryable; the exit hook retries and reports (round 97).
    removeUnderTrustedParentOrThrow(
      codexHome,
      parentRecord,
      `codex's provider-override home ${codexHome}`
    );
    finalized = true;
    process.off("exit", atExit);
  };
  const atExit = reportingHook(finalize);
  process.once("exit", atExit);

  return { codexHome, finalize };
}
