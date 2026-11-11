import { join } from "node:path";
import { CLINE_PROVIDER, clineProvider, populateClineConfig, type ClineRunContext } from "../cline-config.js";
import type { RunContext } from "../run-context.js";
import type { RunRequest } from "../types.js";
import { UsageRefusalError } from "../validation.js";
import { openSessionPrivateHome } from "./private-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { CLINE_SESSION_ID_PATTERN } from "./cline-session.js";
import { scopedResumePattern } from "./scoped-id.js";
import { isCallerHarnessHome } from "./harness-home.js";

export function openClineSessionHome(stateRoot: string, resumeId?: string): SessionPrivateHome {
  return openSessionPrivateHome({ parent: join(stateRoot, ".codemux-hermetic"), sessionId: resumeId,
    resume: resumeId !== undefined, idPattern: scopedResumePattern("cline", CLINE_SESSION_ID_PATTERN), blockedPaths: [stateRoot] });
}

/** Rebuild private settings before each turn, following the settlement rename.
 * The stored native session database is retained. Operator settings never enter
 * a hermetic home. Project hooks remain governed by the run adapter's validator. */
export function prepareClineSessionSettings(input: {
  request: RunRequest; prepared: RunContext; privateHome: SessionPrivateHome | null; environment: NodeJS.ProcessEnv;
}): ClineRunContext {
  const { request, prepared, privateHome, environment } = input;
  const override = clineProvider(environment);
  const existing = (prepared as ClineRunContext).clineConfig;
  let clineConfig = existing;
  if (privateHome !== null) {
    const check = prepared.playwrightMcpCheck;
    if (request.enablePlaywrightMcp && !check) throw new UsageRefusalError("cline Playwright session requires a verified MCP executable");
    // A caller-owned home keeps the caller's native settings: requested
    // options are merged into separate overlay files under <home>/.cline,
    // and the caller's own data/settings files are only read.
    const callerSettings = isCallerHarnessHome(privateHome) ? join(privateHome.dir, ".cline", "data", "settings") : null;
    const configured = populateClineConfig(privateHome.dir, environment, {
      model: request.model, hermetic: callerSettings === null, noWeb: request.web === false, toolsNone: request.tools === "none",
      ...(callerSettings === null ? {} : { sourceGlobalPath: join(callerSettings, "global-settings.json"),
        sourceMcpPath: join(callerSettings, "cline_mcp_settings.json") }),
      ...(request.enablePlaywrightMcp ? { mcpServers: { playwright: {
        transport: { type: "stdio", command: check!.path, args: [], cwd: request.cwd, env: {} },
      } } } : {}),
    });
    clineConfig = { ...configured, finalize: () => {} };
  }
  // ACP's auth restore checks known providers only. Custom provider settings
  // need CLINE_API_KEY in the child environment, never a key in argv.
  // https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/acpAgent.ts#L155-L174
  const env = { ...clineConfig?.env, CLINE_SESSION_BACKEND_MODE: "local",
    ...(override === null ? {} : { CLINE_PROVIDER, CLINE_API_KEY: override.apiKey,
      CLINE_MODEL: request.model ?? override.model! }),
  };
  return { ...prepared, clineConfig: clineConfig === undefined
    ? { home: "", configDir: "", env, finalize: () => {} }
    : { ...clineConfig, env } };
}

/** A sandbox preview must not open or rewrite a resumed session.
 * Rebase the write-free prepared context onto the representative path. */
export function previewClineSessionSettings(input: {
  request: RunRequest; prepared: RunContext; privateDir: string | null; environment: NodeJS.ProcessEnv;
}): ClineRunContext {
  const context = prepareClineSessionSettings({ ...input, privateHome: null });
  if (input.privateDir === null) return context;
  const config = context.clineConfig!;
  if (config.home === "") throw new UsageRefusalError("cline hermetic preview needs disposable private settings");
  const rebase = (path: string): string => path === config.home || path.startsWith(config.home + "/")
    ? input.privateDir! + path.slice(config.home.length) : path;
  const env = Object.fromEntries(Object.entries(config.env).map(([name, value]) => [name,
    name === "CLINE_API_KEY" || name === "CLINE_MODEL" || name === "CLINE_PROVIDER" ? value : rebase(value)]));
  return { ...context, clineConfig: { home: input.privateDir, configDir: rebase(config.configDir), env, finalize: () => {} } };
}
