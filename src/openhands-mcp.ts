/**
 * The Playwright MCP carrier for openhands: the trust-checked stdio
 * server planted as the private persistence dir's mcp.json.
 *
 * openhands 1.16.0 has no argv MCP flag — the run parser's whole option
 * list carries none — but it resolves MCP servers from
 * `<persistence dir>/mcp.json` (locations.py: `MCP_CONFIG_FILE =
 * "mcp.json"` and `_get_mcp_config_path()` returning
 * `get_persistence_dir() / mcp.json`; the conversation agent loads it
 * through `load_agent_specs(..., mcp_servers=...)` and its own error
 * help names "~/.openhands/mcp.json", read 2026-11-09). The persistence
 * dir is env-relocatable (OPENHANDS_PERSISTENCE_DIR), and a hermetic
 * run already pins it to the private home
 * (src/adapters/openhands.ts buildRunCommand), so the planted file is
 * the only mcp.json the run resolves.
 *
 * A plain sandboxed run shares the operator's persistence dir, so it has
 * no per-run channel: the adapter refuses `--enable-playwright-mcp`
 * without `--hermetic` rather than touching operator state — the honest
 * split, since planting into the operator's ~/.openhands would outlive
 * the run.
 *
 * The server entry is the trust-checked one buildPlaywrightSandboxMcp
 * emits for the argv carriers (qwen, the Claude family), so the planted
 * file and the argv carriers cannot drift.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlaywrightSandboxMcp, type PlaywrightSandboxMcp } from "./mcp.js";

/** The mcp.json path inside a persistence dir (locations.py's
 * MCP_CONFIG_FILE). */
export function openhandsMcpConfigPath(persistenceDir: string): string {
  return join(persistenceDir, "mcp.json");
}

/**
 * Plants the Playwright server entry in the persistence dir's mcp.json.
 * Throws (never returns a half-written dir) when the playwright-mcp
 * binary is absent or fails the trust check — the same refusal the argv
 * carriers raise. `flag: "wx"` so a reused dir with an existing mcp.json
 * fails loudly instead of merging silently.
 */
export function plantOpenhandsPlaywrightMcp(
  persistenceDir: string,
  options: { pathEnv: string; forbiddenRoot: string; printOnly?: boolean }
): { path: string; check: PlaywrightSandboxMcp["check"] } {
  const built = buildPlaywrightSandboxMcp(true, {
    enabled: true,
    pathEnv: options.pathEnv,
    forbiddenRoot: options.forbiddenRoot,
  });
  const config = built.args[built.args.indexOf("--mcp-config") + 1];
  if (typeof config !== "string") throw new Error("playwright MCP config argument is missing");
  // The private home arrives empty: openhands itself would create the
  // persistence dir at startup, and the plant must not depend on that.
  const path = openhandsMcpConfigPath(persistenceDir);
  if (!options.printOnly) {
    mkdirSync(persistenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${config}\n`, { mode: 0o600, flag: "wx" });
  }
  return { path, check: built.check };
}
