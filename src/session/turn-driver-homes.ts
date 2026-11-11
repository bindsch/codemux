/**
 * The hermetic-session home wiring for the second wave of session agents
 * (turn-driver-core.ts): each hermetic-capable agent's session private
 * home (src/session/private-home.ts) — the parent it lives under, the
 * initial content its run path's hermetic home carries, and the env(1)
 * assignments a hermetic turn's argv wraps in — plus the plain-session
 * state root the registry records. Each recipe mirrors the agent's run
 * path (src/droid-hermetic.ts, gemini-hermetic.ts, copilot-hermetic.ts,
 * goose-hermetic.ts, pi-provider.ts) so session turns and hermetic runs
 * cannot drift.
 */

import { linkSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "../adapters/base.js";
import { loginHome } from "../harness-health.js";
import { openClineSessionHome } from "./cline-settings.js";
import { PARENT_DIR_NAME } from "../hermetic-home.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import {
  DROID_HERMETIC_ENV_ASSIGNMENTS,
  DROID_HERMETIC_ENV_OMISSIONS,
} from "../droid-hermetic.js";
import {
  PI_AGENT_DIR_ENV,
  piProviderBareModel,
  piProviderModelsJson,
} from "../pi-provider.js";
import { qwenBrandHome } from "../qwen-effort.js";
import { UsageRefusalError } from "../validation.js";
import { COPILOT_SESSION_ID_PATTERN } from "./copilot-session.js";
import { DROID_SESSION_ID_PATTERN } from "./droid-session.js";
import { GEMINI_SESSION_ID_PATTERN } from "./gemini-session.js";
import { GOOSE_SESSION_ID_PATTERN } from "./goose-session.js";
import { scopedResumePattern } from "./scoped-id.js";
import { PI_SESSION_ID_PATTERN } from "./pi-session.js";
import { openSessionPrivateHome } from "./private-home.js";
import { openOpenhandsSessionHome } from "./openhands-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { TurnAgentId } from "./turn-driver-core.js";

/** The agent's validated provider override, when one is configured —
 * the adapter's own rule (baseUrl and apiKey required), resolved once
 * per session so the home populate and the per-turn chain cannot
 * disagree. A half-configured override refuses here as a usage error
 * (exit 64) exactly as the adapter's validateRunRequest would at the
 * first turn — fail closed before any home is created. Thrown, never
 * usageError'd: this runs after a resume's claim, and only a throw
 * reaches the CLI catch that releases it. */
export function turnSessionProviderOverride(
  agent: "droid" | "pi" | "goose" | "gemini" | "qwen" | "cline"
): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
  const override = readProviderOverride(agent, process.env);
  if (override === null) return null;
  return requireProviderOverride(agent, override, [
    "baseUrl",
    "apiKey",
  ]) as ProviderOverride & { baseUrl: string; apiKey: string };
}

/**
 * The real state root a session runs against when it is not hermetic
 * (§4.5): the directory the registry records as harness_home and every
 * resume guard compares. Each arm mirrors its adapter's own resolver —
 * droid's brand home `~/.factory`, pi's agent directory (a passed-through
 * PI_CODING_AGENT_DIR honored when absolute, the adapter's rule), qwen's
 * brand home (QWEN_HOME-aware), gemini's `~/.gemini`, copilot's
 * `~/.copilot`, goose's `~/.config/goose`, cursor's `~/.cursor`. GEMINI
 *_CLI_HOME and COPILOT_HOME never route a session: their adapters refuse
 * the pass-through outright (isolation owns the variable), so there is no
 * redirect to honor.
 */
export function turnAgentStateRoot(
  agent: TurnAgentId,
  passthroughEnv: readonly string[]
): string {
  const home = loginHome(process.env);
  switch (agent) {
    case "cline": return join(home, ".cline");
    case "cursor":
      return join(home, ".cursor");
    case "droid":
      return join(home, ".factory");
    case "pi": {
      const configured = process.env[PI_AGENT_DIR_ENV];
      if (passthroughEnv.includes(PI_AGENT_DIR_ENV) && configured !== undefined) {
        return configured;
      }
      return join(home, ".pi", "agent");
    }
    case "qwen":
      return qwenBrandHome(process.env);
    case "gemini":
      return join(home, ".gemini");
    case "copilot":
      return join(home, ".copilot");
    case "goose":
      return join(home, ".config", "goose");
    case "openhands":
      return join(home, ".openhands");
  }
}

