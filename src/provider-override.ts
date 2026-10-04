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
 * Blank values count as unset, so an exported empty variable is harmless.
 */

import type { AgentId } from "./types.js";
import { validateModelName } from "./validation.js";

export interface ProviderOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface ProviderOverrideEnvNames {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The three environment names for one agent's provider override. */
export function providerOverrideEnvNames(agent: AgentId): ProviderOverrideEnvNames {
  const prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
  return {
    baseUrl: `${prefix}BASE_URL`,
    apiKey: `${prefix}API_KEY`,
    model: `${prefix}MODEL`,
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
  if (baseUrl === undefined && apiKey === undefined && model === undefined) {
    return null;
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

  return { baseUrl, apiKey, model };
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
