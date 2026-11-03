import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import { AGENT_IDS } from "./types.js";
import type {
  AgentId,
  CodemuxConfig,
  ModelMapping,
  QuotaPolicy,
  QuotaTimeoutMap,
} from "./types.js";
import { readUtf8FileBounded } from "./file-io.js";
import { MAX_USAGE_TIMEOUT_SECONDS } from "./usage.js";
import { UsageRefusalError, validateModelName } from "./validation.js";

// The quota gate's defaults: an absent key means the gate is on with these
// (installing usagemux turns it on; without it the gate warns and proceeds).
// The timeout is 60 s because the slowest measured client (claude) answered
// in 31 s; at the old 15 s the gate warned and proceeded on every claude
// launch, protecting nothing (audit round 2, B2).
export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  minRemainingPercent: 10,
  weeklyWarnUsedPercent: 50,
  timeoutSeconds: 60,
};

const DEFAULT_CONFIG: CodemuxConfig = {
  defaultAgent: "claude",
  models: {
    sonnet: {
      claude: "sonnet",
      zai: "sonnet",
      droid: "claude-sonnet-5",
      copilot: "claude-sonnet-5",
      cursor: "claude-sonnet-5-high",
    },
    opus: {
      claude: "opus",
      zai: "opus",
      droid: "claude-opus-5",
      copilot: "claude-opus-4.8",
      cursor: "claude-opus-5-high",
    },
    haiku: {
      claude: "haiku",
      zai: "haiku",
      droid: "claude-haiku-4-5-20251001",
      copilot: "claude-haiku-4.5",
    },
    "gpt5": {
      droid: "gpt-5.6-sol",
      codex: "gpt-5.6",
      copilot: "gpt-5.6-sol",
      cursor: "gpt-5.6-sol-medium",
    },
    "gpt5-codex": {
      droid: "gpt-5.3-codex",
      codex: "gpt-5.3-codex",
      copilot: "gpt-5.3-codex",
      cursor: "gpt-5.3-codex",
    },
    "gpt53": {
      droid: "gpt-5.3-codex",
      codex: "gpt-5.3-codex",
      copilot: "gpt-5.3-codex",
      cursor: "gpt-5.3-codex",
    },
    "gemini-pro": {
      droid: "gemini-3.1-pro-preview",
      gemini: "gemini-3.1-pro-preview",
      copilot: "gemini-3.1-pro-preview",
      cursor: "gemini-3.1-pro",
    },
    "gemini-flash": {
      // One flash model per alias, 3.6 everywhere (droid's installed
      // catalog serves gemini-3.6-flash; it pinned 3.5 through 0.11
      // while the rest of the table had moved on).
      droid: "gemini-3.6-flash",
      gemini: "gemini-3.6-flash",
      copilot: "gemini-3.6-flash",
      cursor: "gemini-3.6-flash-high",
    },
  },
  quota: DEFAULT_QUOTA_POLICY,
};

const MAX_CONFIG_BYTES = 1024 * 1024;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Parses the `quota` key: `false` disables the gate globally; a mapping
 * overrides the defaults per field; anything else is a configuration
 * error. The two percentages are finite numbers from 0 to 100; the timeout
 * is an integer number of seconds from 1 to 300, either one number or a
 * per-agent map ({default: 60, claude: 90}) — the gate passes it to the
 * process runner as milliseconds, and 0 or a fraction would make that
 * runner's own validation fire inside the gate's fail-open catch. */
