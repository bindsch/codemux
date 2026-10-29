import { existsSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { assertTrustedDirectory } from "./hermetic-home.js";
import { sanitizeKimiToolNamePart } from "./experiment-kimi-tool-names.js";
import type { ExperimentHttpRelay } from "./experiment-relay.js";

/** Kimi 2.3.2 only applies wildcard entries to MCP tools; built-ins use exact names. */
export function kimiExperimentToolPattern(serverName: string): string {
  return `mcp__${sanitizeKimiToolNamePart(serverName)}__*`;
}

/** Write the bearer token only to the run-owned private MCP config. */
export function writeKimiExperimentConfig(relay: ExperimentHttpRelay, kimiHome: string, agentFile: string): void {
  assertTrustedDirectory(kimiHome);
  const path = join(kimiHome, "mcp.json");
  if (existsSync(path)) throw new Error(`Kimi experiment refuses an existing MCP config: ${path}`);
  const temporary = join(kimiHome, `mcp.${randomBytes(8).toString("hex")}.json`);
  const config = { mcpServers: { [relay.spec.name]: {
    url: relay.url, headers: { Authorization: `Bearer ${relay.token}` },
    startupTimeoutMs: 120_000, toolTimeoutMs: 600_000,
  } } };
  writeFileSync(temporary, JSON.stringify(config) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  writeFileSync(agentFile, ["---", "name: codemux-experiment",
    "description: Private experiment profile with the default prompt.",
    `tools: ${JSON.stringify([kimiExperimentToolPattern(relay.spec.name)])}`,
    "---", "", "${base_prompt}", ""].join("\n"), { mode: 0o600 });
}
