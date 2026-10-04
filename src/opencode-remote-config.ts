/**
 * The remote configuration a login can carry into OpenCode, detected.
 *
 * OpenCode's config load fetches configuration attached to the login and
 * merges it as global-scope config — custom prompts, plugins and agent
 * permissions included — unconditionally, before the private-home
 * redirection of a hermetic run can matter (the login's data directory
 * stays real by design). Per-agent permission rules append after the
 * `OPENCODE_PERMISSION` deny even when that deny is the last top-level
 * merge (see the adapter), so a login that carries remote configuration
 * breaks both `--hermetic` and `--tools none` on hermetic runs. No flag
 * gates either fetch (packages/opencode/src/config/config.ts at 1.18.18,
 * corroborated by the 1.18 docs: opencode.ai/docs/config puts remote
 * config first in the precedence order — "fetched automatically when
 * you authenticate with a provider that supports it" — and the
 * documented config and env surface carries no switch that gates it),
 * so a hermetic run refuses while one exists instead.
 *
 * Two carriers, both read here:
 * - a `wellknown` entry in the auth store (auth.json; `Auth.all` reads an
 *   `OPENCODE_AUTH_CONTENT` variable first, and the hermetic env prefix
 *   removes it), which fetches `<login>/.well-known/opencode`;
 * - an account with an active organization in the data directory's
 *   opencode.db (table `account_state` joined to `account`), which fetches
 *   `<account>/api/config`. The join mirrors the loader's own activation
 *   condition: the state row's account must exist and its org must be set.
 *
 * `realDataDir` is the real OpenCode data directory (the one holding
 * auth.json), never a private home.
 *
 * Both stores are harness state a sandboxed run can write, and this
 * inspection runs during validation, before the subprocess timeout
 * starts, so neither read may trust the file: the auth store opens
 * without blocking and without following a final symlink, and is
 * confirmed a regular file of bounded size before it is parsed
 * (readUtf8FileBounded from src/file-io.ts; aider's history read borrows
 * the same pattern through its own descriptor-based implementation in
 * src/aider-history.ts. A bare readFileSync parked forever on a FIFO a
 * harness left in place of the store — h6 review), and the account store
 * is lstat'd to a regular file
 * before SQLite opens it, because SQLite's own open has the same two
 * shapes. A store that exists but cannot be inspected that way cannot be
 * ruled out, so it fails closed naming the file; only an absent store
 * carries nothing (OpenCode reads the same paths as the same user).
 */

import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { readUtf8FileBounded } from "./file-io.js";
// bun:sqlite, not node:sqlite: the pinned runtime floor (Bun 1.3.14) has
// no node:sqlite, and this module loads with the adapter registry, so a
// node:sqlite import breaks every CLI command on the floor.
import { Database } from "bun:sqlite";

/** The remote-config carriers in the real login state, or null when none. */
export function opencodeRemoteConfigCarrier(realDataDir: string): string | null {
  const wellKnown = wellKnownLogin(realDataDir);
  if (wellKnown !== null) return wellKnown;
  return activeOrgAccount(realDataDir);
}

// The largest auth store codemux inspects: many provider logins, each a
// small JSON object. A harness-grown file beyond it is refused like an
// unreadable one instead of being read without bound.
const MAX_AUTH_STORE_BYTES = 1024 * 1024;

/** A `wellknown` entry in the auth store, the login it names, or null. */
function wellKnownLogin(realDataDir: string): string | null {
  const storePath = join(realDataDir, "auth.json");
  let store: unknown;
  try {
    store = JSON.parse(
      readUtf8FileBounded(storePath, {
        maxBytes: MAX_AUTH_STORE_BYTES,
        label: `the auth store ${storePath}`,
        noFollow: true,
      })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // No store, no login in it. OpenCode reads the same file as the
      // same user, so it carries nothing either.
      return null;
    }
    // A store that exists but cannot be inspected cannot be ruled out —
    // OpenCode itself follows a symlink and blocks on a FIFO, so what it
    // would read is exactly what codemux refused to. Fail closed, naming
    // the file, and let the operator see why.
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return `the auth store ${storePath} could not be read, so a well-known login whose .well-known/opencode config OpenCode fetches and merges into every run cannot be ruled out${detail}`;
  }
  if (store === null || typeof store !== "object" || Array.isArray(store)) {
    return null;
  }
  for (const [id, entry] of Object.entries(store as Record<string, unknown>)) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "wellknown"
    ) {
      return `a well-known login (${id}) in the auth store, whose .well-known/opencode config OpenCode fetches and merges into every run (clear it with \`opencode auth logout ${id}\`)`;
    }
  }
  return null;
}

/** An account with an active organization in opencode.db, or null. */
function activeOrgAccount(realDataDir: string): string | null {
  const dbPath = join(realDataDir, "opencode.db");
  let dbStat: Stats;
  try {
    dbStat = lstatSync(dbPath);
  } catch {
    // No store, no account in it.
    return null;
  }
  // SQLite's own open blocks on a FIFO and follows a symlink (the same
  // two shapes the auth store read refuses), so only a regular file is
  // opened; anything else is a store whose content cannot be ruled out.
  if (!dbStat.isFile()) {
    return accountStoreUnreadable(dbPath, ": it is not a regular file");
  }
  let url: string | undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(
          "SELECT account.url AS url FROM account_state AS state \
JOIN account AS account ON account.id = state.active_account_id \
WHERE state.id = 1 AND state.active_org_id IS NOT NULL LIMIT 1"
        )
        .get() as { url?: string } | undefined;
      url = row?.url;
    } finally {
      db.close();
    }
  } catch (error) {
    // A store that exists but cannot be read cannot be ruled out: fail
    // closed, naming the file, and let the operator see why.
    const detail = error instanceof Error ? `: ${error.message}` : "";
    return accountStoreUnreadable(dbPath, detail);
  }
  if (url === undefined) return null;
  return `an OpenCode account (${url}) with an active organization, whose /api/config OpenCode fetches and merges into every run (deactivate the organization or log out of the account)`;
}

/** The fail-closed refusal for an account store codemux cannot inspect. */
function accountStoreUnreadable(dbPath: string, detail: string): string {
  return `the account store ${dbPath} could not be read, so an organization whose /api/config OpenCode fetches and merges into every run cannot be ruled out${detail}`;
}
