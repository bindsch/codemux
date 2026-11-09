import { buildPlaywrightSandboxMcp, type PlaywrightSandboxMcp } from "./mcp.js";

/**
 * The Playwright MCP carrier for codex: the trust-checked stdio server as
 * `-c` config overrides. codex has no `--mcp-config` flag (`codex exec
 * --help`, codex-cli 0.166.0, checked 2026-11-09, lists no MCP option);
 * its MCP servers are config entries — the binary's McpServerConfig
 * carries command/args/env under `mcp_servers.<name>.*` (0.166.0 binary
 * strings) — and `-c KEY=VALUE` applies one for the launch alone, parsed
 * as TOML, the same channel the hermetic flags use. Interactive codex
 * reads the same config, so the run and TUI builders share this carrier.
 *
 * The shared build resolves and trust-checks the binary once
 * (buildPlaywrightSandboxMcp); its `--mcp-config` JSON argument is the
 * only public carrier of the resolved path, so this reads the command
 * back out of it — the agy planted-config carrier's rule — and returns
 * the captured check for the spawn's re-stat, because the path sits
 * inside a config value the argv re-check never scans (review round 110).
 */
export function codexPlaywrightMcpOverrides(
  sandboxed: boolean | undefined,
  options: { enabled?: boolean; pathEnv: string; forbiddenRoot: string }
): { overrides: string[]; check: PlaywrightSandboxMcp["check"] } {
  const built = buildPlaywrightSandboxMcp(sandboxed, options);
  if (built.args.length === 0) return { overrides: [], check: built.check };
  const config = built.args[built.args.indexOf("--mcp-config") + 1];
  if (typeof config !== "string") throw new Error("playwright MCP config argument is missing");
  const command = (JSON.parse(config) as { mcpServers: { playwright: { command: string } } })
    .mcpServers.playwright.command;
  return {
    // A JSON string is a TOML string, so the binary path arrives quoted
    // exactly the way the hermetic flags quote their config values.
    overrides: ["-c", `mcp_servers.playwright.command=${JSON.stringify(command)}`],
    check: built.check,
  };
}
