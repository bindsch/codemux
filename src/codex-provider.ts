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

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertTrustedDirectory, prepareRunDirParent } from "./hermetic-home.js";
import { providerIdentityBaseUrl } from "./provider-override.js";

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
  writeFileSync(temp, codexProviderToml(override, model, override.maxContextTokens, multiAgent), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    renameSync(temp, target);
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

/** The parent a session home lives under, beside the per-run homes —
 * also the directory a fresh session's final path is contained in (its id
 * names the final directory only after thread/start answers, so the
 * start-time containment check uses the parent). */
export function codexProviderSessionsParent(realCodexHome: string): string {
  return join(realCodexHome, PARENT_DIR_NAME);
}

/**
 * The CODEX_HOME a provider-override SESSION's home is keyed by: one
 * `session-home-<endpoint hash>-<session id>` directory under the same
 * `.codemux-provider/` parent. One session's threads are state in its
 * CODEX_HOME (`thread/resume` reads them back), so the home must survive
 * across that one session's turns and resumes — keyed to that one
 * session: two sessions on one endpoint (or one session id across two
 * endpoints) never share a directory (review D1, security). The key is a
 * naming rule, not an access boundary (review D5, security): the shared
 * parent is writable by every sandboxed codex child, so one session's
 * child can write into another session's home (`rules/`, `AGENTS.md`,
 * hooks); only config.toml is codemux-rewritten per launch
 * (`prepareConfig`), atomically and never through a symlink. The
 * endpoint hash keeps the two-endpoints-never-share rule
 * visible in the name; the session id (a codex thread id,
 * `[A-Za-z0-9_-]{8,128}` — codex-session.ts, no path separators) names the
 * session the directory belongs to.
 * The hash input is the base URL's IDENTITY form (query and fragment
 * stripped, providerIdentityBaseUrl — review D10): a gateway key riding
 * the query can rotate without moving the home, and the key never
 * varies with credentials — the same endpoint-identity notion the
 * registry's `provider_base_url` records.
 */
export function codexSessionProviderHomePath(
  realCodexHome: string,
  baseUrl: string,
  sessionId: string
): string {
  const identity = providerIdentityBaseUrl(baseUrl);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return join(realCodexHome, PARENT_DIR_NAME, `session-home-${hash}-${sessionId}`);
}

/** What a session's CLI holds for the home's lifetime. */
export interface CodexSessionProviderHome {
  /** The CODEX_HOME this session's turns run in: the session-keyed
   * directory for a resume, a fresh `run-<pid>-<random>` one for a new
   * session (moved onto its key by `settle` at an orderly end). */
  codexHome: string;
  /**
   * Writes this launch's config.toml into the home — atomically, never
   * through a symlink (`writeCodexProviderConfigInto`). Runs ONCE, after
   * the resume claim and before anything spawns: a second resume racing
   * past the lock-free lookup is refused `session_busy` by the claim, and
   * must not have rewritten the live session's config — model and caps
   * included — before that refusal (review D5, correctness 3). Until it
   * runs, the home holds what its last session left: nothing for a fresh
   * one, the previous config for a resumed one.
   */
  prepareConfig: () => void;
  /**
   * The end-of-session settlement, called once from the driver's end path
   * (the child has settled; nothing writes the home anymore). A resumable
   * end keeps the home as this session's resume state — moved onto the
   * session-keyed path a `--resume` computes, when the session started on
   * a fresh run-shaped one, so the registry's recorded `harness_home` and
   * the directory's real name agree before any resume can run. For a
   * fresh session any other end removes it (`sessionId` null covers a
   * session that never adopted an id): the run-path rule, nothing
   * survives a session codemux will not vouch for. A RESUMED session's
   * home is never removed at settlement (review D3, correctness-2): its
   * state predates this process — the rule `abandon` carries — so a
   * failed or interrupted resume leaves it to the sweep instead of
   * deleting the earlier turns with it. A codemux that dies before its
   * end path leaves the run-shaped name to the stale-run sweep and the
   * session-keyed one to the stale-session sweep.
   *
   * Returns whether the home ended where a resume finds it (review D2,
   * correctness-2 2): true after a successful move onto the key, false
   * when the move failed — the state sits on in the run-shaped name a
   * resume never computes, and a `--resume` would open an empty home and
   * fail inside codex with thread-not-found, so the driver folds this
   * into the reported `resumable` and refuses the caller now instead.
   */
  settle: (sessionId: string | null, resumable: boolean) => boolean;
  /**
   * The failure backstop (the spawn threw, the driver never ran): a fresh
   * session's bare home is removed — nothing of value ever ran in it —
   * while a resumed session's home is left for the sweep, because its
   * state predates this process and is not this process's to delete.
   */
  abandon: () => void;
}

/** The shared stderr shape for a settlement that could not complete: the
 * session's end verdict is already out, so the loss is reported, not
 * raised — and the sweep is what reclaims the directory. */
function warnLostHome(action: string, path: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`codemux: could not ${action} the session's provider home ${path}: ${detail}`);
}

/** Removes a home through a parent revalidated first: a run with write
 * access to `~/.codex` could have replaced the parent with a symlink
 * after the home was made, and a recursive removal resolves that
 * component like any path operation would (the run-path finalize's rule;
 * rm never follows a link at the home's own name). Returns whether the
 * home is gone. */