/** The login-link fallback the run paths share (src/droid-hermetic.ts):
 * a hard link keeps an in-place token rotation shared with the real
 * login; a filesystem without hard links takes a symlink, which the
 * harness's in-place rewrite reaches just as well. */
function linkLoginFile(source: string, destination: string): void {
  try {
    linkSync(source, destination);
  } catch {
    symlinkSync(source, destination);
  }
}

/** Populate a fresh droid session home: `<home>/.factory` holding the
 * hard link to the real login (src/droid-hermetic.ts). A missing login
 * links nothing — the turn then authenticates with FACTORY_API_KEY or
 * fails droid's own login check. A non-file login is refused: the run
 * path's rule ("droid hermetic runs need a file login"). */
function populateDroidSessionHome(dir: string, brandHome: string): void {
  const privateBrand = join(dir, ".factory");
  mkdirSync(privateBrand, { mode: 0o700 });
  chmodSync(privateBrand, 0o700); // stated whatever the umask is
  const source = join(brandHome, "auth.json");
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    return; // no file login: the environment's key or droid's own refusal
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`droid hermetic sessions need a file login: ${source} is not a regular file`);
  }
  linkLoginFile(source, join(privateBrand, "auth.json"));
}

/** Populate a fresh pi session home (src/pi-provider.ts,
 * createPiHermeticAgentDir): under an override, the models.json entry
 * that routes the provider; without one, the hard link to the
 * operator's auth.json. */
function populatePiSessionHome(
  dir: string,
  realAgentDir: string,
  override: (ProviderOverride & { baseUrl: string; apiKey: string }) | null,
  model: string | undefined
): void {
  if (override !== null && model !== undefined) {
    writeFileSync(
      join(dir, "models.json"),
      piProviderModelsJson(override, piProviderBareModel(model)),
      { mode: 0o600 }
    );
    return;
  }
  const source = join(realAgentDir, "auth.json");
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    return; // no file login: the environment's key or pi's own refusal
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`pi hermetic sessions need a file login: ${source} is not a regular file`);
  }
  linkLoginFile(source, join(dir, "auth.json"));
}

/** The gemini login files a hermetic home relinks (src/gemini-hermetic.ts,
 * GEMINI_LOGIN_FILES — not exported there; the same two names, quoted
 * from the bundle's SENSITIVE_SETTINGS_FILENAMES). */
const GEMINI_SESSION_LOGIN_FILES = ["oauth_creds.json", "google_accounts.json"] as const;

/** Populate a fresh gemini session home: `<home>/.gemini` holding the
 * login links (skipped under an API-key override, the run path's
 * apiKeyAuth rule). */
function populateGeminiSessionHome(
  dir: string,
  realGeminiDir: string,
  overrideActive: boolean
): void {
  const geminiDir = join(dir, ".gemini");
  mkdirSync(geminiDir, { mode: 0o700 });
  chmodSync(geminiDir, 0o700); // stated whatever the umask is
  if (overrideActive) return;
  for (const name of GEMINI_SESSION_LOGIN_FILES) {
    const source = join(realGeminiDir, name);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    linkLoginFile(source, join(geminiDir, name));
  }
}

/** Populate a fresh copilot session home: the hard link to the real
 * config.json at the home root (src/copilot-hermetic.ts). A missing file
 * is not a failure — an env-token login needs none. */
function populateCopilotSessionHome(dir: string, realConfigDir: string): void {
  const source = join(realConfigDir, "config.json");
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    return;
  }
  if (stat.isFile()) linkLoginFile(source, join(dir, "config.json"));
}

