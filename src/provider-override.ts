/**
 * Per-harness provider overrides, driven by environment variables.
 *
 * An operator who wants one harness to talk to a different model provider
 * (an OpenAI-compatible gateway, a subscription endpoint such as Z.AI's)
 * exports three names before invoking codemux:
 *
 *   CODEMUX_<AGENT>_PROVIDER_BASE_URL   provider endpoint, absolute http(s) URL
 *   CODEMUX_<AGENT>_PROVIDER_API_KEY    credential, delivered to the harness only
 *   CODEMUX_<AGENT>_PROVIDER_MODEL      model name the provider serves
 *
 * plus two optional caps, meaningful only alongside the override above:
 *
 *   CODEMUX_<AGENT>_PROVIDER_MAX_OUTPUT_TOKENS   reply budget the harness enforces
 *   CODEMUX_<AGENT>_PROVIDER_MAX_CONTEXT_TOKENS  context window the harness assumes
 *
 * `<AGENT>` is the codemux agent id uppercased (`AIDER`, `OPENCODE`, …). The
 * adapter reads them from codemux's own environment and translates them into
 * whatever the harness consumes: environment variables the adapter provides,
 * or a config file inside a private per-run home the adapter creates and
 * removes. The key is never placed in argv, never printed, and never written
 * outside a 0600 file codemux owns for the length of the run.
 *
 * The override survives `--hermetic`: hermetic runs remove operator
 * configuration, but the override travels through the environment codemux
 * itself provides (adapter-provided keys always pass the sanitizer) or
 * through codemux's own file inside the private home — never through an
 * operator file the hermetic run would close.
 *
 * Resolution lives here, a pure function of the environment, so any spawn
 * codemux makes can call it: `codemux run` through the adapter today.
 * `codemux session` does not carry overrides in this release: it refuses
 * to start while any `CODEMUX_<AGENT>_PROVIDER_*` name is set for the
 * session agent (review live25), and wiring the override into the session
 * spawn through this same call is the next release's work.
 *
 * Blank values count as unset, so an exported empty variable is harmless.
 */

import type { AgentId } from "./types.js";
import { validateModelName } from "./validation.js";

export interface ProviderOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Reply budget, when the harness carries an output-token cap. */
  maxOutputTokens?: number;
  /** Context window, when the harness carries a context-token cap. */
  maxContextTokens?: number;
}

export type ProviderOverrideField = keyof ProviderOverride;

export interface ProviderOverrideEnvNames {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: string;
  maxContextTokens: string;
}

/** The environment names for one agent's provider override and its caps. */
export function providerOverrideEnvNames(agent: AgentId): ProviderOverrideEnvNames {
  const prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
  return {
    baseUrl: `${prefix}BASE_URL`,
    apiKey: `${prefix}API_KEY`,
    model: `${prefix}MODEL`,
    maxOutputTokens: `${prefix}MAX_OUTPUT_TOKENS`,
    maxContextTokens: `${prefix}MAX_CONTEXT_TOKENS`,
  };
}

const MAX_API_KEY_BYTES = 4096;
// A credential must survive an HTTP header: no whitespace, no control
// characters, nothing that could smuggle a second header.
const API_KEY_PATTERN = /^[!-~]+$/;

/**
 * Reads and validates the override for one agent. Returns `null` when no
 * name is set (or every set name is blank). Throws on a half-configured or
 * malformed override — names only in the message, never a value, and never
 * the key.
 */