function removeHome(parent: string, codexHome: string): boolean {
  try {
    assertTrustedDirectory(parent);
  } catch (error) {
    warnLostHome("remove", codexHome, error);
    return false;
  }
  rmSync(codexHome, { recursive: true, force: true });
  return true;
}

/**
 * Creates a FRESH session's home: one `run-<pid>-<random>` directory
 * (the run-path shape, so a codemux that dies mid-session leaves it to
 * the same stale-run sweep), empty until `prepareConfig` writes its
 * config.toml after the claim (a session refused before its spawn
 * writes nothing). The directory is moved onto its session-keyed path
 * only at an orderly, resumable end — the id that keys it arrives at
 * thread/start, after the child is already running against this one
 * (see `settle`).
 */
export function createCodexSessionProviderHome(
  realCodexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null
): CodexSessionProviderHome {
  const parent = prepareRunDirParent(realCodexHome, PARENT_DIR_NAME);
  const codexHome = mkdtempSync(join(parent, `run-${process.pid}-`));
  const prepareConfig = (): void => {
    writeCodexProviderConfigInto(codexHome, override, model, multiAgent);
  };
  let settled = false;
  const settle = (sessionId: string | null, resumable: boolean): boolean => {
    if (settled) return false;
    settled = true;
    if (!resumable || sessionId === null) {
      return removeHome(parent, codexHome);
    }
    const target = codexSessionProviderHomePath(realCodexHome, override.baseUrl, sessionId);
    try {
      // Both components revalidated: a sandboxed child could have swapped
      // either for a symlink during the session, and rename resolves the
      // parent components while moving the name at codexHome itself.
      assertTrustedDirectory(parent);
      assertTrustedDirectory(codexHome);
      renameSync(codexHome, target);
      return true;
    } catch (error) {
      // A target that already exists (a minted-id collision — the thread
      // ids are codex's own random ids) or a swapped component keeps both
      // directories on disk: warn, and let the sweeps reclaim them. Never
      // delete a directory this process did not create. The state did NOT
      // reach the key, so the session is not resumable: false.
      warnLostHome("set aside", codexHome, error);
      return false;
    }
  };
  return {
    codexHome,
    prepareConfig,
    settle,
    abandon: (): void => {
      if (settled) return;
      settled = true;
      removeHome(parent, codexHome);
    },
  };
}

/**
 * Opens a RESUMED session's home at `codexSessionProviderHomePath` — the
 * directory the original session's end moved its threads onto — leaving
 * its config.toml untouched until `prepareConfig` rewrites it after the
 * claim (the child of the earlier process could write this directory, so
 * that write must not follow anything). The home
 * is this session's recorded state, FOUND again — never made: a missing
 * keyed home is refused outright (review D2, correctness-2 2). Creating
 * one silently would hand the resume an empty CODEX_HOME whose only end
 * is a thread-not-found failure inside codex; the earlier session either
 * never settled onto the key (its end warned) or the sweep took it, and
 * the operator needs that said here, not from inside the harness.
 */
export function openCodexSessionProviderHome(
  realCodexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null,
  sessionId: string
): CodexSessionProviderHome {
  // The parent is created (and its stale entries swept) as a side
  // effect, as at any session or run start — with THIS home's entry
  // spared: the sweep's registry consult answers `free` for an ended
  // record, and a home idle past the 28-day gate would be deleted right
  // here, after `lookupForResume` already vouched for it, leaving the
  // resume a "missing or untrusted" refusal its own setup caused
  // (review D10, correctness-2 3). Any other codemux run may still sweep
  // it; this one just refused to delete what it came to open.
  const codexHome = codexSessionProviderHomePath(realCodexHome, override.baseUrl, sessionId);
  prepareRunDirParent(realCodexHome, PARENT_DIR_NAME, undefined, basename(codexHome));
  try {
    assertTrustedDirectory(codexHome);
  } catch {
    throw new Error(
      `the recorded session home ${codexHome} is missing or untrusted; ` +
        "the session cannot be resumed (the original session's end may have failed " +
        "to settle it, or the stale-home sweep removed it)"
    );
  }
  const prepareConfig = (): void => {
    writeCodexProviderConfigInto(codexHome, override, model, multiAgent);
  };
  let settled = false;
  return {
    codexHome,
    prepareConfig,
    settle: (): boolean => {
      // Never remove a resumed home at settlement (review D3,
      // correctness-2): its state predates this process — the rule
      // `abandon` below already carries — and a resume that failed or was
      // interrupted before `thread/resume` answered only proves THIS run
      // did not complete, not that the stored state is invalid. Deleting
      // it there destroyed every earlier turn of the session; the 28-day
      // sweep reclaims a home no resume comes back for. The home never
      // moves either: it already sits at the key the next resume
      // computes, so the settlement answer is true whatever this run's
      // verdict was.
      if (settled) return false;
      settled = true;
      return true;
    },
    abandon: (): void => {
      // This process added only its config rewrite; the state underneath
      // predates it, so a failed resume leaves the home to the sweep.
      settled = true;
    },
  };
}
