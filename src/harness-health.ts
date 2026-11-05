/**
 * The per-harness health vocabulary `codemux doctor` (the machine check)
 * reports and the live gate's automatic credential skips consume: the
 * login-state model with one reader per credential store, and the quota
 * gate's verdict in a dry form.
 *
 * The login readers touch EXISTENCE, MODE, OWNER, AND EXPIRY FIELDS ONLY.
 * A credential value, token, key, account name, or address never enters a
 * return value or a printed line. The account may surface as a short
 * fingerprint (a hash prefix), and only in `--format json`, so an
 * operator with two accounts can tell them apart without exposing either.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gateOnResult } from "./quota-gate.js";
import { ALLOWED_CREDENTIAL_ENV, probeEnvironment } from "./environment.js";
import { resolveTrustedExecutable } from "./executable-security.js";
import { readUtf8FileBounded } from "./file-io.js";
import {
  describeHarnessBreakage,
  evaluateHarnessVersion,
  probeHarnessVersionDetailed,
} from "./harness-compatibility.js";
import { HARNESS_CONTRACTS, type HarnessBreak, type HarnessContract } from "./harness-contracts.js";
import type { AgentId, QuotaPolicy } from "./types.js";
import { UsageRefusalError } from "./validation.js";
import type { UsageSnapshot } from "./usage-protocol.js";

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

// A credential store is a regular, non-empty file: a directory, a dangling
// link, or an empty file at the path is no login (review round 44).
const fileExistsModeOk = (path: string): boolean => {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
};

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

/** claude: the on-disk mirror of the Keychain credential
 * (`~/.claude/.credentials.json`). The sandboxed child reads the mirror,
 * so its `claudeAiOauth.expiresAt` (epoch ms) is the expiry that matters.
 * The mirror never carries a refresh token by design (src/credentials.ts),
 * so an expired mirror means "stale", not "logged out". */
export function claudeLoginState(home: string): LoginState {
  const store = "~/.claude/.credentials.json";
  const parsed = readJsonIfPresent(join(home, ".claude", ".credentials.json"));
  if (parsed === null) {
    return {
      state: "unknown",
      store,
      note: "no credential mirror; the Keychain login cannot be read without the Keychain, and one unsandboxed claude run creates the mirror",
    };
  }
  if (parsed === "unreadable") {
    return { state: "unknown", store, note: "the mirror is not a readable credential object" };
  }
  const oauth = parsed.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) {
    return { state: "unknown", store, note: "the mirror carries no claudeAiOauth object" };
  }
  const expiresAt = (oauth as Record<string, unknown>).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { state: "unknown", store, note: "the mirror carries no readable expiry" };
  }
  return expiryFresh(expiresAt)
    ? { state: "logged-in", store }
    : {
        state: "expired",
        store,
        note: "the mirror's access token has expired; one unsandboxed claude run refreshes it",
        refreshPresent: false,
      };
}

/** codex: `~/.codex/auth.json` (the file hermetic runs link), or an API
 * key in the environment. Reads `auth_mode` and the presence of
 * `tokens.refresh_token` only. */
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
    const refreshToken = tokenRecord !== null && typeof tokenRecord.refresh_token === "string";
    const accessToken = tokenRecord !== null && typeof tokenRecord.access_token === "string";
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY !== "";
    // A parseable file is not a login: `{}` or a tokenless object carries
    // no credential, and the next codex launch fails authentication
    // (review round 42). Presence of a token field is the test, never its value.
    if (!refreshToken && !accessToken && !apiKey) {
      // An API key in the environment still logs codex in (review round 47).
      const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.codex);
      return envName === null
        ? { state: "no-credential", store, note: "auth.json exists but carries no token" }
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
    ? { state: "no-credential", store }
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

/** kimi: `~/.kimi-code/credentials/kimi-code.json`. The access token
 * lives 15 minutes and kimi renews it from the stored refresh token at the
 * start of its next run, so an aged-out access token beside a refresh
 * token is how a working login looks most of the time: `logged-in`, with a
 * note. Only an aged-out token with no refresh token is `expired`. The
 * reader checks presence only: a refresh token the server has revoked
 * looks the same, and only a kimi run can tell. */
