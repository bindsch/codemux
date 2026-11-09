import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeOwnedSync } from "./fs-durable.js";
import { assertTrustedDirectory, prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { readProviderOverride, requireProviderOverride } from "./provider-override.js";
import { UsageRefusalError } from "./validation.js";
import type { RunContext } from "./run-context.js";
import { clineToolsNoneSettings } from "./cline-experiment-policy.js";
import type { ClineExperimentRun } from "./cline-experiment-run.js";

export const CLINE_PROVIDER = "codemux-override";
const MAX_SETTINGS_BYTES = 1024 * 1024;
export interface ClineConfig {
  home: string;
  configDir: string;
  env: Record<string, string>;
  finalize(): void;
}
export interface ClineRunContext extends RunContext { clineConfig?: ClineConfig; experimentCline?: ClineExperimentRun }
export interface ClineConfigOptions {
  model?: string;
  hermetic?: boolean;
  noWeb?: boolean;
  toolsNone?: boolean;
  sourceGlobalPath?: string;
  sourceMcpPath?: string;
  mcpServers?: Record<string, unknown>;
}

function readSettings(path: string): Record<string, unknown> {
  try {
    if (statSync(path).size > MAX_SETTINGS_BYTES) throw new Error("cline settings exceed the 1 MiB bound");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("cline settings must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("cline settings section must be an object");
  return value as Record<string, unknown>;
}

export function clineProvider(environment: NodeJS.ProcessEnv) {
  const override = readProviderOverride("cline", environment);
  return override === null ? null : requireProviderOverride("cline", override, ["baseUrl", "apiKey", "model"]);
}

// Cline cli-v3.0.74 (read 2026-11-09): ProviderSettingsSchema carries the endpoint,
// key, model, protocol, maxTokens and contextWindow; toProviderConfig maps the caps.
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/services/llms/provider-settings.ts#L142-L178
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/services/llms/provider-settings.ts#L248-L269
// The private file envelope is StoredProviderSettings, version 1:
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/types/provider-settings.ts#L52-L84
export function clineProviderFile(environment: NodeJS.ProcessEnv, model?: string): string {
  const override = clineProvider(environment);
  if (override === null) throw new UsageRefusalError("cline private provider settings require a provider override");
  return JSON.stringify({
    version: 1, lastUsedProvider: CLINE_PROVIDER, modes: {},
    providers: { [CLINE_PROVIDER]: {
      settings: {
        provider: CLINE_PROVIDER, model: model ?? override.model,
        apiKey: override.apiKey, baseUrl: override.baseUrl,
        protocol: "openai-chat", client: "openai-compatible",
        ...(override.maxOutputTokens === undefined ? {} : { maxTokens: override.maxOutputTokens }),
        ...(override.maxContextTokens === undefined ? {} : { contextWindow: override.maxContextTokens }),
      },
      updatedAt: new Date().toISOString(), tokenSource: "manual",
    } },
  });
}

export function createClineConfig(sourceDir: string, environment: NodeJS.ProcessEnv,
  options: ClineConfigOptions = {}): ClineConfig {
  const provider = clineProvider(environment);
  if (options.hermetic && provider === null) {
    throw new UsageRefusalError("cline --hermetic requires a provider override for the private configuration");
  }
  const parent = prepareRunDirParent(sourceDir, ".codemux-hermetic");
  const trusted = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, `run-${process.pid}-`));
  chmodSync(home, 0o700);
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(home, trusted, "the private cline configuration");
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);
  try {
    return { ...populateClineConfig(home, environment, {
      sourceGlobalPath: join(sourceDir, "data", "settings", "global-settings.json"),
      sourceMcpPath: join(sourceDir, "data", "settings", "cline_mcp_settings.json"), ...options,
    }), finalize };
  } catch (error) { finalize(); throw error; }
}

