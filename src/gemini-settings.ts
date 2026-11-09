import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { UsageRefusalError } from "./validation.js";
import { readUtf8FileBounded } from "./file-io.js";

export const GEMINI_MAX_SETTINGS_BYTES = 1024 * 1024;

type Settings = Record<string, unknown>;

function object(value: unknown): Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Settings : {};
}

/** Preserve plain-run customization while replacing only the settings
 * file. Links keep the harness's existing session store and integrations.
 * The private directory itself must never link back into its own parent. */
export function inheritGeminiSettings(source: string, destination: string, printOnly: boolean): Settings {
  // Gemini writes transcripts below tmp. Keep that store stable even when
  // the first run creates it after the mirror was prepared.
  if (!printOnly) mkdirSync(join(source, "tmp"), { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "settings.json" || entry.name === ".codemux-hermetic") continue;
    if (printOnly && ["oauth_creds.json", "google_accounts.json"].includes(entry.name)) continue;
    symlinkSync(join(source, entry.name), join(destination, entry.name));
  }
  let text: string;
  try {
    text = readUtf8FileBounded(join(source, "settings.json"), {
      maxBytes: GEMINI_MAX_SETTINGS_BYTES, label: "gemini operator settings",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = Bun.JSONC.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageRefusalError("gemini settings.json must contain an object");
  }
  return value as Settings;
}

/** Native output cap carrier. Gemini 0.60.0 loadCliConfig passes
 * settings.modelConfigs to ModelConfigService; customOverrides are merged
 * into generateContentConfig, including maxOutputTokens (bundle
 * gemini-LUNNHKPJ.js:8653, chunk-M6NSK26M.js:339976; 2026-11-09). */
export function geminiSettingsWithOutputLimit(settings: Settings, model: string, tokens: number): Settings {
  const configs = object(settings.modelConfigs);
  const cap = (value: unknown): Settings => {
    const override = object(value);
    const modelConfig = object(override.modelConfig);
    return {
      ...override,
      modelConfig: {
        ...modelConfig,
        generateContentConfig: { ...object(modelConfig.generateContentConfig), maxOutputTokens: tokens },
      },
    };
  };
  const overrides = (Array.isArray(configs.customOverrides) ? configs.customOverrides : []).map((value: unknown) =>
    object(object(value).match).model === model ? cap(value) : value
  );
  if (!overrides.some((value: unknown) => {
    const match = object(object(value).match);
    return match.model === model && Object.keys(match).length === 1;
  })) overrides.push(cap({ match: { model } }));
  return {
    ...settings,
    modelConfigs: {
      ...configs,
      ...(Array.isArray(configs.overrides) ? { overrides: configs.overrides.map((value: unknown) =>
        object(object(value).match).model === model ? cap(value) : value
      ) } : {}),
      customOverrides: overrides,
    },
  };
}