export function kimiLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.kimi);
  if (envName !== null) {
    return { state: "logged-in", store: envName, note: "API key in the environment" };
  }
  const store = "~/.kimi-code/credentials/kimi-code.json";
  const parsed = readJsonIfPresent(join(home, ".kimi-code", "credentials", "kimi-code.json"));
  if (parsed === null) return { state: "no-credential", store };
  if (parsed === "unreadable") {
    return { state: "unknown", store, note: "the credential file is not a readable object" };
  }
  const accessToken = typeof parsed.access_token === "string" && parsed.access_token !== "";
  const refreshToken = typeof parsed.refresh_token === "string" && parsed.refresh_token !== "";
  if (!accessToken && !refreshToken) {
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

/** zai: the key file `~/.zai` (existence and mode only) or `ZAI_API_KEY`. */
export function zaiLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.zai";
  if (environment.ZAI_API_KEY?.trim()) {
    return { state: "logged-in", store: "ZAI_API_KEY" };
  }
  const path = join(home, ".zai");
  if (!fileExistsModeOk(path)) return { state: "no-credential", store };
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return { state: "no-credential", store, note: "the path exists but is not a regular file" };
    }
    if (stats.mode & 0o077) {
      return {
        state: "no-credential",
        store,
        note: "the key file is group- or world-accessible; chmod it to 0600",
      };
    }
    return { state: "logged-in", store };
  } catch {
    return { state: "unknown", store };
  }
}

/** A bare file-presence store: cursor's `~/.cursor/auth.json` (the file
 * store the sandbox needs) or opencode's `auth.json` in its data
 * directory. `label` names the store in `~/` notation. */
export function fileStoreLoginState(path: string, label: string): LoginState {
  const parsed = readJsonIfPresent(path);
  if (parsed === null) return { state: "no-credential", store: label };
  if (parsed === "unreadable") {
    return { state: "unknown", store: label, note: "the store exists but is not a readable object" };
  }
  const providers = Object.keys(parsed).filter((key) => key !== "version");
  return providers.length > 0
    ? { state: "logged-in", store: label, note: `${providers.length} provider login${providers.length === 1 ? "" : "s"}` }
    : { state: "no-credential", store: label, note: "the store exists but carries no login" };
}

/** A provider-key harness (aider, openhands, qwen, droid, goose by key):
 * logged in exactly when one of its credential environment names is set.
 * The store names the variable, never its value. */
export function envKeyLoginState(agent: AgentId, environment: NodeJS.ProcessEnv): LoginState {
  const names = ALLOWED_CREDENTIAL_ENV[agent];
  const set = firstSetEnv(environment, names);
  return set === null
    ? { state: "no-credential", store: names.length > 0 ? names.join(", ") : "(no credential variable is defined for this harness)" }
    : { state: "logged-in", store: set };
}

/** The home directory a login reader uses: the adapter's environment HOME
 * when it is absolute, else the account home. */
export const loginHome = (environment: NodeJS.ProcessEnv): string => {
  const home = environment.HOME ?? environment.USERPROFILE;
  return home !== undefined && /^\/|^[A-Za-z]:[\\/]/.test(home) ? home : homedir();
};

/** agy: the file token under `~/.gemini` (existence only; its validity
 * needs agy itself), else an API key in the environment. The Keychain
 * login (service gemini) is not read here: the file token is what the
 * sandboxed run consumes. */
export function agyLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.gemini/antigravity-cli/antigravity-oauth-token";
  if (fileExistsModeOk(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"))) {
    return { state: "logged-in", store };
  }
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.agy);
  return envName === null
    ? { state: "no-credential", store }
    : { state: "logged-in", store: envName };
}

/** gemini: `~/.gemini/oauth_creds.json`, else an API key. */
export function geminiLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.gemini/oauth_creds.json";
  if (fileExistsModeOk(join(home, ".gemini", "oauth_creds.json"))) {
    return { state: "logged-in", store };
  }
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.gemini);
  return envName === null ? { state: "no-credential", store } : { state: "logged-in", store: envName };
}

/** goose: a configured provider in `~/.config/goose/config.yaml` (the
 * file `goose doctor` itself reads), else an API key. */
export function gooseLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const store = "~/.config/goose/config.yaml";
  if (fileExistsModeOk(join(home, ".config", "goose", "config.yaml"))) {
    return { state: "logged-in", store };
  }
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.goose);
  return envName === null
    ? { state: "no-credential", store, note: "goose doctor says: no provider configured" }
    : { state: "logged-in", store: envName };
}

/** copilot: a GitHub token in the environment, else `~/.copilot/config.json`. */
export function copilotLoginState(home: string, environment: NodeJS.ProcessEnv): LoginState {
  const envName = firstSetEnv(environment, ALLOWED_CREDENTIAL_ENV.copilot);
  if (envName !== null) return { state: "logged-in", store: envName };
  const store = "~/.copilot/config.json";
  if (fileExistsModeOk(join(home, ".copilot", "config.json"))) {
    return { state: "unknown", store, note: "the config exists; whether it carries a login needs copilot itself" };
  }
  return { state: "no-credential", store };
}

