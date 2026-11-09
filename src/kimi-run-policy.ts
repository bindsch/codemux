import { readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createKimiHermeticHome, parseKimiConfig, populateKimiHermeticSessionHome, serializeKimiConfig, type KimiHermeticHome } from "./kimi-hermetic.js";
import { readBoundedKimiFile } from "./kimi-wire-log.js";
import { writeOwnedSync } from "./fs-durable.js";
import { buildPlaywrightSandboxMcp, type PlaywrightMcpOptions } from "./mcp.js";
import type { RunContext } from "./adapters/base.js";
import type { RunRequest } from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const OWNED_ENTRIES = new Set(["config.toml", "mcp.json", "credentials", "region", "device_id", ".codemux", ".codemux-hermetic"]);
// Kimi 2.5.2 bin/kimi: webSearchTool.ts and fetchUrlTool.ts name the
// builtin tools WebSearch and FetchURL. moonshot_web_search is a provider.
export const KIMI_WEB_TOOLS = ["WebSearch", "FetchURL"] as const;

function readOptional(path: string): string {
  try { return readBoundedKimiFile(path, MAX_CONFIG_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function table(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`private Kimi ${label} must be a table`);
  }
  return value as Record<string, unknown>;
}

/** Native global disabled tools compose with profile/workspace restrictions
 * using AND (agent/toolPolicy/evaluate.ts, Kimi 2.5.2). Keep existing denies. */
export function disableKimiWebTools(brandHome: string): void {
  const path = join(brandHome, "config.toml");
  const config = parseKimiConfig(readOptional(path));
  const tools = table(config.tools, "tools");
  const disabled = tools.disabled ?? [];
  if (!Array.isArray(disabled) || disabled.some((name) => typeof name !== "string")) {
    throw new Error("private Kimi tools.disabled must be a string list");
  }
  config.tools = { ...tools, disabled: [...new Set([...disabled, ...KIMI_WEB_TOOLS])] };
  writeOwnedSync(path, serializeKimiConfig(config), 0o600);
}

/** Plain policy runs relocate only KIMI_CODE_HOME. All operator configuration
 * and discovery entries survive; config and MCP files are private copies.
 * Hermetic runs keep the existing filtered-home behavior. */
export function createKimiPolicyHome(source: string, request: RunRequest, printOnly = false): KimiHermeticHome {
  const home = createKimiHermeticHome(source, request.tools === "none", printOnly);
  try {
    if (!request.hermetic && !printOnly) {
      copyKimiCustomization(source, home.kimiHome);
    }
    if (request.web === false) disableKimiWebTools(home.kimiHome);
    return home;
  } catch (error) { home.finalize(); throw error; }
}

function copyKimiCustomization(source: string, destination: string, isolateSessions = false): void {
  writeOwnedSync(join(destination, "config.toml"), readOptional(join(source, "config.toml")), 0o600);
  const mcp = readOptional(join(source, "mcp.json"));
  if (mcp !== "") writeOwnedSync(join(destination, "mcp.json"), mcp, 0o600);
  for (const entry of readdirSync(source)) {
    if (OWNED_ENTRIES.has(entry) || (isolateSessions && (entry === "sessions" || entry === "session_index.jsonl"))) continue;
    symlinkSync(resolve(source, entry), join(destination, entry));
  }
}

/** A session-lifetime config mirror keeps native transcripts in its own store.
 * The shared session home owner settles and retains this directory for resume. */
export function populateKimiPolicySessionHome(dir: string, source: string | null): void {
  const { brandHome } = populateKimiHermeticSessionHome(dir, source);
  if (source !== null) copyKimiCustomization(source, brandHome, true);
}

/** mcp/config.ts resolves user servers from <KIMI_CODE_HOME>/mcp.json.
 * The shared resolver supplies the executable identity for launch rechecks. */
export function prepareKimiPlaywright(
  request: RunRequest, context: RunContext | undefined, options: Omit<PlaywrightMcpOptions, "enabled">
): void {
  if (!request.enablePlaywrightMcp) return;
  if (!request.sandboxed) throw new Error("--enable-playwright-mcp requires --sandbox");
  const built = buildPlaywrightSandboxMcp(request.sandboxed, { ...options, enabled: true });
  if (context === undefined) return;
  const brandHome = context.kimiHermeticHome?.kimiHome;
  if (brandHome === undefined) throw new Error("kimi private policy home was not prepared before MCP launch");
  const path = join(brandHome, "mcp.json");
  const source = readOptional(path);
  const config = table(source === "" ? {} : JSON.parse(source), "MCP config");
  const servers = table(config.mcpServers, "MCP servers");
  const injected = JSON.parse(built.args[1]!) as { mcpServers: Record<string, unknown> };
  // The requested Playwright name owns this one slot, as on Claude. All other
  // operator servers and metadata remain present in the private copy.
  writeOwnedSync(path, JSON.stringify({ ...config, mcpServers: { ...servers, ...injected.mcpServers } }) + "\n", 0o600);
  context.playwrightMcpCheck = built.check;
}
