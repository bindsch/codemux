import { executableCheck, resolveTrustedExecutable, type ExecutableCheck } from "./executable-security.js";
import type { AgentId } from "./types.js";
import { playwrightRegistryDir } from "./playwright-sandbox.js";

/** The server name codemux registers, and the permission rule that allows
 * every tool of that server in Claude Code (`mcp__<server>`). */
export const PLAYWRIGHT_MCP_SERVER = "playwright";
export const PLAYWRIGHT_MCP_GRANT = `mcp__${PLAYWRIGHT_MCP_SERVER}`;
/** The server's tools that run caller-supplied code in the server's own
 * Node process (not in the page). They are a shell by another name, so a
 * level that does not grant Bash denies them (`browser_run_code` is the
 * name before @playwright/mcp renamed it). */
export const PLAYWRIGHT_MCP_CODE_TOOLS = ["browser_run_code*", "browser_run_code_unsafe", "browser_run_code"]
  .map((tool) => `mcp__${PLAYWRIGHT_MCP_SERVER}__${tool}`);

/** How one launch runs the server under the sandbox. A caller that passes
 * this gets the sandbox arguments (playwrightServerArgs); a caller that
 * does not keeps the bare server entry. */
export interface PlaywrightServerLaunch {
  /** No browser window: true for headless launches (run, session),
   * false for the TUI, where a person is watching. */
  headless: boolean;
  /** This launch's private socket directory (src/playwright-sandbox.ts),
   * handed to the server as `PWTEST_SOCKETS_DIR`. */
  socketDir?: string | undefined;
}

/** The server arguments under the sandbox. `--isolated` keeps the browser
 * profile in memory: the default profile directory is outside what the
 * sandbox allows. `--no-sandbox` turns off Chromium's own sandbox, which
 * cannot nest inside scode's. */
export function playwrightServerArgs(launch: PlaywrightServerLaunch): string[] {
  return ["--isolated", ...(launch.headless ? ["--headless"] : []), "--no-sandbox"];
}

export interface PlaywrightMcpOptions {
  enabled?: boolean;
  /** Sandbox launch settings; absent leaves `args` empty and sets no `env`. */
  launch?: PlaywrightServerLaunch | undefined;
  binaryPath?: string | null;
  forbiddenRoot?: string;
  /** The PATH the binary resolves through when no explicit binaryPath is
   * given: the adapter-built child environment's PATH, never the ambient
   * process environment (review round 391, item 13) — the same source
   * every other launch binary resolves by, so a custom-environment launch
   * embeds the binary its child would run, not one the ambient PATH
   * happened to hold (or is wrongly refused for lack of). */
  pathEnv: string;
}

/** The one list of agents whose command builders can attach the Playwright
 * MCP server (review round 147): the CLI checks, the session request
 * parser, and the shared validators all read this predicate, so no second
 * list can drift from it. An adapter outside the list refuses the option
 * instead of accepting a launch the server never rides. */
export const PLAYWRIGHT_MCP_AGENTS: readonly AgentId[] = ["claude", "zai", "opencode", "copilot", "gemini", "pi", "qwen", "goose", "codex", "cline", "kimi"];

/** The list as refusals print it, derived from the table so the text
 * cannot name fewer agents than the table holds (review m3). */
export const PLAYWRIGHT_MCP_AGENT_LIST = PLAYWRIGHT_MCP_AGENTS.join(", ");

export function supportsPlaywrightMcpAgent(agent: AgentId): boolean {
  return PLAYWRIGHT_MCP_AGENTS.includes(agent);
}

/** What building the Playwright MCP arguments leaves behind for the spawn
 * site's pre-spawn re-check: the arguments to embed, and this build's own
 * trust check of the binary they name. The binary's path sits INSIDE the
 * `--mcp-config` JSON argument, so the ordinary command re-check — which
 * scans argv positions — never sees it; a spawn site that does not hand
 * this check to its re-stat lets bytes swapped in after this build run
 * unvalidated (review round 110). One bound the check cannot close: after
 * the spawn, Claude itself decides when to start the server, so a swap in
 * that later window is the sandbox's to contain, not a re-check's. */
export interface PlaywrightSandboxMcp {
  args: string[];
  check: ExecutableCheck | null;
}

export function buildPlaywrightSandboxMcp(
  sandboxed: boolean | undefined,
  options: PlaywrightMcpOptions
): PlaywrightSandboxMcp {
  const enabled = options.enabled ?? false;
  if (!sandboxed || !enabled) {
    return { args: [], check: null };
  }

  const binaryPath = options.binaryPath !== undefined
    ? options.binaryPath
    : Bun.which("playwright-mcp", { PATH: options.pathEnv });
  if (!binaryPath) {
    throw new Error(
      "--enable-playwright-mcp requires a locally installed playwright-mcp binary"
    );
  }
  const resolvedBinary = resolveTrustedExecutable(
    binaryPath,
    "playwright-mcp",
    options.forbiddenRoot
  );
  // Captured in the resolution's own synchronous block, so the spawn's
  // re-stat compares this build's identity, never another launch's.
  const check = executableCheck(resolvedBinary);

  const config = JSON.stringify({
    mcpServers: {
      [PLAYWRIGHT_MCP_SERVER]: {
        command: resolvedBinary,
        args: options.launch === undefined ? [] : playwrightServerArgs(options.launch),
        ...(options.launch?.socketDir === undefined ? {} : { env: { PWTEST_SOCKETS_DIR: options.launch.socketDir, PWTEST_SERVER_REGISTRY: playwrightRegistryDir(options.launch.socketDir) } }),
      },
    },
  });
  return { args: ["--mcp-config", config], check };
}

/** The preview form (no trust check returned): `pathEnv` may be omitted,
 * in which case the ambient PATH stands in — fine for a printed preview,
 * never for a launch (every launch path passes the child's PATH through
 * buildPlaywrightSandboxMcp directly). */
export function getPlaywrightSandboxMcpArgs(
  sandboxed?: boolean,
  options: Omit<PlaywrightMcpOptions, "pathEnv"> & { pathEnv?: string } = {}
): string[] {
  return buildPlaywrightSandboxMcp(sandboxed, {
    ...options,
    pathEnv: options.pathEnv ?? process.env.PATH ?? "",
  }).args;
}