/** pi: `~/.pi/agent/auth.json` (an empty object means no login), else a
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

/** The one version-verdict spelling: the same probe and the same
 * evaluation the launch gate uses, reduced to a structured verdict whose
 * `label` is what doctor prints and whose `kind` is what the machine
 * check and the live gate's probe 0 classify on. One module so the two
 * columns cannot disagree (audit D4). */
export type VersionVerdictKind =
  | "ok"
  | "above-ceiling"
  | "below-min"
  | "known-break"
  | "no-contract"
  | "unreadable"
  | "untrusted";

export interface VersionVerdict {
  kind: VersionVerdictKind;
  /** The probe's parsed version, when it read one. */
  version: string | null;
  /** The human line: `ok (2.1.223)`, `below minimum (…; minimum …)`, … */
  label: string;
  /** The break record, set for `known-break`, so the caller can apply the
   * sandbox mitigation rule (mitigated and scode present = warn). */
  breakage?: HarnessBreak;
  /** Why an `unreadable` or `untrusted` verdict is one. */
  detail?: string;
}

/** The default per-probe bound for one version verdict. The slowest
 * installed harness (openhands, whose version command pays Python
 * startup) measured about 6 s, so 10 s reads it with margin while still
 * bounding a hung binary; the launch gate keeps its own (longer) timeout. */
export const VERSION_VERDICT_PROBE_TIMEOUT_MS = 10_000;

export async function probeVersionVerdict(
  agent: AgentId,
  binaryName: string,
  options: { timeoutMs?: number; workdir?: string; contract?: HarnessContract; binary?: string } = {}
): Promise<VersionVerdict> {
  const workdir = options.workdir ?? process.cwd();
  // The live gate's probe 0 resolves the binary itself (its own which seam)
  // and may carry a contract table other than this checkout's default; a
  // caller that passes neither gets exactly what doctor prints.
  const contract = options.contract ?? HARNESS_CONTRACTS[agent];
  if (contract === undefined) {
    return { kind: "no-contract", version: null, label: "no contract" };
  }
  const binary = options.binary ?? Bun.which(binaryName, { PATH: process.env.PATH ?? "" });
  if (binary === null) {
    // Installed at discovery, gone at probe time: a removed binary is a
    // version codemux could not read, not an agent without a contract.
    return {
      kind: "unreadable",
      version: null,
      label: "unreadable (binary not found)",
      detail: "binary not found",
    };
  }
  let trusted: string;
  try {
    // The same rule every codemux spawn applies (the launch gate's): a
    // binary planted on PATH — a project-local node_modules/.bin — must
    // not run unsandboxed under a diagnostic either.
    trusted = resolveTrustedExecutable(binary, binaryName, workdir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "untrusted", version: null, label: `untrusted binary (${detail})`, detail };
  }
  let probe: Awaited<ReturnType<typeof probeHarnessVersionDetailed>>;
  try {
    probe = await probeHarnessVersionDetailed(
      trusted,
      contract,
      workdir,
      probeEnvironment(process.env as Record<string, string>),
      binaryName,
      { timeoutMs: options.timeoutMs ?? VERSION_VERDICT_PROBE_TIMEOUT_MS }
    );
  } catch (error) {
    // One harness's failed probe must not end the whole report: the
    // caller prints every agent, so the verdict names the failure, first
    // line only. The launch gate keeps refusing on the same failure.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { kind: "unreadable", version: null, label: `unreadable (${detail})`, detail };
  }
  if (probe.timedOut) {
    return { kind: "unreadable", version: null, label: "unreadable (timed out)", detail: "timed out" };
  }
  if (probe.version === null) {
    return { kind: "unreadable", version: null, label: "unreadable", detail: "no version in the probe output" };
  }
  const verdict = evaluateHarnessVersion(agent, contract, probe.version);
  if (verdict.reason === "supported") {
    return { kind: "ok", version: probe.version, label: `ok (${probe.version})` };
  }
  if (verdict.reason === "unaudited") {
    return {
      kind: "above-ceiling",
      version: probe.version,
      label: `above audited ceiling (${probe.version}; audited ${contract.maxAudited})`,
    };
  }
  if (verdict.reason === "breakage" && verdict.breakage) {
    return {
      kind: "known-break",
      version: probe.version,
      label: describeHarnessBreakage(verdict.breakage),
      breakage: verdict.breakage,
    };
  }
  return {
    kind: "below-min",
    version: probe.version,
    label: `below minimum (${probe.version}; minimum ${contract.min})`,
  };
}
