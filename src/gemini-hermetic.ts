/**
 * Private Gemini run artifacts (gemini 0.60.0). Hermetic runs redirect
 * GEMINI_CLI_HOME. Plain no-web runs use a separate policy file; tool
 * removal and other settings overrides use a customization-preserving mirror.
 *
 * The CLI reads operator customization from `<homedir()>/.gemini/`: the
 * user settings layer `settings.json` (tool filters, `contextFileName`
 * redirects, hooks), the home context file `GEMINI.md`, and the OAuth
 * login (`oauth_creds.json`, `google_accounts.json`). The bundle's own
 * `homedir()` prefers `process.env["GEMINI_CLI_HOME"]` over
 * `os.homedir()` (read in the installed 0.60.0 bundle,
 * /opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/, 2026-11-09),
 * so pointing that variable at a fresh directory closes every home
 * channel at once — no settings, no context file, no plugins — while the
 * real HOME stays intact for scode's policy and credential access.
 *
 * `--tools none` sets tools.core to an empty array. createToolRegistry
 * registers no built-in whose name is absent from that array. A deny-all
 * policy also prevents other tools from executing. Plain runs use a
 * settings mirror that retains the operator's other files and original
 * transcript directory, as provider caps and MCP attachments do.
 *
 * The home lives under the real gemini directory (`.codemux-hermetic/`),
 * the codex/kimi placement: scode already treats `~/.gemini` as harness
 * state, so a write policy for it covers the private home too. The login
 * files are HARD LINKS (codex's rule: gemini rotates the tokens in place,
 * so a copy would strand the refreshed token in the private home); under
 * an API-key provider override the home carries no login at all.
 */

import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { runDirectoryPrefix } from "./run-directory-owner.js";
import { prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { writeOwnedSync } from "./fs-durable.js";
import { join } from "node:path";
import { geminiSettingsWithOutputLimit, inheritGeminiSettings } from "./gemini-settings.js";
import type { GeminiMcpServer } from "./gemini-mcp.js";

export interface GeminiHermeticHome {
  /** The directory GEMINI_CLI_HOME names. */
  home: string;
  /** The `.gemini` directory inside it (the settings and login root). */
  geminiDir: string;
  finalize: () => void;
}

export interface GeminiLoginLinks {
  hard: (source: string, destination: string) => void;
  symlink: (source: string, destination: string) => void;
}

const realLoginLinks: GeminiLoginLinks = { hard: linkSync, symlink: symlinkSync };

// The login files gemini reads from the `.gemini` directory (the bundle's
// SENSITIVE_SETTINGS_FILENAMES carries both, plus tokens codemux does not
// relink: MCP and A2A OAuth tokens are operator integrations a hermetic
// run must not load).
const GEMINI_LOGIN_FILES = ["oauth_creds.json", "google_accounts.json"] as const;

/** Built-in removal plus denial in the private settings file. */
export const GEMINI_NO_TOOLS_SETTINGS = JSON.stringify({
  tools: { core: [], exclude: ["*"] },
});

export function createGeminiHermeticHome(
  sourceGeminiDir: string,
  options: {
    toolsNone?: boolean;
    apiKeyAuth?: boolean;
    printOnly?: boolean;
    loginLinks?: GeminiLoginLinks;
    preserveCustomization?: boolean;
    outputLimit?: { model: string; tokens: number };
    mcpServers?: Record<string, GeminiMcpServer>;
  } = {}
): GeminiHermeticHome {
  if (options.printOnly) {
    const home = join(sourceGeminiDir, ".codemux-hermetic", "preview");
    return { home, geminiDir: join(home, ".gemini"), finalize: () => {} };
  }
  const links = options.loginLinks ?? realLoginLinks;
  const parent = prepareRunDirParent(sourceGeminiDir, ".codemux-hermetic");
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, runDirectoryPrefix()));
  // mkdtemp's mode is masked by the umask; each is stated right after
  // creation, whatever the umask (review round 401, item 1).
  chmodSync(home, 0o700);
  const geminiDir = join(home, ".gemini");
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private gemini home ${home}`);
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);
  try {
    mkdirSync(geminiDir, { mode: 0o700 });
    chmodSync(geminiDir, 0o700);
    let settings: Record<string, unknown> = options.preserveCustomization
      ? inheritGeminiSettings(sourceGeminiDir, geminiDir, false) : {};
    if (options.toolsNone === true) settings.tools = { core: [], exclude: ["*"] };
    if (options.outputLimit !== undefined) {
      settings = geminiSettingsWithOutputLimit(settings, options.outputLimit.model, options.outputLimit.tokens);
    }
    if (options.mcpServers !== undefined && Object.keys(options.mcpServers).length > 0) {
      const original = settings.mcpServers;
      settings.mcpServers = {
        ...(original !== null && typeof original === "object" && !Array.isArray(original) ? original : {}),
        ...options.mcpServers,
      };
    }
    if (Object.keys(settings).length > 0 || options.preserveCustomization) {
      writeOwnedSync(join(geminiDir, "settings.json"), JSON.stringify(settings), 0o600);
    }
    if (!options.preserveCustomization && !options.apiKeyAuth) {
      for (const name of GEMINI_LOGIN_FILES) {
        const source = join(sourceGeminiDir, name);
        let stat;
        try {
          stat = lstatSync(source);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        try {
          links.hard(source, join(geminiDir, name));
        } catch {
          links.symlink(source, join(geminiDir, name));
        }
      }
    }
    return { home, geminiDir, finalize };
  } catch (error) {
    finalize();
    throw error;
  }
}