function parseQuotaConfig(value: unknown): QuotaPolicy | false {
  if (value === undefined) return { ...DEFAULT_QUOTA_POLICY };
  if (value === false) return false;
  if (!isRecord(value)) {
    throw new ConfigError(
      "'quota' must be false or a mapping of quota gate settings"
    );
  }
  const unknownKeys = Object.keys(value).filter(
    (key) =>
      key !== "minRemainingPercent" &&
      key !== "weeklyWarnUsedPercent" &&
      key !== "timeoutSeconds" &&
      key !== "spendsFrom"
  );
  if (unknownKeys.length > 0) {
    throw new ConfigError(
      `unknown quota setting${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
    );
  }
  const policy: QuotaPolicy = { ...DEFAULT_QUOTA_POLICY };
  for (const key of ["minRemainingPercent", "weeklyWarnUsedPercent"] as const) {
    const setting = value[key];
    if (setting === undefined) continue;
    if (
      typeof setting !== "number" ||
      !Number.isFinite(setting) ||
      setting < 0 ||
      setting > 100
    ) {
      throw new ConfigError(`quota ${key} must be a number from 0 to 100`);
    }
    policy[key] = setting;
  }
  const timeoutSeconds = parseQuotaTimeoutSeconds(value.timeoutSeconds);
  if (timeoutSeconds !== undefined) policy.timeoutSeconds = timeoutSeconds;
  const spendsFrom = parseQuotaSpendsFrom(value.spendsFrom);
  if (spendsFrom !== undefined) policy.spendsFrom = spendsFrom;
  return policy;
}

/** One timeout number, or a per-agent map whose `default` key covers the
 * agents the map does not name. An empty map and a map without a default
 * (when some agent is unnamed) are refused: both would silently fall back
 * mid-gate. */
function parseQuotaTimeoutSeconds(value: unknown): QuotaPolicy["timeoutSeconds"] | undefined {
  if (value === undefined) return undefined;
  const bounds = `an integer from 1 to ${MAX_USAGE_TIMEOUT_SECONDS}`;
  const checkEntry = (key: string, seconds: unknown): number => {
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > MAX_USAGE_TIMEOUT_SECONDS
    ) {
      throw new ConfigError(
        `quota timeoutSeconds${key === "default" ? "" : ` for ${key}`} must be ${bounds}`
      );
    }
    return seconds;
  };
  if (typeof value === "number") return checkEntry("default", value);
  if (!isRecord(value)) {
    throw new ConfigError(
      `quota timeoutSeconds must be ${bounds} or a per-agent mapping of those integers`
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || value.default === undefined) {
    throw new ConfigError(
      "quota timeoutSeconds mapping must name a default (and at least one agent when it maps per agent); set one number instead for a single value"
    );
  }
  const map: QuotaTimeoutMap = {};
  for (const [key, seconds] of entries) {
    if (key !== "default" && !(AGENT_IDS as readonly string[]).includes(key)) {
      throw new ConfigError(`unknown quota timeoutSeconds agent '${key}'`);
    }
    map[key] = checkEntry(key, seconds);
  }
  return map;
}

/** `quota.spendsFrom`: agent id to usagemux client (opencode: claude), so
 * the gate measures the account the run spends from when the harness's
 * own client cannot. */
function parseQuotaSpendsFrom(
  value: unknown
): Partial<Record<AgentId, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ConfigError(
      "quota spendsFrom must be a mapping of agent ids to usagemux client names"
    );
  }
  const mapped: Partial<Record<AgentId, string>> = {};
  for (const [agentId, client] of Object.entries(value)) {
    if (!(AGENT_IDS as readonly string[]).includes(agentId)) {
      throw new ConfigError(`unknown quota spendsFrom agent '${agentId}'`);
    }
    // usagemux client names are agent ids; an unknown name would reach
    // usagemux, come back unreadable, and let the gate proceed (review 41).
    if (typeof client !== "string" || !(AGENT_IDS as readonly string[]).includes(client)) {
      throw new ConfigError(
        `quota spendsFrom for ${agentId} must name a usagemux client (one of ${AGENT_IDS.join(", ")})`
      );
    }
    mapped[agentId as AgentId] = client;
  }
  return mapped;
}

export class ConfigError extends Error {}

export function getConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackHome = homedir()
): string {
  const configuredHome = environment.HOME || environment.USERPROFILE;
  const safeFallbackHome = isAbsolute(fallbackHome) ? fallbackHome : homedir();
  const home = configuredHome && isAbsolute(configuredHome)
    ? configuredHome
    : safeFallbackHome;
  const xdgConfigHome = environment.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : join(home, ".config");
  return join(configHome, "codemux", "config.yaml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneModels(models: CodemuxConfig["models"]): CodemuxConfig["models"] {
  const cloned: CodemuxConfig["models"] = Object.create(null) as CodemuxConfig["models"];
  for (const [alias, mapping] of Object.entries(models)) {
    cloned[alias] = { ...mapping };
  }
  return cloned;
}

function cloneConfig(config: CodemuxConfig): CodemuxConfig {
  return {
    defaultAgent: config.defaultAgent,
    models: cloneModels(config.models),
    quota: config.quota === false ? false : { ...config.quota },
  };
}

function mergeModelMappings(
  defaults: CodemuxConfig["models"],
  userModels: unknown
): CodemuxConfig["models"] {
  const merged = cloneModels(defaults);
  if (userModels === undefined) {
    return merged;
  }
  if (!isRecord(userModels)) {
    throw new ConfigError("'models' must be a mapping of aliases to agent model names");
  }

  for (const [alias, mapping] of Object.entries(userModels)) {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ConfigError(`invalid model alias '${alias}'`);
    }
    if (!isRecord(mapping)) {
      throw new ConfigError(`model alias '${alias}' must contain an agent mapping`);
    }

    const next: ModelMapping = {
      ...(defaults[alias] ?? {}),
    };
    for (const [agentId, modelName] of Object.entries(mapping)) {
      if (!(AGENT_IDS as readonly string[]).includes(agentId)) {
        throw new ConfigError(`model alias '${alias}' references unknown agent '${agentId}'`);
      }
      let validatedModelName: string;
      try {
        validatedModelName = validateModelName(modelName);
      } catch {
        throw new ConfigError(
          `model alias '${alias}' has an invalid model name for '${agentId}'`
        );
      }
      next[agentId as AgentId] = validatedModelName;
    }
    merged[alias] = next;
  }

  return merged;
}

export function loadConfig(configPathOverride?: string): CodemuxConfig {
  const configPath = configPathOverride ?? getConfigPath();

  if (!existsSync(configPath)) {
    return cloneConfig(DEFAULT_CONFIG);
  }

  try {
    const content = readUtf8FileBounded(configPath, {
      maxBytes: MAX_CONFIG_BYTES,
      label: "configuration",
    });
    const parsed = yaml.load(content);
    if (parsed !== undefined && !isRecord(parsed)) {
      throw new ConfigError("configuration root must be a mapping");
    }
    const userConfig = parsed ?? {};
    const unknownKeys = Object.keys(userConfig).filter(
      (key) => key !== "defaultAgent" && key !== "models" && key !== "quota"
    );
    if (unknownKeys.length > 0) {
      throw new ConfigError(
        `unknown configuration key${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
      );
    }

    const configuredDefaultAgent = userConfig.defaultAgent;
    let defaultAgent = DEFAULT_CONFIG.defaultAgent;
    if (configuredDefaultAgent !== undefined) {
      if (
        typeof configuredDefaultAgent === "string" &&
        (AGENT_IDS as readonly string[]).includes(configuredDefaultAgent)
      ) {
        defaultAgent = configuredDefaultAgent as AgentId;
      } else {
        throw new ConfigError(
          `invalid defaultAgent '${String(configuredDefaultAgent)}'`
        );
      }
    }

    const models = mergeModelMappings(DEFAULT_CONFIG.models, userConfig.models);
    const quota = parseQuotaConfig(userConfig.quota);

    return {
      defaultAgent,
      models,
      quota,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Could not load config from ${configPath}: ${message}`);
  }
}

export function resolveModel(
  model: string,
  agentId: AgentId,
  config: CodemuxConfig
): string {
  validateModelName(model);
  const mapping = config.models[model];
  if (mapping) {
    const resolved = mapping[agentId];
    if (!resolved) {
      // A caller mistake about the request (an alias the chosen agent has no
      // mapping for), not a configuration fault: exit 64 like every other
      // pre-launch refusal (review round 21, contracts-2).
      throw new UsageRefusalError(
        `model alias '${model}' is not configured for agent '${agentId}'`
      );
    }
    return validateModelName(resolved);
  }
  return validateModelName(model);
}

export function getDefaultConfig(): CodemuxConfig {
  return cloneConfig(DEFAULT_CONFIG);
}
