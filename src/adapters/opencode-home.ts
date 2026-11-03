/**
 * Home- and data-directory resolution for opencode: the effective home
 * a run sees and the real data parent holding the login and the native
 * session database. src/adapters/opencode.ts owns the adapter lifecycle
 * and re-exports these.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The user home a run sees: the seam, else $HOME, else the account home. */
function opencodeEffectiveHome(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  if (homeDirectory !== undefined && !isAbsolute(homeDirectory)) {
    throw new Error("opencode home directory must be an absolute path");
  }
  const home = homeDirectory ?? environment.HOME;
  return home && isAbsolute(home) ? home : homedir();
}

/**
 * The XDG data parent a plain run sees, holding the real OpenCode data
 * directory and its login: the sanitized child environment passes
 * XDG_DATA_HOME through, so an operator who relocated it keeps their
 * login in both kinds of run. Exported because the session CLI records
 * the opencode session's harness home (§4.8) as opencodeRealDataDir of
 * this parent — the native sessions live there, so one rule computes
 * both and they cannot drift.
 */
export function opencodeRealDataParent(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  // Read exactly as OpenCode reads it (no trimming): a whitespace-padded
  // value must not make codemux inspect one directory while the child uses
  // another (review round 45).
  const configured = environment.XDG_DATA_HOME;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("XDG_DATA_HOME must be an absolute path");
    }
    return configured;
  }
  return join(opencodeEffectiveHome(environment, homeDirectory), ".local", "share");
}

/** The real OpenCode data directory holding the login state the
 * remote-config inspection reads (opencode-remote-config.ts) and the
 * native session database a `codemux session` resumes from. */
export function opencodeRealDataDir(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  return join(opencodeRealDataParent(environment, homeDirectory), "opencode");
}

/** The real OpenCode state directory (`$XDG_STATE_HOME/opencode`, else
 * `~/.local/state/opencode`): it holds `model.json`, the model preference
 * OpenCode reads when neither a flag nor a config names one. */
export function opencodeRealStateDir(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  const configured = environment.XDG_STATE_HOME;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("XDG_STATE_HOME must be an absolute path");
    }
    return join(configured, "opencode");
  }
  return join(opencodeEffectiveHome(environment, homeDirectory), ".local", "state", "opencode");
}
