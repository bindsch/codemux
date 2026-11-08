import { renameIntoPlaceSync, stageExclusiveSync, writeOwnedSync } from "./fs-durable.js";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertTrustedDirectory } from "./hermetic-home.js";
import { readUtf8FileBounded, statEntryPresent } from "./file-io.js";
import { kimiTomlValue } from "./kimi-hermetic.js";
import { experimentToolTimeoutSeconds } from "./experiment-mcp.js";
import { sanitizeKimiToolNamePart } from "./experiment-kimi-tool-names.js";
import type { ExperimentHttpRelay } from "./experiment-relay.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

function writeKimiToolTimeout(kimiHome: string, milliseconds: number): void {
  const path = join(kimiHome, "config.toml");
  // An uninspectable path refuses rather than reading as empty: a stat
  // error folded into "absent" would silently drop the existing config
  // this write merges into (review round 169).
  const source = statEntryPresent(path, (code) => {
    throw new Error(`${path} could not be inspected (${code})`);
  })
    ? readUtf8FileBounded(path, { maxBytes: MAX_CONFIG_BYTES, label: "private Kimi config" }) : "";
  const config = Bun.TOML.parse(source) as Record<string, unknown>;
  const mcp = config.mcp;
  if (mcp !== undefined && (!mcp || typeof mcp !== "object" || Array.isArray(mcp))) {
    throw new Error("private Kimi config requires an MCP timeout table");
  }
  const root = Object.entries(config).filter(([key]) => key !== "mcp")
    .map(([key, value]) => `${JSON.stringify(key)} = ${kimiTomlValue(value)}\n`).join("");
  const table = Object.entries({ ...mcp as Record<string, unknown>, tool_timeout_ms: milliseconds })
    .map(([key, value]) => `${JSON.stringify(key)} = ${kimiTomlValue(value)}\n`).join("");
  const temporary = join(kimiHome, `config.${randomBytes(8).toString("hex")}.toml`);
  stageExclusiveSync(temporary, `${root}\n[mcp]\n${table}`, 0o600);
  renameIntoPlaceSync(temporary, path);
}

/** Kimi 2.3.2 only applies wildcard entries to MCP tools; built-ins use exact names. */
export function kimiExperimentToolPattern(serverName: string): string {
  return `mcp__${sanitizeKimiToolNamePart(serverName)}__*`;
}

/** Write the bearer token only to the run-owned private MCP config. */
export function writeKimiExperimentConfig(relay: ExperimentHttpRelay, kimiHome: string, agentFile: string): void {
  assertTrustedDirectory(kimiHome);
  const path = join(kimiHome, "mcp.json");
  // The rename below replaces an existing file, so an uninspectable path
  // must refuse like a present one: a stat error folded into "absent"
  // would silently overwrite the config this check exists to protect
  // (review round 169).
  const present = statEntryPresent(path, (code) => {
    throw new Error(`Kimi experiment cannot inspect the MCP config path ${path} (${code})`);
  });
  if (present) throw new Error(`Kimi experiment refuses an existing MCP config: ${path}`);
  const milliseconds = experimentToolTimeoutSeconds(relay.spec) * 1000;
  writeKimiToolTimeout(kimiHome, milliseconds);
  const temporary = join(kimiHome, `mcp.${randomBytes(8).toString("hex")}.json`);
  const config = { mcpServers: { [relay.spec.name]: {
    url: relay.url, headers: { Authorization: `Bearer ${relay.token}` },
    startupTimeoutMs: 120_000, toolTimeoutMs: milliseconds,
  } } };
  // Modes stated on the descriptor, fsync before the rename (round 401).
  stageExclusiveSync(temporary, JSON.stringify(config) + "\n", 0o600);
  renameIntoPlaceSync(temporary, path);
  // The agent file already exists (the hermetic home wrote the plain
  // profile); it is replaced in place with the mode stated.
  writeOwnedSync(agentFile, ["---", "name: codemux-experiment",
    "description: Private experiment profile with the default prompt.",
    `tools: ${JSON.stringify([kimiExperimentToolPattern(relay.spec.name)])}`,
    "---", "", "${base_prompt}", ""].join("\n"), 0o600);
}
