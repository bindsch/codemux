/**
 * A private HOME for hermetic openhands runs (openhands CLI 1.16.0).
 *
 * The CLI reads operator customization from `~/.openhands/` — settings,
 * agent specs, hooks, microagents — and from the working directory's own
 * `.openhands/` (setup.py's HookConfig.load reads
 * `{working_dir}/.openhands/hooks.json` at 1.16.0, read 2026-11-09).
 * A private HOME closes the home channel; the working-directory channel
 * is closed by the clean-working-directory rule (src/clean-cwd.ts).
 *
 * The HOME assignment rides INSIDE the sandbox command
 * (`env HOME=<private> openhands ...`), never the run environment: scode
 * resolves its policy and credential access through the real HOME — the
 * kimi/agy rule.
 *
 * No settings are carried into the private home: `~/.openhands` holds the
 * whole agent spec, which is operator customization. A hermetic run
 * therefore requires the provider override (LLM_API_KEY, LLM_BASE_URL,
 * LLM_MODEL through --override-with-envs), which the adapter refuses
 * before launch when it is absent.
 */

import { chmodSync, mkdtempSync } from "node:fs";
import { prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { join } from "node:path";

export interface OpenhandsHermeticHome {
  /** The private HOME. */
  home: string;
  finalize: () => void;
}

export function createOpenhandsHermeticHome(sourceOpenhandsDir: string): OpenhandsHermeticHome {
  const parent = prepareRunDirParent(sourceOpenhandsDir, ".codemux-hermetic");
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, `run-${process.pid}-`));
  chmodSync(home, 0o700);
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private openhands home ${home}`);
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);
  return { home, finalize };
}
