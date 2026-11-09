import { claudeGatewayEnv } from "./claude-family.js";
import { readProviderOverride, requireProviderOverride, type ProviderOverride } from "./provider-override.js";
import { UsageRefusalError } from "./validation.js";

type ClaudeAgent = "claude" | "zai";
type ClaudeProvider = ProviderOverride & { baseUrl: string; apiKey: string };

/** Both identities run Claude Code and use its Anthropic Messages API transport. */
export function validatedClaudeProvider(agent: ClaudeAgent, environment: NodeJS.ProcessEnv): ClaudeProvider | null {
  const override = readProviderOverride(agent, environment);
  return override === null ? null : requireProviderOverride(agent, override, ["baseUrl", "apiKey"]) as ClaudeProvider;
}

export function claudeProviderModel(agent: ClaudeAgent, model: string | undefined, override: ClaudeProvider | null): string | undefined {
  const resolved = model ?? override?.model;
  if (resolved === undefined && override !== null) {
    throw new UsageRefusalError(
      `${agent} needs a model for the provider override; pass --model or set CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`);
  }
  return resolved;
}

/** Read-only bundle audit, 2026-11-09: Claude Code 2.1.317,
 * /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe.
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL select the transport (bytes
 * 253069813 and 253112356); LIn at 256461353 applies the output-token env.
 * nA at 256459812 uses the context-token env for an uncataloged model.
 * Both the claude and zai identities execute this exact binary. */
export function claudeProviderEnv(override: ClaudeProvider | null): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
  if (override === null) return env;
  Object.assign(env, claudeGatewayEnv(override.apiKey, override.baseUrl));
  if (override.model !== undefined) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = override.model;
    env.ANTHROPIC_SMALL_FAST_MODEL = override.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = override.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = override.model;
  }
  if (override.maxOutputTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(override.maxOutputTokens);
  if (override.maxContextTokens !== undefined) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(override.maxContextTokens);
  return env;
}
