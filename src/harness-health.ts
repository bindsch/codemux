/**
 * The per-harness health vocabulary `codemux doctor` (the machine check)
 * reports and the live gate's automatic credential skips consume: the
 * login-state model with one reader per credential store, and the quota
 * gate's verdict in a dry form.
 *
 * The login readers touch EXISTENCE, MODE, OWNER, EXPIRY, AND TOKEN-FIELD
 * PRESENCE ONLY — whether a token field holds a non-empty string, never
 * what the string is. A credential value, token, key, account name, or
 * address never enters a return value or a printed line. The account may
 * surface as a short fingerprint (a hash prefix), and only in
 * `--format json`, so an operator with two accounts can tell them apart
 * without exposing either.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gateOnResult } from "./quota-gate.js";
import { ALLOWED_CREDENTIAL_ENV } from "./environment.js";
import { readUtf8FileBounded } from "./file-io.js";
import { claudeLoginDirectory } from "./claude-login.js";
import type { AgentId, QuotaPolicy } from "./types.js";
import { UsageRefusalError } from "./validation.js";
import type { UsageSnapshot } from "./usage-protocol.js";

// The version-verdict half of this module lives in harness-health-version.ts
// (round 331 split, for the file-size cap) and is re-exported here so every
// importer keeps one name.
export {
  probeVersionVerdict,
  VERSION_VERDICT_PROBE_TIMEOUT_MS,
  type VersionVerdict,
  type VersionVerdictKind,
} from "./harness-health-version.js";

export type LoginStateKind = "logged-in" | "expired" | "no-credential" | "unknown";

export interface LoginState {
  state: LoginStateKind;
  /** The store the verdict was read from, in `~/` notation; never an
   * absolute home path and never a value. */
  store?: string;
  /** One line naming why, when the verdict is not plain. */
  note?: string;
  /** Set when an expired store still carries a refresh token. */
  refreshPresent?: boolean;
  /** At most 4 characters: a SHA-256 prefix of the account identity, so
   * an operator can tell two accounts apart without either being
   * printable. `--format json` only; human output prints `present`. */
  accountFingerprint?: string;
}

/** The fingerprint spelling for an identity string. */
export const loginFingerprint = (identity: string): string =>
  createHash("sha256").update(identity).digest("hex").slice(0, 4);

// Reading a credential file answers three questions and no more: is it
// there, is it shaped like the store codemux knows, and (when the store
// carries one) has its expiry passed. A parse failure is `unknown`, never
// `no-credential`: a malformed store is not an absent one.
const MAX_CREDENTIAL_STORE_BYTES = 1_048_576;
const readJsonIfPresent = (path: string): Record<string, unknown> | null | "unreadable" => {
  try {
    // One non-blocking open, checked on the descriptor: a FIFO would block
    // the read and a huge file would be read whole, also when either
    // replaces the file after a check of the path (review rounds 50, 108).
    const text = readUtf8FileBounded(path, { maxBytes: MAX_CREDENTIAL_STORE_BYTES, label: "the credential store" });
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unreadable";
    return parsed as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
};

// File presence is evidence about this source only. An absent, empty or
// inaccessible source cannot establish the harness's native login state.
const fileExistsModeOk = (path: string): boolean | "unreadable" => {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : "unreadable";
  }
};

// The unreadable answer as a login state (round 307).
const storeUnreadable = (store: string): LoginState => ({ state: "unknown", store, note: "the store exists but could not be inspected; this is not a missing login" });
const storeUnconfirmed = (store: string): LoginState => ({ state: "unknown", store, note: "this source does not confirm the harness's login state" });

const firstSetEnv = (environment: NodeJS.ProcessEnv, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return name;
  }
  return null;
};

/** True when `epochMs` is in the future. A missing or non-numeric expiry
 * is the caller's `unknown`, decided by the reader, not here. */
const expiryFresh = (epochMs: number): boolean => epochMs > Date.now();

