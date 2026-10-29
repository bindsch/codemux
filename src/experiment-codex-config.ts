import { lstatSync } from "node:fs";
import { readUtf8FileBounded } from "./file-io.js";

const MAX_SYSTEM_CONFIG_BYTES = 1024 * 1024;
const UNIX_SYSTEM_CONFIG = "/etc/codex/config.toml";
export const CODEX_EXPERIMENT_PROVIDER_ID = "codemux-experiment";
export const CODEX_EXPERIMENT_OMITTED_SURFACES = ["deferred", "code_mode"] as const;

/** Keep OpenAI transport and authentication under a custom provider ID. */
export function codexCatalogProviderTable(version: string, url: string): string {
  return [
    `[model_providers.${CODEX_EXPERIMENT_PROVIDER_ID}]`,
    'name = "OpenAI"',
    'wire_api = "responses"',
    `http_headers = { version = ${JSON.stringify(version)} }`,
    'env_http_headers = { "OpenAI-Organization" = "OPENAI_ORGANIZATION", "OpenAI-Project" = "OPENAI_PROJECT" }',
    "requires_openai_auth = true",
    "supports_websockets = true",
    "supports_standalone_web_search = true",
    `model_catalog_url = ${JSON.stringify(url)}`,
  ].join("\n");
}

/** System MCP tables merge into private user config and cannot be cleared by an empty table. */
export function assertNoCodexSystemMcp(path?: string): void {
  if (path === undefined && process.platform === "win32") {
    throw new Error("Codex experiment cannot verify the Windows system config location");
  }
  const target = path ?? UNIX_SYSTEM_CONFIG;
  try {
    if (!lstatSync(target, { throwIfNoEntry: false })) return;
    const text = readUtf8FileBounded(target, { maxBytes: MAX_SYSTEM_CONFIG_BYTES, label: `Codex system config ${target}` });
    const config = Bun.TOML.parse(text) as Record<string, unknown>;
    const pending: unknown[] = [config];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const table = value as Record<string, unknown>;
      if (Object.hasOwn(table, "mcp_servers")) {
        const servers = table.mcp_servers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length > 0) {
          throw new Error("system MCP server tables cannot be isolated by the private experiment config");
        }
      }
      pending.push(...Object.values(table));
    }
  } catch (error) {
    throw new Error(`Codex experiment refuses system config ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