/** Everything the home open needs. */
export interface TurnAgentPrivateHomeInput {
  agent: TurnAgentId;
  hermetic: boolean;
  /** The resumed session id, or null fresh. */
  resumeSessionId: string | null;
  /** The codemux-minted id (the minted identities) — also the resumed
   * id on a resume; null while a deferred identity (droid, goose) waits
   * for the first turn's output. */
  sessionId: string | null;
  passthroughEnv: readonly string[];
  /** The validated provider override (droid, pi, goose, qwen), or null. */
  override: (ProviderOverride & { baseUrl: string; apiKey: string }) | null;
  /** The session's resolved --model, when one applies. */
  model: string | undefined;
  /** The command's --permission-policy (openhands plants its native
   * deny rule in the home); absent means default. */
  permissionPolicy?: "default" | "deny";
}

/**
 * Opens the hermetic session's private home — or answers null where the
 * agent keeps none: cursor (not hermetic-capable; the CLI refuses
 * --hermetic before this runs, and the null keeps the contract honest)
 * and qwen (safe mode is the whole hermetic claim; there is no
 * session-keyed state to relocate — the opencode rule). Every other
 * agent opens under its real state root's `.codemux-hermetic`, with the
 * run path's content and the resume pattern of its session module.
 */
export function openTurnAgentPrivateHome(
  input: TurnAgentPrivateHomeInput
): SessionPrivateHome | null {
  if (!input.hermetic) return null;
  const stateRoot = turnAgentStateRoot(input.agent, input.passthroughEnv);
  const resume = input.resumeSessionId !== null;
  // The deferred identities (droid, goose) name no id at spawn: the home
  // starts run-shaped and settles at the adopt. Everyone else knows the
  // id at spawn and creates the settled name at once.
  const knownId = input.sessionId;
  switch (input.agent) {
    case "cline": return openClineSessionHome(stateRoot, input.resumeSessionId ?? undefined);
    case "openhands":
      // The run path's empty private HOME, held for the session
      // (src/session/openhands-home.ts); the deferred identity settles
      // it at the adopt, like droid and goose.
      return openOpenhandsSessionHome({
        stateRoot,
        resume,
        sessionId: knownId,
        permissionPolicy: input.permissionPolicy ?? "default",
      });
    case "cursor":
      return null;
    case "qwen":
      return null;
    case "droid":
      return openSessionPrivateHome({
        parent: join(stateRoot, PARENT_DIR_NAME),
        sessionId: knownId ?? undefined,
        resume,
        idPattern: DROID_SESSION_ID_PATTERN,
        blockedPaths: [],
        populate: (dir) => populateDroidSessionHome(dir, stateRoot),
      });
    case "pi": {
      if (input.override !== null && input.model === undefined) {
        throw new UsageRefusalError(
          "pi needs a model for the provider override; pass --model or set CODEMUX_PI_PROVIDER_MODEL"
        );
      }
      return openSessionPrivateHome({
        parent: join(stateRoot, PARENT_DIR_NAME),
        sessionId: knownId ?? undefined,
        resume,
        idPattern: PI_SESSION_ID_PATTERN,
        blockedPaths: [],
        populate: (dir) => populatePiSessionHome(dir, stateRoot, input.override, input.model),
      });
    }
    case "gemini":
      return openSessionPrivateHome({
        parent: join(stateRoot, PARENT_DIR_NAME),
        sessionId: knownId ?? undefined,
        resume,
        idPattern: GEMINI_SESSION_ID_PATTERN,
        blockedPaths: [],
        populate: (dir) =>
          populateGeminiSessionHome(dir, stateRoot, input.override !== null),
      });
    case "copilot":
      return openSessionPrivateHome({
        parent: join(stateRoot, PARENT_DIR_NAME),
        sessionId: knownId ?? undefined,
        resume,
        idPattern: COPILOT_SESSION_ID_PATTERN,
        blockedPaths: [],
        populate: (dir) => populateCopilotSessionHome(dir, stateRoot),
      });
    case "goose": {
      // The run path's refusal (adapters/goose.ts): nothing can ride
      // into an empty private home, so the override is the provider.
      if (input.override === null) {
        throw new UsageRefusalError(
          "goose --hermetic requires the provider override: its config file carries the operator's system prompt, so no configuration can ride into the private home (set CODEMUX_GOOSE_PROVIDER_BASE_URL and CODEMUX_GOOSE_PROVIDER_API_KEY)"
        );
      }
      return openSessionPrivateHome({
        parent: join(stateRoot, PARENT_DIR_NAME),
        sessionId: knownId ?? undefined,
        resume,
        idPattern: scopedResumePattern("goose", GOOSE_SESSION_ID_PATTERN),
        blockedPaths: [],
        // An empty home: the provider comes from the override's
        // environment, never a copied config (src/goose-hermetic.ts).
        populate: undefined,
      });
    }
  }
}