/** File evidence cannot establish the macOS Keychain authentication state. */
export function claudeLoginState(home: string, environment: NodeJS.ProcessEnv = {}, platform = process.platform): LoginState {
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.claude);
  if (envName !== null) return { state: "logged-in", store: envName };
  const directory = claudeLoginDirectory({ ...environment, HOME: home });
  const store = directory === join(home, ".claude") ? "~/.claude/.credentials.json" : "configured Claude login directory/.credentials.json";
  const unknown = (): LoginState => platform === "darwin"
    ? { state: "unknown", store: "macOS Keychain", note: "Claude manages its own login; native authentication has not been checked" }
    : storeUnconfirmed(store);
  const parsed = readJsonIfPresent(join(directory, ".credentials.json"));
  if (parsed === null || parsed === "unreadable") return unknown();
  const oauth = parsed.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return unknown();
  const accessToken = (oauth as Record<string, unknown>).accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) return unknown();
  const expiresAt = (oauth as Record<string, unknown>).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return unknown();
  if (expiryFresh(expiresAt)) return { state: "logged-in", store };
  if (platform === "darwin") return unknown();
  const refreshPresent = typeof (oauth as Record<string, unknown>).refreshToken === "string" &&
    Boolean(((oauth as Record<string, unknown>).refreshToken as string).trim());
  return refreshPresent
    ? { state: "logged-in", store, refreshPresent: true, note: "the file holds an expired access token and a refresh token; Claude handles refresh" }
    : { state: "expired", store, refreshPresent: false, note: "the readable file holds an expired access token without a refresh token" };
}

/** codex: `~/.codex/auth.json` (the file hermetic runs link), or an API
 * key in the environment. Reads `auth_mode` and the presence of non-empty
 * `tokens.refresh_token`/`tokens.access_token` strings only. */
export function codexLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.codex/auth.json";
  const parsed = readJsonIfPresent(join(home, ".codex", "auth.json"));
  if (parsed !== null && parsed !== "unreadable") {
    const mode = parsed.auth_mode;
    const tokens = parsed.tokens;
    const tokenRecord =
      typeof tokens === "object" && tokens !== null && !Array.isArray(tokens)
        ? (tokens as Record<string, unknown>)
        : null;
    const refreshToken = tokenRecord !== null && typeof tokenRecord.refresh_token === "string" && tokenRecord.refresh_token !== "";
    const accessToken = tokenRecord !== null && typeof tokenRecord.access_token === "string" && tokenRecord.access_token !== "";
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY !== "";
    // An empty file store cannot rule out native authentication elsewhere.
    if (!refreshToken && !accessToken && !apiKey) {
      // An API key in the environment still logs codex in (review round 47).
      const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.codex);
      return envName === null
        ? { ...storeUnconfirmed(store), note: "auth.json carries no token; native authentication has not been checked" }
        : { state: "logged-in", store: envName, note: "auth.json exists but carries no token; the environment key logs codex in" };
    }
    return {
      state: "logged-in",
      store,
      refreshPresent: refreshToken,
      note: `auth.json (mode ${typeof mode === "string" ? mode : "unknown"}, ${refreshToken ? "refresh token present" : apiKey ? "API key" : "access token only"})`,
    };
  }
  if (parsed === "unreadable") {
    return { state: "unknown", store, note: "auth.json exists but is not a readable object" };
  }
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.codex);
  return envName === null
    ? storeUnconfirmed(store)
    : { state: "logged-in", store: envName, note: "API key in the environment" };
}

/** A kimi expiry as epoch milliseconds: kimi writes epoch seconds as a
 * number; a plain decimal string and a millisecond value are read the same
 * way (usagemux reads this field with the same rule). */
const kimiExpiryMs = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1e12 ? parsed : parsed * 1_000;
};

/** kimi: the JSON files under `~/.kimi-code/credentials/`. Kimi 2.6 keeps a
 * login in `kimi-code-env-<id>.json` beside the older `kimi-code.json`, so
 * every `kimi-code*.json` there is read. The access token lives 15 minutes
 * and kimi renews it from the stored refresh token at the start of its next
 * run, so an aged-out access token beside a refresh token is `logged-in`,
 * with a note. A file with no usable token proves nothing about the others
 * or about what kimi will do: when no file confirms a login the answer is
 * `unknown`, never a missing or expired login. Only a kimi run can tell. */
export function kimiLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.kimi);
  if (envName !== null) {
    return { state: "logged-in", store: envName, note: "API key in the environment" };
  }
  const configured = environment.KIMI_CODE_HOME;
  const label = configured === undefined ? "~/.kimi-code/credentials" : "KIMI_CODE_HOME/credentials";
  const directory = join(configured ?? join(home, ".kimi-code"), "credentials");
  const primary = kimiFileState(join(directory, "kimi-code.json"), `${label}/kimi-code.json`);
  if (primary.state === "logged-in") return primary;
  for (const name of kimiScopedStores(directory)) {
    const scoped = kimiFileState(join(directory, name), `${label}/${name}`);
    if (scoped.state === "logged-in") return scoped;
  }
  if (primary.state === "unknown") return primary;
  return { state: "unknown", store: primary.store, refreshPresent: primary.refreshPresent,
    note: `${primary.note ?? "no usable token"}; no Kimi credential file confirms a login, and only a kimi run can confirm it` };
}

