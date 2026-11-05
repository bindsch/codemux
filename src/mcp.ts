import { executableCheck, resolveTrustedExecutable, type ExecutableCheck } from "./executable-security.js";

export interface PlaywrightMcpOptions {
  enabled?: boolean;
  binaryPath?: string | null;
  forbiddenRoot?: string;
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
  sandboxed?: boolean,
  options: PlaywrightMcpOptions = {}
): PlaywrightSandboxMcp {
  const enabled = options.enabled ?? false;
  if (!sandboxed || !enabled) {
    return { args: [], check: null };
  }

  const binaryPath = options.binaryPath !== undefined
    ? options.binaryPath
    : Bun.which("playwright-mcp", { PATH: process.env.PATH });
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
      playwright: {
        command: resolvedBinary,
        args: [],
      },
    },
  });
  return { args: ["--mcp-config", config], check };
}

export function getPlaywrightSandboxMcpArgs(
  sandboxed?: boolean,
  options: PlaywrightMcpOptions = {}
): string[] {
  return buildPlaywrightSandboxMcp(sandboxed, options).args;
}
