import { existsSync } from "fs";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import { AGENT_IDS } from "./types.js";
import type { AgentId, CodemuxConfig, ModelMapping } from "./types.js";
import { readUtf8FileBounded } from "./file-io.js";
import { validateModelName } from "./validation.js";

const DEFAULT_CONFIG: CodemuxConfig = {
  defaultAgent: "claude",
  models: {
    sonnet: {
      claude: "sonnet",
      droid: "claude-sonnet-5",
      copilot: "claude-sonnet-5",
      cursor: "claude-sonnet-5-high",
    },
    opus: {
      claude: "opus",
      droid: "claude-opus-5",
      copilot: "claude-opus-4.8",
      cursor: "claude-opus-5-high",
    },
    haiku: {
      claude: "haiku",
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
      droid: "gemini-3.5-flash",
      gemini: "gemini-3.6-flash",
      copilot: "gemini-3.6-flash",
      cursor: "gemini-3.6-flash-high",
    },
  },
};

const MAX_CONFIG_BYTES = 1024 * 1024;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
      (key) => key !== "defaultAgent" && key !== "models"
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

    return {
      defaultAgent,
      models,
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
      throw new ConfigError(
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
