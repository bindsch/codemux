/**
 * The Playwright MCP carrier for agy: the trust-checked stdio server
 * planted as the probe home's global MCP config.
 *
 * agy 1.5.3 has no argv MCP flag — the option table carries none — but
 * it resolves MCP servers from `~/.gemini/config/mcp_config.json`
 * ("Global Configuration: ~/.gemini/config/mcp_config.json (applies to
 * all …)", binary strings, read 2026-11-09; the `mcp` subcommands
 * "add, remove, list, enable, disable … managing MCP servers in your
 * user-level mcp_config.json" edit that same file, stdio and HTTP both).
 * Every sandboxed agy run already mints a private probe home
 * (src/adapters/agy.ts preparePrivateHome) whose HOME the launch
 * assigns, so the planted file is the ONLY mcp_config.json the run
 * resolves: per-run isolation without touching operator state.
 *
 * The server entry is the same trust-checked one the qwen run path
 * attaches through `--mcp-config` (buildPlaywrightSandboxMcp resolves
 * the binary and captures its identity for the spawn's re-stat), so the
 * two carriers cannot drift.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlaywrightSandboxMcp, type PlaywrightSandboxMcp } from "./mcp.js";

/** The config's directory inside a probe home: the global config path
 * agy resolves under HOME. */
export function agyMcpConfigPath(probeHome: string): string {
  return join(probeHome, ".gemini", "config", "mcp_config.json");
}

/**
 * Plants the Playwright server entry in the probe home's global MCP
 * config. Throws (never returns a half-written home) when the
 * playwright-mcp binary is absent or fails the trust check — the same
 * refusal the argv carriers raise. `flag: "wx"` so a reused home with an
 * existing config fails loudly instead of merging silently.
 */
export function plantAgyPlaywrightMcpConfig(
  probeHome: string,
  options: { pathEnv: string; forbiddenRoot: string }
): { path: string; check: PlaywrightSandboxMcp["check"] } {
  const built = buildPlaywrightSandboxMcp(true, {
    enabled: true,
    pathEnv: options.pathEnv,
    forbiddenRoot: options.forbiddenRoot,
  });
  const config = built.args[built.args.indexOf("--mcp-config") + 1];
  if (typeof config !== "string") throw new Error("playwright MCP config argument is missing");
  mkdirSync(join(probeHome, ".gemini", "config"), { recursive: true, mode: 0o700 });
  const path = agyMcpConfigPath(probeHome);
  writeFileSync(path, `${config}\n`, { mode: 0o600, flag: "wx" });
  return { path, check: built.check };
}
