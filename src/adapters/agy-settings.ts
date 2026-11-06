/** The agy settings read, split from src/adapters/agy.ts: the operator's
 * settings.json merged with the command grant the medium headless mode
 * needs, plus the actions the tools probe denies. */

import { readFileBytesBounded, readUtf8FileBounded } from "../file-io.js";

/** 1 MiB, the bound this repo's other small configuration reads use
 * (config.ts, experiment-kimi-config.ts); a settings file this size is
 * already pathological. */
export const MAX_AGY_SETTINGS_BYTES = 1024 * 1024;

/** The operator's file fallback token, read once for the probe home's
 * private copy (review round 169): one non-following, non-blocking open,
 * typed and sized on the descriptor. Null means no file token (ENOENT, or
 * a parent that is a file); a token that exists but cannot be read (a
 * symlink, a FIFO, a directory, an oversized file) is a refusal naming
 * the reason, never a copy of whatever the path points at. The bytes are
 * returned as read, so the copy is byte for byte: the token is opaque to
 * codemux, and decoding it as text would drop a leading byte-order mark
 * and refuse bytes that are not UTF-8 (review round 170). The empty
 * buffer is a real answer: an empty token file suppresses the Keychain
 * path the same way a nonempty one does, so callers compare against
 * null, never truthiness or length. */
export function readAgyTokenForCopy(path: string): Buffer | null {
  try {
    return readFileBytesBounded(path, {
      maxBytes: MAX_AGY_SETTINGS_BYTES,
      label: "the agy file token",
      noFollow: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** Internal: the actions the tools probe's settings.json denies. */
export const AGY_DENIED_ACTIONS = ["read_file", "write_file", "read_url", "execute_url", "command", "unsandboxed", "mcp"];

export function headlessMediumSettings(path: string): string {
  let text: string | null = null;
  try {
    // One non-blocking open, typed and sized on the descriptor: a FIFO, a
    // directory, an oversized file, or unreadable bytes refuse at once,
    // instead of the unbounded pathname read that could park medium-
    // autonomy preparation forever before the harness and its timeout
    // start (review round 147). A missing file is the operator's default
    // state: empty grants.
    text = readUtf8FileBounded(path, {
      maxBytes: MAX_AGY_SETTINGS_BYTES,
      label: path,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot read agy settings: ${path}`);
    }
  }
  let settings: unknown = {};
  if (text !== null) {
    try { settings = JSON.parse(text); } catch { throw new Error(`cannot read agy settings: ${path}`); }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`invalid agy settings object: ${path}`);
  }
  const config = settings as Record<string, unknown>;
  const permissions = config.permissions ?? {};
  if (typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error(`invalid agy settings permissions: ${path}`);
  }
  const rules = permissions as Record<string, unknown>;
  const allow = rules.allow ?? [];
  if (!Array.isArray(allow) || allow.some((rule) => typeof rule !== "string")) {
    throw new Error(`invalid agy settings permissions.allow: ${path}`);
  }
  return JSON.stringify({ ...config, permissions: { ...rules, allow: [...new Set([...allow, "command(*)"])] } });
}
