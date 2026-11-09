import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "../run-context.js";
import type { RunRequest } from "../types.js";
import type { ProviderOverride } from "../provider-override.js";
import { readUtf8FileBounded } from "../file-io.js";
import { writeOwnedSync } from "../fs-durable.js";
import { GEMINI_MAX_SETTINGS_BYTES, geminiSettingsWithOutputLimit } from "../gemini-settings.js";
import { writeGeminiToolPolicy } from "../gemini-policy.js";
import { UsageRefusalError } from "../validation.js";

export interface GeminiTurnSettings {
  geminiHome?: string;
  geminiPolicyPath?: string;
}

/** Per-turn settings for the shared launcher's persistent session home.
 * The private home is shared across turns and resume; only requested
 * settings are copied into it, never the operator's customization. */
export function prepareGeminiSessionSettings(input: {
  request: RunRequest;
  prepared: RunContext;
  privateHome: string | null;
  override: ProviderOverride | null;
  permissionPolicy?: string;
  callerOwned?: boolean;
}): GeminiTurnSettings {
  const { request, prepared, privateHome, override } = input;
  const home = privateHome ?? prepared.geminiHermeticHome?.home;
  if (home === undefined) return {};
  const directory = join(home, ".gemini");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UsageRefusalError("gemini session settings directory must be a real private directory");
  }
  const path = join(directory, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readUtf8FileBounded(path, {
      maxBytes: GEMINI_MAX_SETTINGS_BYTES, label: "private gemini session settings", noFollow: true,
    }));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new UsageRefusalError("private gemini session settings must contain an object");
    }
    settings = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (request.tools === "none") settings.tools = { core: [], exclude: ["*"] };
  else if (privateHome !== null && !input.callerOwned) delete settings.tools;
  if (override?.maxOutputTokens !== undefined) {
    const model = request.model ?? override.model;
    if (model === undefined) throw new UsageRefusalError("gemini output token cap requires a model");
    settings = geminiSettingsWithOutputLimit(settings, model, override.maxOutputTokens);
  }
  if (request.enablePlaywrightMcp) {
    const check = prepared.playwrightMcpCheck;
    if (!check) throw new UsageRefusalError("gemini Playwright session settings require an executable check");
    settings.mcpServers = { ...(input.callerOwned ? settings.mcpServers as object : {}), playwright: { command: check.path, args: [] } };
  }
  if (!input.callerOwned || request.tools === "none" || override?.maxOutputTokens !== undefined || request.enablePlaywrightMcp) {
    writeOwnedSync(path, JSON.stringify(settings), 0o600);
  }
  const policy = writeGeminiToolPolicy(home, {
    tools: input.permissionPolicy === "deny" ? "none" : request.tools,
    web: request.web,
  });
  return { geminiHome: home, ...(policy === null ? {} : { geminiPolicyPath: policy }) };
}
