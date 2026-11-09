import { buildPlaywrightSandboxMcp } from "../mcp.js";
import type { RunContext } from "../run-context.js";
import type { RunRequest } from "../types.js";
import type { TurnProviderExtras } from "./turn-driver-types.js";

/** Capture the exact server that the session child will launch. The
 * shared spawn checks this identity again immediately before launch. */
export function prepareQwenSessionPlaywright(
  request: RunRequest,
  prepared: RunContext,
  pathEnv: string,
): TurnProviderExtras {
  if (!request.enablePlaywrightMcp) return {};
  if (!request.sandboxed) throw new Error("qwen Playwright sessions require a sandbox");
  const { check } = buildPlaywrightSandboxMcp(true, {
    enabled: true,
    forbiddenRoot: request.cwd ?? process.cwd(),
    pathEnv,
  });
  if (check === null) throw new Error("qwen Playwright sessions require an executable check");
  prepared.playwrightMcpCheck = check;
  return { qwenPlaywrightPath: check.path };
}
