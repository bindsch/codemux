// The operator state a plain sandboxed agy launch shares with its private
// home: each existing entry of `~/.gemini` and `~/.gemini/antigravity-cli`
// individually, never a whole directory of the two. One list serves the
// link pass (adapters/agy.ts) and the sandbox grants a session adds for
// the same entries (session/agy-run-home.ts), so the two cannot drift.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGY_FILE_TOKEN } from "../agy-auth.js";

export interface AgySharedEntry {
  /** The operator's real entry, the link target and the path to grant. */
  source: string;
  /** The entry's path relative to HOME, the link's place in a private home. */
  relative: string;
}

/** The conversation directory relative to HOME: a session creates it before
 * the share pass, so a first session's transcript outlives the private home. */
export const AGY_CONVERSATIONS = ".gemini/antigravity-cli/conversations";

/**
 * The entries shared for `realHome`, as they exist now. Never shared: the
 * `antigravity-cli` directory itself (its entries are shared one by one),
 * the file token (the login pass links it, and only when it is in use),
 * codemux's own private homes, and — when `privateSettings` is set (a
 * medium launch writes its own settings.json) — the operator's settings.
 */
export function agySharedStateEntries(realHome: string, privateSettings: boolean): AgySharedEntry[] {
  const entries: AgySharedEntry[] = [];
  const token = AGY_FILE_TOKEN.slice(AGY_FILE_TOKEN.lastIndexOf("/") + 1);
  for (const [relative, excluded] of [[".gemini", "antigravity-cli"],
    [".gemini/antigravity-cli", token]] as const) {
    const source = join(realHome, relative);
    if (!existsSync(source)) continue;
    for (const name of readdirSync(source).sort()) {
      if (name === excluded || name === ".codemux-isolation-probes") continue;
      if (privateSettings && relative === ".gemini/antigravity-cli" && name === "settings.json") continue;
      entries.push({ source: join(source, name), relative: join(relative, name) });
    }
  }
  return entries;
}
