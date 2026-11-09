import { readProviderOverride, requireProviderOverride, type ProviderOverride } from "./provider-override.js";
import { UsageRefusalError } from "./validation.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCopilotHermeticHome } from "./copilot-hermetic.js";

/** Installed @github/copilot 1.0.103, copilot.tgz/package/cli-main.js,
 * help environment/providers (read 2026-11-09): BASE_URL activates BYOK;
 * TYPE=openai selects OpenAI-compatible endpoints; MODEL names the model;
 * MAX_OUTPUT_TOKENS overrides the catalog output limit. MAX_PROMPT_TOKENS
 * is a prompt budget, not the total context-window setting. */
export function copilotProvider(environment: NodeJS.ProcessEnv): ProviderOverride | null {
  const provider = readProviderOverride("copilot", environment);
  if (provider === null) return null;
  requireProviderOverride("copilot", provider, ["baseUrl", "model"]);
  return provider;
}

export interface CopilotProviderFile {
  path: string;
  modelId: string;
  finalize(): void;
}

export function copilotProviderConfiguration(provider: ProviderOverride, selectedModel?: string) {
  const model = selectedModel ?? provider.model;
  if (model === undefined || provider.baseUrl === undefined) {
    throw new UsageRefusalError("copilot provider configuration requires an endpoint and model");
  }
  return {
    providers: [{ name: "codemux", type: "openai", baseUrl: provider.baseUrl,
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }) }],
    models: [{ id: "model", provider: "codemux", wireModel: model, modelId: model,
      ...(provider.maxContextTokens === undefined ? {} : { maxContextWindowTokens: provider.maxContextTokens }),
      ...(provider.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.maxOutputTokens }) }],
  };
}

/** The 1.0.85/1.0.103 generated/rpc.d.ts NamedProviderConfig and ProviderModelConfig
 * define these fields. cli-main.js providerContextResolve reads providers.json;
 * model.maxContextWindowTokens is the total window, unlike MAX_PROMPT_TOKENS
 * (installed source read 2026-11-09). */
export function createCopilotProviderFile(
  configDir: string,
  provider: ProviderOverride,
  selectedModel?: string
): CopilotProviderFile {
  const scratch = createCopilotHermeticHome(configDir, { printOnly: true });
  try {
    const path = join(scratch.home, "providers.json");
    writeFileSync(path, JSON.stringify(copilotProviderConfiguration(provider, selectedModel)), { flag: "wx", mode: 0o600 });
    return { path, modelId: "codemux/model", finalize: scratch.finalize };
  } catch (error) {
    scratch.finalize();
    throw error;
  }
}

export function copilotProviderEnv(
  environment: NodeJS.ProcessEnv,
  model?: string
): Record<string, string> {
  const provider = copilotProvider(environment);
  if (provider === null) return {};
  return {
    COPILOT_PROVIDER_BASE_URL: provider.baseUrl!,
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_MODEL: model ?? provider.model!,
    ...(provider.apiKey === undefined ? {} : { COPILOT_PROVIDER_API_KEY: provider.apiKey }),
    ...(provider.maxOutputTokens === undefined ? {} : {
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(provider.maxOutputTokens),
    }),
  };
}

/** Native bearer tokens and key commands override API_KEY. Explicit BYOK
 * owns routing and authentication even when a conflicting native setting
 * was passed through. No credential is placed in argv or an error. */
export function copilotProviderOmissions(environment: NodeJS.ProcessEnv): string[] {
  const provider = copilotProvider(environment);
  if (provider === null) return [];
  return [
    "COPILOT_PROVIDER_API_KEY_COMMAND", "COPILOT_PROVIDER_BEARER_TOKEN",
    "COPILOT_PROVIDER_GHES_HOST", "COPILOT_PROVIDER_GHES_TOKEN",
    "COPILOT_PROVIDER_WIRE_MODEL", "COPILOT_PROVIDER_MODEL_ID",
    "COPILOT_PROVIDER_MODEL_LIMITS_ID", "COPILOT_PROVIDER_HEADERS",
    "COPILOT_PROVIDER_WIRE_API", "COPILOT_PROVIDER_TRANSPORT",
    "COPILOT_PROVIDER_MAX_PROMPT_TOKENS", "COPILOT_PROVIDERS_CONFIG",
    ...(provider.apiKey === undefined ? ["COPILOT_PROVIDER_API_KEY"] : []),
    ...(provider.maxOutputTokens === undefined ? ["COPILOT_PROVIDER_MAX_OUTPUT_TOKENS"] : []),
  ];
}
