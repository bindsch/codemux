/** The agy settings read, split from src/adapters/agy.ts: the operator's
 * settings.json merged with the command grant the medium headless mode
 * needs, plus the actions the tools probe denies. */

import { readUtf8FileBounded } from "../file-io.js";

/** 1 MiB, the bound this repo's other small configuration reads use
 * (config.ts, experiment-kimi-config.ts); a settings file this size is
 * already pathological. */
export const MAX_AGY_SETTINGS_BYTES = 1024 * 1024;

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
