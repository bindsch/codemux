/**
 * Provider selection for `codemux complete`: which upstream, which URL,
 * and which API key. The key is read from one named environment variable
 * and nowhere else — never argv, never a file codemux writes, never the
 * Keychain — and an OAuth subscription token is refused: this command is
 * paid per-token API use, kept apart from the subscription quota the
 * harnesses spend (docs/complete.md).
 */

import { UsageRefusalError } from "../validation.js";

export const COMPLETE_PROVIDERS = ["anthropic", "openai", "openrouter", "openai-compatible"] as const;
export type CompleteProvider = (typeof COMPLETE_PROVIDERS)[number];

/** The wire the upstream speaks: the OpenAI chat-completions shape, or
 * Anthropic's Messages API (translated, src/complete/anthropic-*.ts). */
export type UpstreamWire = "openai" | "anthropic";

/** Each provider's own URL and key variable. The default key variable
 * applies only on that provider's own host: a `--base-url` naming another
 * host (and every `openai-compatible` upstream) needs `--key-env`, so a
 * provider key exported in a shell profile is never sent to a third party
 * by default. */
const DEFAULTS: Readonly<Record<CompleteProvider, { baseUrl: string | null; keyEnv: string | null; wire: UpstreamWire }>> = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", wire: "anthropic" },
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", wire: "openai" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", wire: "openai" },
  "openai-compatible": { baseUrl: null, keyEnv: null, wire: "openai" },
};

/** Environment variables that hold subscription OAuth tokens, never API
 * keys: naming one is refused before its value is read. */
const OAUTH_ENV_NAMES: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_OAUTH_TOKEN",
]);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Bun reads these on each fetch, including NO_PROXY for explicit proxies.
 * Source: https://bun.sh/docs/runtime/networking/fetch#proxying-requests
 * Remove them from the actual fetch environment, not just a config copy.
 * The complete process owns this environment; it never restores proxies. */
export function clearProxyEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  for (const name of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY",
    "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
    // Bun 1.3.14's setter clears its native env map; delete alone leaves
    // that map stale. Clear it before removing the JS property as well.
    // https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/JSEnvironmentVariableMap.cpp
    environment[name] = "";
    delete environment[name];
  }
}

function parseProxy(value: string | undefined, upstream: URL): string | undefined {
  if (value === undefined) return undefined;
  if (upstream.protocol === "http:") {
    throw new UsageRefusalError("--proxy is refused for a plain-http upstream: the API key would reach the proxy in cleartext");
  }
  let url: URL;
  try { url = new URL(value); } catch {
    throw new UsageRefusalError("--proxy must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new UsageRefusalError("--proxy must be an absolute http(s) URL without a path, query, or fragment");
  }
  return url.href;
}

export interface UpstreamConfig {
  provider: CompleteProvider;
  wire: UpstreamWire;
  /** The base URL without a trailing slash; `/chat/completions` or
   * `/messages` is appended. */
  baseUrl: string;
  /** The host the ledger records as `provider`. */
  host: string;
  keyEnv: string;
  apiKey: string;
  /** Only an explicit CLI proxy; ambient proxy variables are removed. */
  proxy?: string;
}

export function parseProvider(value: string): CompleteProvider {
  if (!(COMPLETE_PROVIDERS as readonly string[]).includes(value)) {
    throw new UsageRefusalError(`--provider must be one of ${COMPLETE_PROVIDERS.join(", ")}`);
  }
  return value as CompleteProvider;
}

/** An http(s) URL; plain http only to a loopback host, so the key never
 * crosses a network in cleartext. */
export function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageRefusalError("--base-url must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageRefusalError("--base-url must be an absolute http(s) URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new UsageRefusalError("--base-url must not carry credentials, a query, or a fragment");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UsageRefusalError(
      "--base-url may use plain http only for a loopback host; the API key would cross the network in cleartext"
    );
  }
  return url;
}

/** Why a key value is an OAuth subscription token, or null when it reads
 * as an API key. Anthropic OAuth tokens start `sk-ant-oat`; OpenAI's
 * ChatGPT sign-in hands out JWT access tokens (`eyJ…`, three dot-separated
 * segments). */
export function oauthTokenReason(key: string): string | null {
  if (key.startsWith("sk-ant-oat")) return "it is an Anthropic OAuth subscription token (sk-ant-oat…)";
  if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(key)) {
    return "it is a JWT access token, the shape a subscription sign-in issues";
  }
  return null;
}

/** Resolves the upstream from the options and the environment. Every
 * refusal is a UsageRefusalError (exit 64); no message ever quotes the
 * key's value. */
export function resolveUpstream(
  provider: CompleteProvider,
  baseUrlOption: string | undefined,
  keyEnvOption: string | undefined,
  environment: NodeJS.ProcessEnv,
  proxyOption?: string
): UpstreamConfig {
  const defaults = DEFAULTS[provider];
  const rawBase = baseUrlOption ?? defaults.baseUrl;
  if (rawBase === null) {
    throw new UsageRefusalError("--provider openai-compatible requires --base-url");
  }
  const url = parseBaseUrl(rawBase);
  const proxy = parseProxy(proxyOption, url);
  const ownHost = defaults.baseUrl !== null && new URL(defaults.baseUrl).host === url.host;
  if (keyEnvOption === undefined && (!ownHost || defaults.keyEnv === null)) {
    throw new UsageRefusalError(
      `--base-url ${url.host} is not ${provider}'s own host; name the key variable for it with --key-env, ` +
        "so a provider key is never sent to another host by default"
    );
  }
  const keyEnv = keyEnvOption ?? defaults.keyEnv!;
  if (!ENV_NAME_PATTERN.test(keyEnv)) {
    throw new UsageRefusalError(
      "--key-env takes the NAME of an environment variable, not a key; the key is never accepted on the command line"
    );
  }
  if (OAUTH_ENV_NAMES.has(keyEnv)) {
    throw new UsageRefusalError(
      `--key-env ${keyEnv} holds a subscription OAuth token; codemux complete is paid per-token API use and ` +
        "takes an API key only, so subscription quota stays with the harnesses"
    );
  }
  const apiKey = Object.hasOwn(environment, keyEnv) ? environment[keyEnv]?.trim() ?? "" : "";
  if (apiKey === "") {
    throw new UsageRefusalError(`${keyEnv} is not set; export the provider API key in that variable`);
  }
  // A key that cannot be an HTTP header value would make every request
  // fail with an error that quotes the header; refuse it here, unquoted.
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new UsageRefusalError(`the value of ${keyEnv} holds a space or control character, so it cannot be an API key header`);
  }
  const reason = oauthTokenReason(apiKey);
  if (reason !== null) {
    throw new UsageRefusalError(
      `refusing the value of ${keyEnv}: ${reason}. codemux complete is paid per-token API use and ` +
        "takes an API key only, so subscription quota stays with the harnesses"
    );
  }
  return {
    provider,
    wire: defaults.wire,
    baseUrl: url.href.replace(/\/+$/, ""),
    host: url.host,
    keyEnv,
    apiKey,
    proxy,
  };
}

/** The upstream request URL and headers for one call. */
export function upstreamRequest(config: UpstreamConfig): { url: string; headers: Record<string, string> } {
  if (config.wire === "anthropic") {
    return {
      url: `${config.baseUrl}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
  };
}
