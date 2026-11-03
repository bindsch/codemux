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

/** A pre-launch refusal that is the caller's usage error, not a runtime
 * failure (EX_USAGE): the CLI exits 64 rather than 1, so a script can
 * tell a request only the caller can fix from a run that failed. Every
 * pre-launch refusal of a CLI request refuses this way — unknown agent,
 * a request the named agent cannot carry, bad option values — both from
 * its own gates and from the adapters' validateRunRequest (the aider and
 * kimi slash-command rules, review D10, security; the kimi KIMI_CODE_HOME
 * passthrough rules, round al29). The adapters' remaining plain throws
 * judge only the run request object's shape, which a CLI request never
 * reaches with a bad value: the command's own gates refuse first, so
 * those throws answer programmatic callers only. Runtime failures
 * (harness crash, timeout, capture limit) and parser errors keep their
 * own codes. */
export class UsageRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageRefusalError";
  }
}

/** The exit code a UsageRefusalError maps to (EX_USAGE). Exported so
 * commands that print their own refusal and set an exit code — instead of
 * throwing to handleUnexpectedError — report the same code the throw path
 * would. */
export const USAGE_REFUSAL_EXIT_CODE = 64 as const;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** Every validator below judges the caller's request, so each refusal is
 * a UsageRefusalError (exit 64) on every command — run, tui, check, and
 * session (review round 4, contracts-2 finding 1: run exited 1 where
 * session exited 64 on the same bad model or cwd). */
export function validateModelName(model: unknown): string {
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model !== model.trim() ||
    Buffer.byteLength(model, "utf8") > MAX_MODEL_NAME_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(model)
  ) {
    throw new UsageRefusalError(
      `invalid model name; use 1 to ${MAX_MODEL_NAME_BYTES} UTF-8 bytes without padding or control characters`
    );
  }
  return model;
}

export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new UsageRefusalError("prompt must be a non-empty string");
  }
  if (prompt.includes("\0")) {
    throw new UsageRefusalError("prompt must not contain a NUL byte");
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new UsageRefusalError(`prompt exceeds the ${MAX_PROMPT_BYTES}-byte limit`);
  }
  return prompt;
}

export function validateAutonomy(value: unknown): AutonomyLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAutonomyLevel(value)) {
    throw new UsageRefusalError(`invalid autonomy level '${String(value)}'`);
  }
  return value;
}

export function validateEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isReasoningEffort(value)) {
    throw new UsageRefusalError(`invalid reasoning effort '${String(value)}'`);
  }
  return value;
}

export function validateEnvironmentNames(
  names: unknown,
  label = "environment passthrough"
): readonly string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.length > MAX_PASSTHROUGH_ENV_NAMES) {
    throw new UsageRefusalError(
      `${label} must contain at most ${MAX_PASSTHROUGH_ENV_NAMES} variable names`
    );
  }
  for (const name of names) {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
      throw new UsageRefusalError(`invalid environment variable name '${String(name)}' in ${label}`);
    }
  }
  return names;
}

export function validateWorkingDirectory(cwd: unknown): string | undefined {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    throw new UsageRefusalError("cwd must be a non-empty path without NUL bytes");
  }
  const absolute = resolve(cwd);
  let canonical: string;
  let stat;
  try {
    canonical = realpathSync(absolute);
    stat = statSync(canonical);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new UsageRefusalError(`cwd is not accessible${detail}`);
  }
  if (!stat.isDirectory()) {
    throw new UsageRefusalError("cwd must be a directory");
  }
  return canonical;
}
