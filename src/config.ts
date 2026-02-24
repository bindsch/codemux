import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import type { AgentId, CodemuxConfig, ModelMapping } from "./types.js";

const DEFAULT_CONFIG: CodemuxConfig = {
  defaultAgent: "claude",
  models: {
    sonnet: {
      claude: "claude-sonnet-4-5-20250929",
      droid: "claude-sonnet-4-5-20250929",
      codex: "claude-sonnet-4-5-20250929",
    },
    opus: {
      claude: "claude-opus-4-5-20251101",
      droid: "claude-opus-4-5-20251101",
    },
    haiku: {
      claude: "claude-haiku-4-5-20251001",
      droid: "claude-haiku-4-5-20251001",
    },
    "gpt5": {
      droid: "gpt-5.1",
      codex: "gpt-5.1",
    },
    "gpt5-codex": {
      droid: "gpt-5.1-codex",
      codex: "gpt-5.1-codex",
    },
    "gpt53": {
      droid: "gpt-5.3",
      codex: "gpt-5.3",
    },
    "gpt53-high": {
      droid: "gpt-5.3-high",
      codex: "gpt-5.3-high",
    },
    "gemini-pro": {
      droid: "gemini-3-pro-preview",
      gemini: "gemini-3-pro",
    },
    "gemini-flash": {
      droid: "gemini-3-flash-preview",
      gemini: "gemini-3-flash",
    },
  },
};

function getConfigPath(): string {
  return join(homedir(), ".config", "codemux", "config.yaml");
}

export function loadConfig(): CodemuxConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = yaml.load(content) as Partial<CodemuxConfig>;

    return {
      defaultAgent: userConfig.defaultAgent || DEFAULT_CONFIG.defaultAgent,
      models: {
        ...DEFAULT_CONFIG.models,
        ...userConfig.models,
      },
    };
  } catch {
    console.warn(`Warning: Could not load config from ${configPath}, using defaults`);
    return DEFAULT_CONFIG;
  }
}

export function resolveModel(
  model: string,
  agentId: AgentId,
  config: CodemuxConfig
): string {
  const mapping = config.models[model];
  if (mapping && mapping[agentId]) {
    return mapping[agentId];
  }
  return model;
}

export function getDefaultConfig(): CodemuxConfig {
  return DEFAULT_CONFIG;
}