/** The other `kimi-code*.json` names in the credentials directory, sorted
 * and bounded; an unreadable directory yields none. */
function kimiScopedStores(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => /^kimi-code[A-Za-z0-9._-]*\.json$/.test(name) && name !== "kimi-code.json")
      .sort().slice(0, 32);
  } catch {
    return [];
  }
}

function kimiFileState(path: string, store: string): LoginState {
  const parsed = readJsonIfPresent(path);
  if (parsed === null) return storeUnconfirmed(store);
  if (parsed === "unreadable") {
    return { state: "unknown", store, note: "the credential file is not a readable object" };
  }
  const accessToken = typeof parsed.access_token === "string" && parsed.access_token !== "";
  const refreshToken = typeof parsed.refresh_token === "string" && parsed.refresh_token !== "";
  if (!accessToken && !refreshToken) {
    if (parsed.access_token === "" && parsed.refresh_token === "") {
      return { state: "no-credential", store, refreshPresent: false,
        note: "the readable Kimi credential file has empty access and refresh tokens" };
    }
    return { state: "no-credential", store, note: "the credential file exists but carries no token" };
  }
  // The expiry decides one thing only: whether the access token alone is
  // still usable. A refresh token logs kimi in whatever the expiry says,
  // readable or not (review round 106).
  const expiresAt = kimiExpiryMs(parsed.expires_at);
  if (accessToken && expiresAt !== null && expiryFresh(expiresAt)) return { state: "logged-in", store };
  if (refreshToken) {
    const renews = "kimi renews it from the refresh token on its next run";
    const note = !accessToken
      ? "the store holds no access token; kimi obtains one from the refresh token on its next run"
      : expiresAt === null
        ? `the access token carries no readable expiry; ${renews}`
        : `kimi's 15-minute access token has aged out; ${renews}`;
    return { state: "logged-in", store, refreshPresent: true, note };
  }
  if (expiresAt === null) {
    return { state: "unknown", store, note: "the credential carries no readable expiry and no refresh token" };
  }
  return { state: "expired", store, refreshPresent: false, note: "the access token has expired and the store holds no refresh token" };
}

/** zai: the key file `~/.zai` (existence, mode, and ownership only; never
 * a symbolic link — the adapter reads it without following one, so a link
 * is a credential the launch path refuses) or `ZAI_API_KEY`. */
export function zaiLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.zai";
  if (environment.ZAI_API_KEY?.trim()) {
    return { state: "logged-in", store: "ZAI_API_KEY" };
  }
  const path = join(home, ".zai");
  // One lstat of the path, so the link itself is what gets judged (review
  // round 331): the adapter's no-follow read refuses a final symlink, and
  // so does the machine check, instead of certifying the file behind it.
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      return { state: "no-credential", store, note: "the key file must not be a symbolic link" };
    }
    if (!stats.isFile() || stats.size === 0) {
      // A directory, a dangling link (caught above as a link), or an empty
      // file at the path is no login (review round 44).
      return { state: "no-credential", store };
    }
    if (stats.mode & 0o077) {
      return {
        state: "no-credential",
        store,
        note: "the key file is group- or world-accessible; chmod it to 0600",
      };
    }
    // The adapter's ownership rule: a key file owned by another user is a
    // credential the launch path refuses, so doctor must not report it as
    // a login either.
    if (process.platform !== "win32" && typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      return { state: "no-credential", store, note: "the key file must be owned by the current user" };
    }
    return { state: "logged-in", store };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { state: "no-credential", store }
      : { state: "unknown", store };
  }
}

/** A bare file-presence store: cursor's `~/.cursor/auth.json` (the file
 * store the sandbox needs) or opencode's `auth.json` in its data
 * directory. `label` names the store in `~/` notation. */
export function fileStoreLoginState(path: string, label: string): LoginState {
  const parsed = readJsonIfPresent(path);
  if (parsed === null) return storeUnconfirmed(label);
  if (parsed === "unreadable") {
    return { state: "unknown", store: label, note: "the store exists but is not a readable object" };
  }
  const providers = Object.keys(parsed).filter((key) => key !== "version");
  return providers.length > 0
    ? { state: "logged-in", store: label, note: `${providers.length} provider login${providers.length === 1 ? "" : "s"}` }
    : { ...storeUnconfirmed(label), note: "the readable store has no provider entries; native authentication has not been checked" };
}

