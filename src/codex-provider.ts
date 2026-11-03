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
 * (docs/harnesses.md).
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
 *
 * A SESSION's home is keyed per session id — a naming rule, not an
 * access boundary: no two sessions run in one directory, but the homes
 * share the `.codemux-provider/` parent inside `~/.codex`, which every
 * sandboxed codex child can write (hermetic-home.ts), so one session's
 * child can plant files (`rules/`, `AGENTS.md`, hooks) in another
 * session's home and its next resume loads them — the same trust the
 * operator's real `~/.codex` always carried (review D5, security).
 * Codemux vouches for less, and says exactly what: each launch
 * rewrites its home's config.toml atomically before anything spawns
 * (`prepareConfig`, never through a symlink), so the provider endpoint,
 * model, and caps are always this launch's own. One session's home
 * survives that session's turns and resumes (its threads are state in
 * it); a fresh session's home is removed at any non-resumable end,
 * while a resumed one is never removed at settlement — its state
 * predates the resuming process (review D3) — and a codemux that dies
 * mid-session leaves it to the parent's sweeps.
 */

// The override's config and homes live in ./codex-provider/ (config.ts,
// home.ts); re-exported here so importers keep this one path.
export {
  CODEX_PROVIDER_KEY_ENV,
  CODEX_PROVIDER_ID,
  CODEX_MULTI_AGENT_ENV,
  readCodexMultiAgent,
  CODEX_PROVIDER_STORE_ENV,
  assertNoCodexStoreKnob,
  writeCodexProviderConfigInto,
  writeCodexProviderConfig,
} from "./codex-provider/config.js";
export type { CodexProviderHome } from "./codex-provider/config.js";
export {
  codexProviderSessionsParent,
  codexSessionProviderHomePath,
  createCodexSessionProviderHome,
  openCodexSessionProviderHome,
} from "./codex-provider/home.js";
export type { CodexSessionProviderHome } from "./codex-provider/home.js";