/** Populate a caller-owned private root; session lifecycle owns its removal. */
export function populateClineConfig(home: string, environment: NodeJS.ProcessEnv,
  options: ClineConfigOptions = {}): Omit<ClineConfig, "finalize"> {
    const provider = clineProvider(environment);
    if (options.hermetic && provider === null) throw new UsageRefusalError("cline --hermetic requires a provider override for the private configuration");
    const configDir = join(home, ".cline");
    assertTrustedDirectory(home);
    mkdirSync(configDir, { mode: 0o700, recursive: true });
    assertTrustedDirectory(configDir);
    chmodSync(configDir, 0o700);
    const env: Record<string, string> = {};
    // cli-v3.0.74 storage paths honor these file overrides (read 2026-11-09):
    // https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L431-L452
    if (provider !== null) {
      const path = join(configDir, "providers.json");
      writeOwnedSync(path, clineProviderFile(environment, options.model), 0o600);
      env.CLINE_PROVIDER_SETTINGS_PATH = path;
    }
    if (options.hermetic) {
      env.HOME = home;
      env.CLINE_DIR = configDir;
      env.CLINE_SESSION_BACKEND_MODE = "local";
      env.CLINE_HOOKS_DIR = join(configDir, "hooks");
      env.CLINE_HOOK_AGENT_RESUME = "";
      env.CLINE_HOOKS_LOG_PATH = join(configDir, "hooks.log");
      // Native sandbox setup rewrites the provider-file path. Isolation here
      // uses the explicit roots and local backend; codemux owns OS sandboxing.
      env.CLINE_SANDBOX = "0";
      env.CLINE_SANDBOX_DATA_DIR = join(configDir, "data");
      env.CLINE_DATA_DIR = join(configDir, "data");
      env.CLINE_GLOBAL_SETTINGS_PATH = join(configDir, "global-settings.json");
      env.CLINE_MCP_SETTINGS_PATH = join(configDir, "cline_mcp_settings.json");
      // Each override is stronger than CLINE_DATA_DIR; none may retain an operator path.
      for (const [name, child] of Object.entries({
        CLINE_SESSION_DATA_DIR: "sessions", CLINE_TEAM_DATA_DIR: "teams",
        CLINE_CONNECTOR_DATA_DIR: "connectors", CLINE_DB_DATA_DIR: "db",
        CLINE_CONNECTOR_SETTINGS_PATH: "connector-settings.json",
        CLINE_CONNECTORS_DB_PATH: "connectors.db", CLINE_CRON_DB_PATH: "cron.db",
        CLINE_TASKS_DB_PATH: "tasks.db",
      })) env[name] = join(configDir, child);
      // Alternate Documents discovery must stay in the private home too.
      for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) env[name] = home;
    }
    if (options.hermetic || options.noWeb || options.toolsNone) {
      let settings = options.hermetic || !options.sourceGlobalPath ? {} : readSettings(options.sourceGlobalPath);
      if (options.noWeb) {
        // Native web search and the ordinary fetch tool are separate channels.
        // cli-v3.0.74, read 2026-11-09:
        // https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/services/global-settings.ts#L358-L380
        const disabled = settings.disabledTools;
        if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some((name) => typeof name !== "string"))) {
          throw new Error("cline disabledTools must be an array of tool names");
        }
        settings.disabledTools = [...new Set([...(disabled as string[] | undefined ?? []), "fetch_web_content"])];
        settings.tools = { ...object(settings.tools), web_search: { enabled: false } };
      }
      if (options.toolsNone) settings = clineToolsNoneSettings(settings);
      env.CLINE_GLOBAL_SETTINGS_PATH = join(configDir, "global-settings.json");
      writeOwnedSync(env.CLINE_GLOBAL_SETTINGS_PATH, JSON.stringify(settings), 0o600);
    }
    if (options.hermetic || options.mcpServers || options.toolsNone) {
      const settings = options.hermetic || options.toolsNone || !options.sourceMcpPath ? {} : readSettings(options.sourceMcpPath);
      settings.mcpServers = { ...object(settings.mcpServers), ...options.mcpServers };
      env.CLINE_MCP_SETTINGS_PATH = join(configDir, "cline_mcp_settings.json");
      writeOwnedSync(env.CLINE_MCP_SETTINGS_PATH, JSON.stringify(settings), 0o600);
    }
    if (options.toolsNone) env.CLINE_SESSION_BACKEND_MODE = "local";
    return { home, configDir, env };
}