export function readProviderOverride(
  agent: AgentId,
  environment: NodeJS.ProcessEnv = process.env
): ProviderOverride | null {
  const names = providerOverrideEnvNames(agent);
  const baseUrl = environment[names.baseUrl]?.trim() || undefined;
  const apiKey = environment[names.apiKey]?.trim() || undefined;
  const model = environment[names.model]?.trim() || undefined;
  const maxOutputTokens = readTokenCap(environment[names.maxOutputTokens], names.maxOutputTokens);
  const maxContextTokens = readTokenCap(environment[names.maxContextTokens], names.maxContextTokens);
  if (
    baseUrl === undefined &&
    apiKey === undefined &&
    model === undefined &&
    maxOutputTokens === undefined &&
    maxContextTokens === undefined
  ) {
    return null;
  }
  if (baseUrl === undefined && apiKey === undefined && model === undefined) {
    // A cap alone cannot run: it sizes a provider the override names, so a
    // cap without one is a half-configured override, not a quiet no-op.
    const capName =
      maxOutputTokens !== undefined ? names.maxOutputTokens : names.maxContextTokens;
    throw new Error(
      `${capName} is set but no provider override is; a token cap applies only to ` +
        `a provider override, so also set ${names.baseUrl}, ${names.apiKey} and ${names.model}`
    );
  }

  if (baseUrl !== undefined) {
    // Braces are template syntax in the config files overrides write —
    // OpenCode substitutes {env:…}/{file:…} in config text (the reason
    // opencodeBareModel refuses them in models) and droid and pi expand
    // ${VAR} templates — so a base URL carrying one could splice an
    // environment variable's value or a file's content into a config
    // codemux writes (h4 review).
    if (baseUrl.includes("{") || baseUrl.includes("}")) {
      throw new Error(
        `${names.baseUrl} must not contain braces: OpenCode substitutes ` +
          "{env:…}/{file:…} and droid and pi expand ${VAR} templates in the " +
          "config files this override writes, so a brace could splice " +
          "another value into them"
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(
        `${names.baseUrl} must be an absolute http(s) URL`
      );
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error(
        `${names.baseUrl} must be a plain http(s) URL without credentials or fragment`
      );
    }
  }

  if (apiKey !== undefined) {
    if (Buffer.byteLength(apiKey, "utf8") > MAX_API_KEY_BYTES || !API_KEY_PATTERN.test(apiKey)) {
      throw new Error(
        `${names.apiKey} must be 1 to ${MAX_API_KEY_BYTES} printable ASCII bytes without whitespace`
      );
    }
  }

  if (model !== undefined) {
    try {
      validateModelName(model);
    } catch {
      throw new Error(`${names.model} is not a valid model name`);
    }
  }

  return { baseUrl, apiKey, model, maxOutputTokens, maxContextTokens };
}

/** Reads one cap: blank counts as unset, anything else must be a positive integer. */
function readTokenCap(raw: string | undefined, name: string): number | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  // Digits only: no sign, no decimal point, no exponent — a cap the operator
  // cannot state as a whole number of tokens is a typo, not a rounding.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer number of tokens`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of tokens`);
  }
  return value;
}

/**
 * Whether one harness can carry one of the caps: `true` when it can, or a
 * string naming the evidence-backed reason it cannot, which becomes the
 * refusal. A cap a harness cannot carry fails the run loudly before launch
 * — never a silent no-op, because a cap the operator set and codemux
 * dropped is a wrong-size request, not a missing feature.
 */
export type ProviderCapSupport = true | string;

export function assertProviderCap(
  agent: AgentId,
  override: ProviderOverride | null,
  cap: "maxOutputTokens" | "maxContextTokens",
  support: ProviderCapSupport
): void {
  if (override === null || override[cap] === undefined || support === true) return;
  const names = providerOverrideEnvNames(agent);
  throw new Error(`${names[cap]} cannot be honored: ${support}`);
}

/**
 * The subset of an override an adapter requires. `readProviderOverride`
 * already validated shapes; this only reports missing names, so a
 * half-configured override fails loudly instead of silently reaching the
 * harness's native provider.
 */
export function requireProviderOverride(
  agent: AgentId,
  override: ProviderOverride | null,
  required: readonly ("baseUrl" | "apiKey" | "model")[]
): ProviderOverride {
  if (override === null) {
    const names = providerOverrideEnvNames(agent);
    const missing = required.map((field) => names[field]).join(", ");
    throw new Error(`provider override requires ${missing} in the environment`);
  }
  const names = providerOverrideEnvNames(agent);
  const missing = required
    .filter((field) => override[field] === undefined)
    .map((field) => names[field]);
  if (missing.length > 0) {
    throw new Error(`provider override is missing ${missing.join(", ")}`);
  }
  return override;
}
