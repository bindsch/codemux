/**
 * A private home for hermetic goose runs (goose 1.50.1).
 *
 * goose reads operator customization through the XDG directories —
 * `~/.config/goose/config.yaml` (the system prompt, `GOOSE_PROVIDER`,
 * extensions, `thinking_effort`), `~/.local/share/goose` (the session
 * ledger), `~/.cache/goose` — and its working-directory context file
 * `.goosehints` ("Project Hints: These are hints for working on the
 * project in this directory", CONTEXT_FILE_NAMES, both read from the
 * installed 1.50.1 binary, 2026-11-09). Redirecting GOOSE_PATH_ROOT and
 * the three XDG variables to a fresh directory closes every config-channel
 * file at once, the session ledger included; the `.goosehints` channel is
 * closed by the clean-working-directory rule (src/clean-cwd.ts), which
 * refuses a tree that carries one.
 *
 * The private directories live under the real goose config directory
 * (`.codemux-hermetic/`), the codex/kimi placement: scode's write policy
 * for the harness's own state covers the private home too. The redirects
 * are assigned inside the sandbox command (`env GOOSE_PATH_ROOT=... XDG_...= goose`),
 * never through the run environment: scode itself resolves ITS config
 * through XDG, so the wrapper must keep the operator's real values —
 * the kimi/agy HOME-prefix rule.
 *
 * No provider configuration is carried into the private home: config.yaml
 * holds the operator's system prompt alongside any provider keys, and a
 * hermetic run loads none of it. A hermetic goose run therefore requires
 * the provider override (env OPENAI_* outranks config and keyring), which
 * the adapter refuses before launch when it is absent.
 */

import { chmodSync, mkdtempSync } from "node:fs";
import { prepareRunDirParent } from "./hermetic-home.js";
import { recordTrustedParent, removeUnderTrustedParentOrThrow, reportingHook } from "./safe-remove.js";
import { trackPrivateDir, untrackPrivateDir } from "./private-dir-signals.js";
import { join } from "node:path";

export interface GooseHermeticHome {
  /** The private root; the XDG directories sit inside it. */
  home: string;
  /** The `env` assignments that redirect goose into the private root. */
  envAssignments: string[];
  finalize: () => void;
}

export function createGooseHermeticHome(sourceGooseConfigDir: string, printOnly = false): GooseHermeticHome {
  if (printOnly) {
    const home = join(sourceGooseConfigDir, ".codemux-hermetic", "preview");
    return { home, envAssignments: gooseHomeEnv(home), finalize: () => {} };
  }
  const parent = prepareRunDirParent(sourceGooseConfigDir, ".codemux-hermetic");
  const parentRecord = recordTrustedParent(parent);
  const home = mkdtempSync(join(parent, `run-${process.pid}-`));
  chmodSync(home, 0o700);
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    removeUnderTrustedParentOrThrow(home, parentRecord, `the private goose home ${home}`);
    finalized = true;
    process.off("exit", hook);
    untrackPrivateDir(hook);
  };
  const hook = reportingHook(finalize);
  process.once("exit", hook);
  trackPrivateDir(hook);
  // GOOSE_PATH_ROOT moves every goose directory under the private root
  // (config, data, state, and the .agents home: `Paths::get_dir`,
  // crates/goose/src/config/paths.rs at v1.50.1, read 2026-11-09). Without
  // it, the XDG redirect leaves the global `~/.agents/AGENTS.md` instruction
  // file in the real home readable (load_hints.rs, `in_agents_home_dir`).
  // The XDG trio stays for the libraries that read it directly.
  return { home, envAssignments: gooseHomeEnv(home), finalize };
}

function gooseHomeEnv(home: string): string[] {
  return [
    `GOOSE_PATH_ROOT=${home}`,
    `XDG_CONFIG_HOME=${join(home, "config")}`,
    `XDG_DATA_HOME=${join(home, "share")}`,
    `XDG_CACHE_HOME=${join(home, "cache")}`,
  ];
}
