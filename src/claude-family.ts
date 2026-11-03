import { isAbsolute, join } from "node:path";
import { UsageRefusalError } from "./validation.js";

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
  return { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_BASE_URL: normalizeAnthropicBaseUrl(baseUrl) };
}

/**
 * The claude binary appends `/v1/messages` to `ANTHROPIC_BASE_URL` itself,
 * so a base URL in the OpenAI-style `.../v1` form every other override
 * takes produces `/v1/v1/messages`, which the endpoint answers 404 and the
 * binary reports as `model_not_found` before the operator sees a request
 * (observed live against vLLM with 2.1.280). One trailing `/v1` (with or
 * without a trailing slash) is therefore stripped; every other path, such
 * as a gateway's `/api/anthropic`, is kept as given.
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  // Only the pathname is examined: a host literally named `v1`
  // (`http://v1`) and a query or fragment are left alone, and an URL the
  // parser refuses is passed through for the override validation to
  // report (review 0.13.5).
  let url: URL;
  try { url = new URL(baseUrl); } catch { return baseUrl; }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path.slice(0, -"/v1".length) : path;
  const text = url.toString();
  // `new URL("http://host/").toString()` keeps a root slash; the host root
  // is returned bare, so the binary's own `/v1/messages` follows it.
  return url.pathname === "/" && !url.search && !url.hash ? text.replace(/\/$/, "") : text;
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
 * The catalog id a provider-override model behaves as. Claude Code
 * validates `--model` against its own model catalog before any request
 * leaves the client, and a provider-format id (`clawvm-…`, a gateway
 * name) is not in it: 2.1.280 answers "There's an issue with the selected
 * model (<id>)" — the run dies client-side, zero requests reaching the
 * endpoint. The binary's own rejection names the remedy ("map it with
 * behavesAs on a modelPicker row"), and its settings schema pins the row
 * shape `{ model, label?, description?, behavesAs? }` and the semantics:
 * behavesAs is "the ID of a model it does know … whose client-side
 * handling — prompt profile, capability and effort defaults — applies to
 * it. Changes neither the row's label nor the model ID sent." Sonnet is
 * the tier an arbitrary coding model should be assumed to carry (the
 * catalog id, not the alias: the field takes full ids like
 * "claude-opus-4-8", and `claude-sonnet-5` is in the 2.1.280 catalog).
 */
export const CLAUDE_PROVIDER_BEHAVES_AS = "claude-sonnet-5";

/**
 * The `--settings` payload that lets the binary accept the override's
 * model: one modelPicker row mapping it onto the behavesAs tier above.
 * The wire model id is unchanged — the id must be what the endpoint
 * serves; the tier is only what the client assumes. Rides argv as inline
 * `--settings` JSON (the flag accepts a JSON string starting with `{`,
 * the same carrier `--mcp-config` uses), so nothing lands on disk and
 * the mapping lives exactly as long as the launch. flagSettings outrank
 * user settings, and a modelPicker definition wins outright across
 * sources, so an operator's own picker rows cannot override the
 * endpoint's model under an override run.
 */
export function claudeProviderPickerSettings(model: string): string {
  return JSON.stringify({
    modelPicker: {
      options: [{ model, behavesAs: CLAUDE_PROVIDER_BEHAVES_AS }],
    },
  });
}

/** The model ids the binary's own catalog accepts without help: the three
 * aliases and every full `claude-*` id. Everything else — a provider-format
 * id such as `glm-5.3`, or any gateway name — needs the picker settings
 * above or the 2.1.280+ catalog check rejects it client-side. Shared by
 * both adapters and the session builder, so the rule lives once. */
const CLAUDE_CATALOG_MODEL = /^(?:opus|sonnet|haiku|claude-.+)$/;

export function claudeModelNeedsPickerSettings(model: string): boolean {
  return !CLAUDE_CATALOG_MODEL.test(model);
}

/** The model argv every claude-family launch shares: `--model`, plus the
 * picker `--settings` exactly when the id needs them (the predicate
 * above). `opus`, the family default, carries none. */
export function claudeModelArgv(model: string): string[] {
  return claudeModelNeedsPickerSettings(model)
    ? ["--model", model, "--settings", claudeProviderPickerSettings(model)]
    : ["--model", model];
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
    throw new UsageRefusalError(
      `CLAUDE_CONFIG_DIR must be an absolute path when passed through; ` +
        `'${configured}' is relative, and the harness would resolve it ` +
        "against the run's working directory, so codemux cannot say where " +
        "the config store it shares with Claude lands"
    );
  }
  if (configured.trim() !== configured) {
    throw new UsageRefusalError(
      `CLAUDE_CONFIG_DIR must not be whitespace-padded when passed through; ` +
        `'${configured}' carries leading or trailing whitespace, and the ` +
        "harness reads the variable without trimming, so the config store " +
        "would live in a directory whose name still carries the padding"
    );
  }
}

