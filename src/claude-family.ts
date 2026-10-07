import { isAbsolute } from "node:path";

/**
 * What the `claude` and `zai` adapters share: they run the same binary, so
 * a rule about its environment belongs to both, in one place neither
 * adapter imports from the other.
 */

/**
 * The gateway environment the claude binary reads for an
 * Anthropic-compatible endpoint: the credential rides
 * `ANTHROPIC_AUTH_TOKEN` — never `ANTHROPIC_API_KEY`, which the binary
 * treats as an API-key billing switch rather than a bearer token — and the
 * endpoint as `ANTHROPIC_BASE_URL`, which must serve the Anthropic
 * Messages API (`/v1/messages`). Z.AI's fixed gateway rides it (the
 * original mechanism) and claude's provider override rides it with the
 * operator's endpoint; the token wins over the on-disk login in both.
 */
export function claudeGatewayEnv(apiKey: string, baseUrl: string): Record<string, string> {
  return { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_BASE_URL: baseUrl };
}

/**
 * The operator-login variables a gateway run must not also carry: the
 * token above is the credential, and a stray API key or OAuth token would
 * give the child a second, operator-funded authentication path codemux
 * never chose. Composed into each adapter's `getEnvOmissions`.
 */
export function claudeGatewayOmissions(): readonly string[] {
  return ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
}

/**
 * Refuses a passed-through `CLAUDE_CONFIG_DIR` that is relative, or one
 * with surrounding whitespace. Claude Code resolves the variable against
 * the child's working directory, so a relative value lands the config
 * store (and the user settings source) somewhere that depends on `--cwd`
 * -- two runs with the same pass-through but different working directories
 * would then read and write different stores, and codemux could not say
 * where the harness's state lives. The adapter pins no
 * `CLAUDE_CONFIG_DIR` itself, so the value is the parent environment's; an
 * unset value or the literal empty string means no redirect and is left
 * alone. The check reads the value exactly as the child receives it: the
 * installed Claude binary does not trim the variable, so `" /var/profile"`
 * is relative at launch and validating a trimmed copy would wave it
 * through (round10), while an absolute value with padding -- `"/var/x "`
 * -- stays absolute but names a directory the padding is part of, which is
 * never what the operator meant (round13: the checks now refuse every
 * padded shape the docs already promised they did). The run and TUI
 * boundaries both call this, before any launch.
 */
export function assertAbsoluteClaudeConfigDir(
  passthroughEnv: readonly string[] | undefined,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (!passthroughEnv?.includes("CLAUDE_CONFIG_DIR")) return;
  const configured = environment.CLAUDE_CONFIG_DIR;
  if (configured === undefined || configured === "") return;
  if (!isAbsolute(configured)) {
    throw new Error(
      `CLAUDE_CONFIG_DIR must be an absolute path when passed through; ` +
        `'${configured}' is relative, and the harness would resolve it ` +
        "against the run's working directory, so codemux cannot say where " +
        "the config store it shares with Claude lands"
    );
  }
  if (configured.trim() !== configured) {
    throw new Error(
      `CLAUDE_CONFIG_DIR must not be whitespace-padded when passed through; ` +
        `'${configured}' carries leading or trailing whitespace, and the ` +
        "harness reads the variable without trimming, so the config store " +
        "would live in a directory whose name still carries the padding"
    );
  }
}