/** Report positive environment-key evidence. Missing variables cannot rule
 * out native login files, OS stores or provider configuration. */
export function envKeyLoginState(agent: AgentId, environment: NodeJS.ProcessEnv): LoginState {
  const names = ALLOWED_CREDENTIAL_ENV[agent].filter((name) => /(?:KEY|TOKEN)$/.test(name));
  const set = firstSetEnv(environment, names);
  return set === null
    ? storeUnconfirmed(names.length > 0 ? names.join(", ") : "harness-managed authentication")
    : { state: "logged-in", store: set };
}

/** The home directory a login reader uses: the adapter's environment HOME
 * when it is absolute, else the account home. */
export const loginHome = (environment: NodeJS.ProcessEnv): string => {
  const home = environment.HOME ?? environment.USERPROFILE;
  return home !== undefined && /^\/|^[A-Za-z]:[\\/]/.test(home) ? home : homedir();
};

/** agy can authenticate from the macOS Keychain without a file token.
 * Health checks never inspect that store; only agy can confirm the login. */
export function agyLoginState(home: string, environment: NodeJS.ProcessEnv, platform = process.platform): LoginState {
  const store = "~/.gemini/antigravity-cli/antigravity-oauth-token";
  const file = fileExistsModeOk(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
  if (file === true) return { state: "logged-in", store };
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.agy);
  if (envName !== null) return { state: "logged-in", store: envName };
  if (file === "unreadable") return storeUnreadable(store);
  if (platform === "darwin") return {
    state: "unknown", store: "macOS Keychain",
    note: "agy manages its own login; only a native agy request can confirm it",
  };
  return storeUnconfirmed(store);
}

/** gemini: `~/.gemini/oauth_creds.json`, else an API key. */
export function geminiLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.gemini/oauth_creds.json";
  const file = fileExistsModeOk(join(home, ".gemini", "oauth_creds.json"));
  if (file === true) return { state: "logged-in", store };
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.gemini);
  if (envName !== null) return { state: "logged-in", store: envName };
  if (file === "unreadable") return storeUnreadable(store);
  return storeUnconfirmed(store);
}

/** goose: a configured provider in `~/.config/goose/config.yaml` (the
 * file `goose doctor` itself reads), else an API key. */
export function gooseLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.config/goose/config.yaml";
  const file = fileExistsModeOk(join(home, ".config", "goose", "config.yaml"));
  if (file === true) return { state: "logged-in", store };
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.goose);
  if (envName !== null) return { state: "logged-in", store: envName };
  if (file === "unreadable") return storeUnreadable(store);
  return storeUnconfirmed(store);
}

/** copilot: a GitHub token in the environment, else `~/.copilot/config.json`. */
export function copilotLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.copilot);
  if (envName !== null) return { state: "logged-in", store: envName };
  const store = "~/.copilot/config.json";
  const config = fileExistsModeOk(join(home, ".copilot", "config.json"));
  if (config === "unreadable") return storeUnreadable(store);
  if (config) return { state: "unknown", store, note: "the config exists; whether it carries a login needs copilot itself" };
  return storeUnconfirmed(store);
}

/** pi: `~/.pi/agent/auth.json`, else a
 * provider key in the environment. */
export function piLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const auth = fileStoreLoginState(join(home, ".pi", "agent", "auth.json"), "~/.pi/agent/auth.json");
  if (auth.state === "logged-in") return auth;
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.pi);
  if (envName !== null) return { state: "logged-in", store: envName };
  return auth;
}

/** What the quota gate would do with one usagemux result, without
 * spending or refusing: `gateOnResult` in a dry mode. The gate's own
 * warnings are captured instead of printed, and its refusal is returned
 * as the verdict rather than thrown (audit D6: the machine check's usage
 * row says what a launch would do). */
export type DryGateAction = "proceed" | "warn" | "refuse";

export interface DryGateVerdict {
  action: DryGateAction;
  /** The gate's own lines (warnings, and the refusal when it refuses). */
  lines: string[];
}

export function dryGateOnResult(
  agent: AgentId,
  result: UsageSnapshot["results"][number],
  policy: QuotaPolicy
): DryGateVerdict {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    gateOnResult(agent, result, policy);
  } catch (error) {
    if (error instanceof UsageRefusalError) {
      return { action: "refuse", lines: [...lines, error.message] };
    }
    throw error;
  } finally {
    console.error = original;
  }
  return { action: lines.length > 0 ? "warn" : "proceed", lines };
}