/**
 * What the CHILD Claude sees that shapes an oversize-result spill, for the
 * experiment bridge's check: its config directory, a project-directory
 * override, its MCP output token limit, and its MCP truncation prompt
 * choice. HOME is inherited by every child (environment.ts INERT_ENV),
 * while an ambient CLAUDE_CONFIG_DIR, CLAUDE_CODE_PROJECT_DIR_NAME,
 * MAX_MCP_OUTPUT_TOKENS, or MCP_TRUNCATION_PROMPT_OVERRIDE reaches it only
 * under --pass-env. The binary parses the token limit as its environment
 * integers (trimmed; an exponent form, a grouped form such as 4,000, else
 * parseInt; positive). The
 * 2.1.300 binary honors the project-directory override, only alongside a
 * CLAUDE_CONFIG_DIR, when it matches /^[A-Za-z0-9_-]{1,64}$/ and is not a
 * reserved Windows device name, and trims the prompt override. configDir
 * is undefined when nothing names one, or when a passed-through
 * CLAUDE_CONFIG_DIR is empty (the binary keeps the empty root and places
 * projects relative to its cwd); the bridge then rejects spills. A
 * prepared --experiment-project-settings run passes its private config
 * directory as configDirOverride, which counts as the child's config root
 * exactly as a passed-through one does.
 */
export interface ClaudeChildProject { configDir?: string; projectDirName?: string; tokenLimit?: number; truncationPrompt?: string }
export function claudeChildProject(environment: NodeJS.ProcessEnv, passthroughEnv: readonly string[] = [], configDirOverride?: string): ClaudeChildProject {
  const passed = (name: string) => (passthroughEnv.includes(name) ? environment[name] : undefined);
  const passedConfigDir = passed("CLAUDE_CONFIG_DIR");
  const configDir = configDirOverride ?? (passedConfigDir === undefined ? (environment.HOME ? join(environment.HOME, ".claude") : undefined) : passedConfigDir || undefined);
  // The binary applies the override only together with a CLAUDE_CONFIG_DIR;
  // with the default config directory it keeps the cwd slug. The private
  // directory of a project-settings run is delivered as one, so a
  // passed-through name would relocate state inside it.
  const override = configDirOverride !== undefined || passed("CLAUDE_CONFIG_DIR")
    ? passed("CLAUDE_CODE_PROJECT_DIR_NAME") : undefined;
  const projectDirName = override && /^[A-Za-z0-9_-]{1,64}$/.test(override) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(override) ? override : undefined;
  const limit = claudeEnvironmentInteger(passed("MAX_MCP_OUTPUT_TOKENS"));
  const tokenLimit = limit !== undefined && limit > 0 ? limit : undefined;
  const truncationPrompt = passed("MCP_TRUNCATION_PROMPT_OVERRIDE")?.trim() || undefined;
  return { configDir, projectDirName, tokenLimit, truncationPrompt };
}

/** Claude Code's oversize-result messages end the spill path at a line break,
 * so an experiment run needs its config root without one: a passed-through
 * CLAUDE_CONFIG_DIR (the binary keeps even an empty one as its root), or
 * else HOME, under which .claude lies. */
export function assertExperimentConfigRootSingleLine(environment: NodeJS.ProcessEnv, passthroughEnv: readonly string[] = []): void {
  const configured = passthroughEnv.includes("CLAUDE_CONFIG_DIR") ? environment.CLAUDE_CONFIG_DIR : undefined;
  const [name, value] = configured !== undefined ? ["CLAUDE_CONFIG_DIR", configured] : ["HOME", environment.HOME];
  if (value?.includes("\n")) {
    throw new Error(`--experiment-mcp needs a ${name} without a line break: Claude Code's oversize-result ` +
      "messages end the spill path at a line break, so such a path could not be verified");
  }
}

/** Claude Code 2.1.300's environment integer: trimmed, then an exponent form,
 * a grouped form (one separator kind: _ , NBSP NNBSP space), or parseInt. */
export function claudeEnvironmentInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  let parsed: number;
  if (text.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(text)) {
    const exponent = Number(text);
    parsed = Number.isInteger(exponent) ? exponent : NaN;
  } else if (text.length <= 32 && /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/.test(text)) {
    parsed = parseInt(text.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  } else parsed = parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
