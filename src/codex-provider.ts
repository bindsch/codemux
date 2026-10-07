/**
 * The per-run CODEX_HOME behind codex's provider override.
 *
 * Codex reaches a custom provider only through `model_providers.<id>` in
 * `config.toml` (there are no provider environment variables), so the
 * override gets a private per-run CODEX_HOME holding exactly one
 * config.toml: a `codemux` provider entry with the override's base URL, an
 * `env_key` naming CODEMUX_CODEX_PROVIDER_API_KEY — the key itself rides
 * the environment codemux provides, never disk and never argv — the
 * selected `model`, and `model_provider = "codemux"` pointing at the entry.
 *
 * `wire_api = "responses"` is written unconditionally and is the only value
 * any release Codemux supports reads: the WireApi enum has held exactly
 * `responses` from 0.130 through 0.160, 0.160.1 rejects `wire_api = "chat"`
 * outright ("no longer supported ... set wire_api = \"responses\""), and the
 * config reference says responses "is the only supported value, and it is
 * the default when omitted". The target endpoint must therefore serve the
 * OpenAI Responses API (`/v1/responses`), not just chat completions
 * (docs/HARNESS-COMPATIBILITY.md).
 *
 * The private home means the operator's config.toml is not read on an
 * override run, by construction: provider selection and auth must be
 * unambiguous, and an operator table could redefine `model_provider` or
 * `model` — the same silence a hermetic run gets, on every override run.
 * Its MCP servers, notify hooks and profiles do not load either; that is
 * the documented cost (README). The operator's auth.json is never linked
 * into the home: the provider key is the credential, so the account login
 * stays out of a run that does not use it.
 *
 * One codex-specific variable shapes the config this module writes:
 * `CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off` adds
 * `features.multi_agent = false`, removing the grouped `namespace` tool
 * (`multi_agent_v1`) codex's subagent feature otherwise puts in every
 * Responses request — an endpoint whose Responses API does not implement
 * OpenAI's namespace tool grouping (vLLM 0.12's validator, for one)
 * rejects that tool with a 400, so this is what lets such an endpoint
 * serve codex at all. The trade is semantic: the run cannot spawn codex
 * subagents (`on` writes nothing — codex's own default — and any value
 * but on/off is refused). Like a token cap, the knob rides the override's
 * config.toml and fails loudly when set without an override.
 *
 * A plain run's home lives in `.codemux-provider/` inside the real
 * CODEX_HOME — harness state, which scode keeps writable on every platform
 * and never shadows — as a `run-<pid>-<random>` directory that
 * prepareRunDirParent sweeps by the same age-gated rule as the hermetic
 * homes: only once its owning process is gone AND it is older than a run
 * could last (two days), so a codemux that crashes mid-run leaves the
 * directory — endpoint URL and env_key name, never the key — on disk for
 * up to that long. A hermetic run writes the same config.toml into its
 * existing private home (hermetic-home.ts), which finalize already removes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTrustedDirectory, prepareRunDirParent } from "./hermetic-home.js";

import type { ProviderOverride } from "./provider-override.js";

export interface CodexProviderHome {
  /** The private CODEX_HOME holding this run's config.toml (a plain run). */
  codexHome: string;
  /** Removes the home. Only a plain run owns one; a hermetic run writes its
   * config into the hermetic home (`writeCodexProviderConfigInto`), which
   * the hermetic finalize removes, and never builds this object. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux-provider";

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
  throw new Error(
    `${CODEX_MULTI_AGENT_ENV} must be "on" or "off": "off" writes ` +
      "features.multi_agent = false into the override's config.toml, and " +
      '"on" leaves codex\'s own default in force'
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
    // The only value every supported release accepts (see module header);
    // written explicitly so the intent, and the Responses-API requirement,
    // is visible in the file itself.
    'wire_api = "responses"'
  );
  return `${lines.join("\n")}\n`;
}

/** Writes config.toml into an existing private home (the hermetic case). */
export function writeCodexProviderConfigInto(
  codexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null
): void {
  writeFileSync(
    join(codexHome, "config.toml"),
    codexProviderToml(override, model, override.maxContextTokens, multiAgent),
    { mode: 0o600 }
  );
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
  multiAgent: boolean | null
): CodexProviderHome {
  const parent = prepareRunDirParent(realCodexHome, PARENT_DIR_NAME);
  const codexHome = mkdtempSync(join(parent, `run-${process.pid}-`));
  try {
    writeCodexProviderConfigInto(codexHome, override, model, multiAgent);
  } catch (error) {
    // A run that never launches leaves nothing behind: the directory made a
    // moment ago is removed before the failure reaches the caller.
    rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    process.off("exit", finalize);
    // The same revalidation the codex adapter applies to its scratch
    // directory: a run with write access to ~/.codex could have replaced
    // `.codemux-provider` with a symlink after prepareRun made it, and a
    // recursive removal resolves that component like any path operation
    // would — into a directory codemux never chose. rm does not follow a
    // link at the run directory's own name, so the parent is the component
    // to check; a parent that fails keeps its directory, and says so.
    try {
      assertTrustedDirectory(parent);
    } catch (error) {
      console.error(
        "codemux: refusing to remove codex's provider-override home: " +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    rmSync(codexHome, { recursive: true, force: true });
  };
  process.once("exit", finalize);

  return { codexHome, finalize };
}
