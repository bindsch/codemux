import { opencodePlaywrightConfig } from "../opencode-launch-config.js";
import { openCodeSessionHomePrefix } from "./opencode-home.js";
import { buildOpenCodeSessionCommand, type OpenCodeSessionCommand } from "./opencode-session.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { ExecutableCheck } from "../executable-security.js";

/** The same command is used for a real turn and the sandbox preview. */
export function buildOpenCodeTurnCommand(input: OpenCodeSessionCommand & {
  privateHome?: SessionPrivateHome | null;
  tools?: "default" | "none";
  playwrightMcp?: boolean;
  sandboxed?: boolean;
  pathEnv?: string;
  cwd?: string;
  executableChecks?: ExecutableCheck[];
}): string[] {
  if (input.playwrightMcp && !input.sandboxed) {
    throw new Error("--enable-playwright-mcp requires --sandbox");
  }
  const noTools = input.tools === "none";
  if (input.permissionPolicy === "deny" && (!input.privateHome || input.projectSettings)) {
    throw new Error("opencode --permission-policy deny requires --hermetic without --experiment-project-settings");
  }
  if (noTools && (!input.privateHome || input.projectSettings)) {
    throw new Error("opencode session --tools none requires --hermetic without --experiment-project-settings");
  }
  const mcp = opencodePlaywrightConfig(input.sandboxed, input.playwrightMcp, input.pathEnv ?? "", input.cwd);
  if (mcp.check) input.executableChecks?.push(mcp.check);
  const deny = noTools || input.permissionPolicy === "deny";
  const config = { ...mcp.config, ...(deny ? { permission: "deny" } : {}) };
  const prefix = input.privateHome ? openCodeSessionHomePrefix(input.privateHome) : [];
  if (Object.keys(config).length > 0) {
    if (prefix.length === 0) prefix.push("env");
    prefix.push(`OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`);
    if (deny) prefix.push('OPENCODE_PERMISSION={"*":"deny"}');
  }
  return [...prefix, ...buildOpenCodeSessionCommand(input)];
}