/** The env(1) middle a hermetic droid session turn wraps its command in
 * (the run path's shape, adapters/droid.ts buildRunCommand):
 * FACTORY_HOME_OVERRIDE unset, self-update off, HOME at the session
 * home. */
export function droidSessionHermeticAssignments(home: string): string[] {
  return [
    ...DROID_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
    ...DROID_HERMETIC_ENV_ASSIGNMENTS,
    `HOME=${home}`,
  ];
}

/** The env(1) middle a hermetic pi session turn wraps its command in
 * (pi-session.ts's hermeticEnvAssignments contract): the agent-directory
 * relocation at the session home. */
export function piSessionHermeticAssignments(home: string): string[] {
  return [`${PI_AGENT_DIR_ENV}=${home}`];
}

/** The env(1) middle a hermetic goose session turn wraps its command in
 * (src/goose-hermetic.ts): GOOSE_PATH_ROOT moves every goose directory
 * under the session home; the XDG trio stays for the libraries that
 * read it directly. */
export function gooseSessionHermeticAssignments(home: string): string[] {
  return [
    `GOOSE_PATH_ROOT=${home}`,
    `XDG_CONFIG_HOME=${join(home, "config")}`,
    `XDG_DATA_HOME=${join(home, "share")}`,
    `XDG_CACHE_HOME=${join(home, "cache")}`,
  ];
}

/**
 * The run context a HERMETIC session hands the adapter's env assembly on
 * every turn (the kimi-turn-context.ts pattern): the session's private
 * home through the field whose gate the adapter enforces — gemini's
 * getRunEnv refuses a hermetic launch whose context carries no home,
 * pi's refuses an override launch whose context carries no agent
 * directory — while droid, copilot, and goose ride their redirect on
 * argv alone and get the field only so their env assembly agrees with
 * the argv. The path fields read through getters so they follow the
 * private home's settle rename: the launcher caches the turn
 * environment before the driver may settle, so a plain value would
 * name the run-shaped directory after the rename. `finalize` is a
 * no-op everywhere: the home belongs to the session, not to one turn.
 */
export function turnAgentHermeticTurnContext(
  agent: TurnAgentId,
  home: Pick<SessionPrivateHome, "dir">
): RunContext {
  switch (agent) {
    case "droid":
      return {
        droidHermeticHome: {
          get home(): string {
            return home.dir;
          },
          get brandHome(): string {
            return join(home.dir, ".factory");
          },
          finalize: () => {},
        },
      };
    case "pi":
      return {
        piProviderAgentDir: {
          get path(): string {
            return home.dir;
          },
          finalize: () => {},
        },
      };
    case "gemini":
      return {
        geminiHermeticHome: {
          get home(): string {
            return home.dir;
          },
          get geminiDir(): string {
            return join(home.dir, ".gemini");
          },
          finalize: () => {},
        },
      };
    case "copilot":
      return {
        copilotHermeticHome: {
          get home(): string {
            return home.dir;
          },
          finalize: () => {},
        },
      };
    case "goose":
      return {
        gooseHermeticHome: {
          get home(): string {
            return home.dir;
          },
          get envAssignments(): string[] {
            return gooseSessionHermeticAssignments(home.dir);
          },
          finalize: () => {},
        },
      };
    case "cline": // Cline settings are rebuilt by its per-turn launch arm.
    case "cursor":
    case "qwen":
    case "openhands":
      // cursor and qwen keep no session home; openhands carries its
      // redirect on the turn argv alone (openhandsSessionEnvPrefix), and
      // its getRunEnv reads no context field: nothing to synthesize.
      return {};
  }
}
