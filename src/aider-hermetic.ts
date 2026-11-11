/**
 * A private HOME for hermetic aider runs (aider 0.86.2).
 *
 * Aider's own config search (main.py at 0.86.2, read 2026-11-09) reads the
 * same names from THREE roots — `Path.home()`, the git root, and the
 * working directory (generate_search_path_list):
 *
 * - `.aider.conf.yml` (conf_fname, default_config_files)
 * - `.env` (load_dotenv_files — the `--env-file` flag pins only the
 *   command-line entry; the home, git-root, and cwd entries still load)
 * - `.aider.model.settings.yml` (register_models)
 * - `.aider.model.metadata.json` (register_litellm_models)
 *
 * plus `~/.aider/oauth-keys.env`, prepended by load_dotenv_files when it
 * exists. The private HOME closes every home entry at once; the git-root
 * and cwd entries are closed by the clean-working-directory rule
 * (src/clean-cwd.ts), which refuses those names from the working directory
 * up to the project root — the same range aider searches. The login is
 * env-carried (OPENAI_API_KEY and siblings ride the sanitized child
 * environment), so the private home carries no credential.
 *
 * The HOME assignment rides INSIDE the sandbox command
 * (`env HOME=<private> aider ...`), never the run environment: scode
 * resolves its policy and credential access through the real HOME — the
 * kimi/agy rule.
 *
 * The private home lives under the real `~/.aider/` (beside the per-run
 * chat history file, src/aider-history.ts), where scode's write policy for
 * the harness's own state covers it.
 */

import { chmodSync, mkdtempSync } from "node:fs";
import { prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { join } from "node:path";

export interface AiderHermeticHome {
  /** The private HOME. */
  home: string;
  finalize: () => void;
}

export function createAiderHermeticHome(sourceAiderDir: string, printOnly = false): AiderHermeticHome {
  if (printOnly) return { home: join(sourceAiderDir, ".codemux-hermetic", "preview"), finalize: () => {} };
  const parent = prepareRunDirParent(sourceAiderDir, ".codemux-hermetic");
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, `run-${process.pid}-`));
  chmodSync(home, 0o700);
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private aider home ${home}`);
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);
  return { home, finalize };
}
