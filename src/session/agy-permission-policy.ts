/** Native, session-only denial for agy 1.5.3. No approval events exist on
 * its print wire. The installed bundle names
 * third_party/jetski/cli/types/permissions.go,
 * third_party/jetski/cli/store/permissions.go, and
 * third_party/jetski/cli/printmode/headless_permissions.go. Its --settings
 * help says: "Settings for this session only, never saved: a JSON object
 * of settings.json keys, inline or as a file path". Permission entries
 * use action(target): read_file(*), write_file(*), read_url(*),
 * execute_url(*), command(*), unsandboxed(*), and mcp(*). These are the
 * seven action families already used by the adapter's tools-none deny.
 * Explicit denies precede grants; the bundle reports
 * "Matches user-configured deny rule." and "ignoring invalid deny entry
 * %q: %v". Do not invent a "*(*)" action: ParseGrantString rejects
 * "unknown action %q in grant string: %q".
 */

import { join } from "node:path";
import { readUtf8FileBounded } from "../file-io.js";
import { AGY_DENIED_ACTIONS, MAX_AGY_SETTINGS_BYTES } from "../adapters/agy-settings.js";
import { UsageRefusalError } from "../validation.js";

/** Stay below the platform's single-argument limit. Only permission
 * rules enter argv; provider keys and all other settings stay on disk. */
const MAX_PERMISSION_ARGUMENT_BYTES = 32 * 1024;

export function agySessionDenySettings(privateHomeDir: string | undefined): string {
  if (privateHomeDir === undefined) {
    throw new UsageRefusalError("agy --permission-policy deny requires --hermetic and its private home");
  }
  const path = join(privateHomeDir, ".gemini", "antigravity-cli", "settings.json");
  let settings: unknown = {};
  try {
    settings = JSON.parse(readUtf8FileBounded(path, {
      maxBytes: MAX_AGY_SETTINGS_BYTES,
      label: "the private agy settings",
      noFollow: true,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new UsageRefusalError("cannot read the private agy settings for --permission-policy deny");
    }
  }
  if (!isRecord(settings) || (settings.permissions !== undefined && !isRecord(settings.permissions))) {
    throw new UsageRefusalError("invalid private agy settings permissions for --permission-policy deny");
  }
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  for (const key of ["allow", "ask", "deny"]) {
    const rules = permissions[key];
    if (rules !== undefined && (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string"))) {
      throw new UsageRefusalError(`invalid private agy permissions.${key} for --permission-policy deny`);
    }
  }
  const deny = permissions.deny as string[] | undefined;
  const json = JSON.stringify({
    permissions: {
      ...permissions,
      deny: [...new Set([...(deny ?? []), ...AGY_DENIED_ACTIONS.map((action) => `${action}(*)`)])],
    },
  });
  if (Buffer.byteLength(json) > MAX_PERMISSION_ARGUMENT_BYTES) {
    throw new UsageRefusalError("private agy permission rules exceed the 32 KiB session settings argument limit");
  }
  return json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
