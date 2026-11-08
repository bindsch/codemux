// Harness-state home resolution for `codemux session` (design §4.5):
// the per-agent home a session records and every resume guard compares.
// src/session/cli.ts owns the command; session/cli-resume.ts picks the
// home for a launch.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { opencodeRealDataDir } from "../adapters/opencode.js";
import { usageError } from "./cli-usage.js";

/** The harness state home this session runs against (§4.5): the
 * pass-through redirect when one is active, else the default home.
 * `CLAUDE_CONFIG_DIR` reaches the child only via --pass-env, so the
 * redirect is honored here only when it is being passed through —
 * otherwise the child runs against the default home while the record
 * named a redirect the child never saw (an M4-class lie the resume
 * guards would then judge against). The whole claude family shares one
 * store — a zai session's transcripts live under the same `~/.claude`
 * (or `CLAUDE_CONFIG_DIR`) as a claude session's, because both run the
 * same binary against it; `~/.zai` holds only the API key. The
 * registry's agent match is what closes the shared-home replay hazard
 * (§4.8), not a separate path. */
export function claudeFamilyHarnessHome(passthroughEnv: string[]): string {
  const redirected = process.env.CLAUDE_CONFIG_DIR;
  if (passthroughEnv.includes("CLAUDE_CONFIG_DIR") && redirected !== undefined && redirected !== "") {
    return redirected;
  }
  return join(homedir(), ".claude");
}

/** The agy harness home (§4.5): agy keeps its state under
 * `~/.gemini/antigravity-cli` (conversations/, cache/ — confirmed on
 * disk against 1.2.14). No verified environment redirect exists for it,
 * so unlike the claude family and codex there is no passthrough variable
 * to honor; the recorded home is always the default one. */
export function agyHarnessHome(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

/** The opencode harness home (§4.5): the real OpenCode data directory,
 * where the native sessions and the login live (XDG_DATA_HOME honored
 * when the environment carries an absolute one, else
 * ~/.local/share/opencode — one rule shared with the adapter, so the
 * recorded home is the store a `--resume` actually reads). A provider
 * override does not move it: the override swaps the provider, not the
 * session database. */
export function opencodeHarnessHome(): string {
  return opencodeRealDataDir(process.env);
}

/** The aider harness home (§4.5): ~/.aider. Aider has no environment
 * redirect for its state, and codemux keeps the per-session history
 * under this home (aider-session.ts), so the recorded home is always
 * the default one — override or not. */
export function aiderHarnessHome(): string {
  return join(homedir(), ".aider");
}

/** The kimi harness home (§4.5): the brand home kimi's own session store
 * lives under (~/.kimi-code/sessions). KIMI_CODE_HOME reaches the child
 * only via --pass-env; the redirect is honored here only when it is
 * being passed through. The value is read and recorded raw — exactly the
 * bytes the child receives, never a trimmed normalization (round al11):
 * kimi reads the variable without trimming, so a padded value names a
 * real (differently spelled) directory to the child, and recording a
 * trimmed copy made the registry name a store the child never used while
 * a resume with the same padded value still passed the guard. An EMPTY
 * value is refused rather than treated as unset (round al16): kimi's own
 * resolver preserves an empty KIMI_CODE_HOME and places its store under
 * the working directory, while the registry would record the default
 * home — the recorded home and the child's store must be the same thing
 * or the resume guard compares fiction. A provider override does not
 * move it: the KIMI_MODEL_* synthesis is in-memory and the store stays
 * where it is. */
export function kimiHarnessHome(passthroughEnv: string[]): string {
  const configured = process.env.KIMI_CODE_HOME;
  if (!passthroughEnv.includes("KIMI_CODE_HOME") || configured === undefined) {
    return join(homedir(), ".kimi-code");
  }
  if (configured === "") {
    usageError(
      "KIMI_CODE_HOME must not be empty when passed through; kimi's own " +
        "resolver preserves an empty value and places its session store " +
        "under the working directory, while codemux records the default " +
        "home — unset the variable or give it an absolute path"
    );
  }
  if (!isAbsolute(configured)) {
    usageError("KIMI_CODE_HOME must be an absolute path");
  }
  return configured;
}

/** The codex harness home (§4.5): CODEX_HOME reaches the child only via
 * --pass-env, and the recorded home must be the one the child really
 * uses — codex reads the variable without trimming, so a padded value is
 * refused rather than validated trimmed (the adapter's realCodexHome
 * rule, applied to the session boundary). */
export function codexHarnessHome(passthroughEnv: string[]): string {
  const configured = process.env.CODEX_HOME;
  // The adapter's rule (realCodexHome, review round 381): an empty
  // passed-through value is refused, never read as unset, because the
  // child still receives the empty value while codemux would fall back
  // to the default home — two homes for one session.
  if (passthroughEnv.includes("CODEX_HOME") && configured === "") {
    usageError(
      "CODEX_HOME must not be empty when passed through; the child still " +
        "receives the empty value while codemux falls back to the default " +
        "home — unset the variable or give it an absolute path"
    );
  }
  if (passthroughEnv.includes("CODEX_HOME") && configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      usageError("CODEX_HOME must be an absolute path");
    }
    if (configured.trim() !== configured) {
      usageError(
        `CODEX_HOME must not be whitespace-padded when passed through; ` +
          `'${configured}' carries leading or trailing whitespace, and codex ` +
          "reads the variable without trimming, so the harness state would " +
          "live in a directory whose name still carries the padding"
      );
    }
    return configured;
  }
  return join(homedir(), ".codex");
}
