import { UsageRefusalError } from "./validation.js";

export const LABELS_ENV = "CODEMUX_LABELS";
const MAX_LABEL_VALUE_BYTES = 256;
const LABEL_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const LABEL_CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

function invalidLabel(label: string, reason: string): never {
  const quoted = JSON.stringify(label).replace(/\x7f/g, "\\u007f");
  throw new UsageRefusalError(`invalid label ${quoted}: ${reason}`);
}

export function validateLabelKey(key: string): string {
  if (!LABEL_KEY_PATTERN.test(key)) {
    invalidLabel(key, "KEY must match ^[a-z][a-z0-9_.-]{0,63}$");
  }
  return key;
}

export function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Flags replace the entire environment fallback when at least one is given. */
export function parseLabels(
  flags?: readonly string[],
  envValue?: string
): Record<string, string> | null {
  const pairs = flags !== undefined && flags.length > 0
    ? flags
    : envValue === undefined || envValue === "" ? [] : envValue.split(",");
  if (pairs.length === 0) return null;
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 0) invalidLabel(pair, "expected KEY=VALUE");
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!LABEL_KEY_PATTERN.test(key)) {
      invalidLabel(pair, "KEY must match ^[a-z][a-z0-9_.-]{0,63}$");
    }
    if (Object.hasOwn(labels, key)) invalidLabel(pair, `duplicate KEY ${JSON.stringify(key)}`);
    if (Buffer.byteLength(value, "utf8") > MAX_LABEL_VALUE_BYTES) {
      invalidLabel(pair, `VALUE exceeds ${MAX_LABEL_VALUE_BYTES} UTF-8 bytes`);
    }
    if (LABEL_CONTROL_PATTERN.test(value)) {
      invalidLabel(pair, "VALUE must not contain control characters");
    }
    labels[key] = value;
  }
  return labels;
}
