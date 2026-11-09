/**
 * A private home for hermetic copilot runs (copilot 1.0.85 installed).
 *
 * The CLI reads operator customization from its config directory. The
 * override is `COPILOT_HOME`: the `--config-dir` option's own help says
 * "(default: ~/.copilot). Deprecated: use COPILOT_HOME env var instead",
 * and every resolver follows it — `resolveCopilotHome(configDir,
 * process.env.COPILOT_HOME, homedir())` and `configDir ??
 * process.env.COPILOT_HOME ?? join(homedir(), ".copilot")` (installed
 * @github/copilot 1.0.85 app.js and 1.0.103 copilot.tgz/package/cli-main.js,
 * read 2026-11-09). The directory holds the custom
 * instructions file `copilot-instructions.md` (the channel the 2026-09-17
 * live control leaked), `settings.json`, `installed-plugins/`, and the
 * session store, so a fresh directory holding nothing but the login
 * closes every home channel. The login is `config.json`; it is a HARD
 * LINK (codex's rule: a copy would strand a refreshed token in the
 * private home, and copilot rewrites the file in place).
 *
 * The workspace channel (AGENTS.md and related files) is closed by the
 * `--no-custom-instructions` flag every codemux run already passes, so
 * the private home is the whole mechanism. `check --hermetic`'s control
 * probe must therefore drop that flag on the control probe only (the
 * change src/check-command.ts needs; see the parity report), or the
 * control cannot leak and the check refuses to credit the mechanism.
 */

import { chmodSync, linkSync, lstatSync, mkdtempSync, symlinkSync } from "node:fs";
import { prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { join } from "node:path";

export interface CopilotHermeticHome {
  /** The directory COPILOT_HOME names (the config directory itself). */
  home: string;
  finalize: () => void;
}

export interface CopilotLoginLinks {
  hard: (source: string, destination: string) => void;
  symlink: (source: string, destination: string) => void;
}

const realLoginLinks: CopilotLoginLinks = { hard: linkSync, symlink: symlinkSync };

export function createCopilotHermeticHome(
  sourceConfigDir: string,
  options: { printOnly?: boolean; loginLinks?: CopilotLoginLinks } = {}
): CopilotHermeticHome {
  const links = options.loginLinks ?? realLoginLinks;
  const parent = prepareRunDirParent(sourceConfigDir, ".codemux-hermetic");
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, `run-${process.pid}-`));
  chmodSync(home, 0o700);
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private copilot home ${home}`);
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);
  try {
    if (!options.printOnly) {
      const source = join(sourceConfigDir, "config.json");
      let stat;
      try {
        stat = lstatSync(source);
      } catch {
        stat = undefined;
      }
      // No login file is not a launch failure: an env-token login
      // (GITHUB_TOKEN) needs none, and the harness itself refuses when it
      // has no credential at all.
      if (stat !== undefined && stat.isFile()) {
        try {
          links.hard(source, join(home, "config.json"));
        } catch {
          links.symlink(source, join(home, "config.json"));
        }
      }
    }
    return { home, finalize };
  } catch (error) {
    finalize();
    throw error;
  }
}
