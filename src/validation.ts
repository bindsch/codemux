import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  isAutonomyLevel,
  isReasoningEffort,
  type AutonomyLevel,
  type ReasoningEffort,
} from "./types.js";

export const MAX_MODEL_NAME_BYTES = 256;
export const MAX_PROMPT_BYTES = 16 * 1024 * 1024;
export const MAX_PASSTHROUGH_ENV_NAMES = 64;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function validateModelName(model: unknown): string {
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model !== model.trim() ||
    Buffer.byteLength(model, "utf8") > MAX_MODEL_NAME_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(model)
  ) {
    throw new Error(
      `invalid model name; use 1 to ${MAX_MODEL_NAME_BYTES} UTF-8 bytes without padding or control characters`
    );
  }
  return model;
}

export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
  if (prompt.includes("\0")) {
    throw new Error("prompt must not contain a NUL byte");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error(`prompt exceeds the ${MAX_PROMPT_BYTES}-byte limit`);
  }
  return prompt;
}

export function validateAutonomy(value: unknown): AutonomyLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAutonomyLevel(value)) {
    throw new Error(`invalid autonomy level '${String(value)}'`);
  }
  return value;
}

export function validateEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isReasoningEffort(value)) {
    throw new Error(`invalid reasoning effort '${String(value)}'`);
  }
  return value;
}

export function validateEnvironmentNames(
  names: unknown,
  label = "environment passthrough"
): readonly string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.length > MAX_PASSTHROUGH_ENV_NAMES) {
    throw new Error(
      `${label} must contain at most ${MAX_PASSTHROUGH_ENV_NAMES} variable names`
    );
  }
  for (const name of names) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
      throw new Error(`invalid environment variable name '${String(name)}' in ${label}`);
    }
  }
  return names;
}

export function validateWorkingDirectory(cwd: unknown): string | undefined {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    throw new Error("cwd must be a non-empty path without NUL bytes");
  }
  const absolute = resolve(cwd);
  let canonical: string;
  let stat;
  try {
    canonical = realpathSync(absolute);
    stat = statSync(canonical);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`cwd is not accessible${detail}`);
  }
  if (!stat.isDirectory()) {
    throw new Error("cwd must be a directory");
  }
  return canonical;
}
