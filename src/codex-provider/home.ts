// Session homes for a provider-override session: the session-keyed
// CODEX_HOME paths and the prepare/settle/abandon lifecycle around
// them. src/codex-provider.ts owns the override and re-exports this.

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, renameSync } from "node:fs";
import { runDirectoryPrefix } from "../run-directory-owner.js";
import { repairCodexHomeRollouts } from "../session/codex-home.js";
import { basename, join } from "node:path";
import { assertTrustedDirectory, prepareRunDirParent } from "../hermetic-home.js";
import {
  recordTrustedParent,
  removeUnderTrustedParent,
  type TrustedParentRecord,
} from "../safe-remove.js";
import { providerIdentityBaseUrl } from "../provider-override.js";

import type { ProviderOverride } from "../provider-override.js";

import { PARENT_DIR_NAME, writeCodexProviderConfigInto } from "./config.js";

/** The parent a session home lives under, beside the per-run homes —
 * also the directory a fresh session's final path is contained in (its id
 * names the final directory only after thread/start answers, so the
 * start-time containment check uses the parent). */
export function codexProviderSessionsParent(realCodexHome: string): string {
  return join(realCodexHome, PARENT_DIR_NAME);
}

/**
 * The CODEX_HOME a provider-override SESSION's home is keyed by: one
 * `session-home-<endpoint hash>-<session id>` directory under the same
 * `.codemux-provider/` parent. One session's threads are state in its
 * CODEX_HOME (`thread/resume` reads them back), so the home must survive
 * across that one session's turns and resumes — keyed to that one
 * session: two sessions on one endpoint (or one session id across two
 * endpoints) never share a directory (review D1, security). The key is a
 * naming rule, not an access boundary (review D5, security): the shared
 * parent is writable by every sandboxed codex child, so one session's
 * child can write into another session's home (`rules/`, `AGENTS.md`,
 * hooks); only config.toml is codemux-rewritten per launch
 * (`prepareConfig`), atomically and never through a symlink. The
 * endpoint hash keeps the two-endpoints-never-share rule
 * visible in the name; the session id (a codex thread id,
 * `[A-Za-z0-9_-]{8,128}` — codex-session.ts, no path separators) names the
 * session the directory belongs to.
 * The hash input is the base URL's IDENTITY form (query and fragment
 * stripped, providerIdentityBaseUrl — review D10): a gateway key riding
 * the query can rotate without moving the home, and the key never
 * varies with credentials — the same endpoint-identity notion the
 * registry's `provider_base_url` records.
 */
export function codexSessionProviderHomePath(
  realCodexHome: string,
  baseUrl: string,
  sessionId: string
): string {
  const identity = providerIdentityBaseUrl(baseUrl);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return join(realCodexHome, PARENT_DIR_NAME, `session-home-${hash}-${sessionId}`);
}

/** What a session's CLI holds for the home's lifetime. */
export interface CodexSessionProviderHome {
  /** The CODEX_HOME this session's turns run in: the session-keyed
   * directory for a resume, a fresh `run-<pid>-<random>` one for a new
   * session (moved onto its key by `settle` at an orderly end). */
  codexHome: string;
  /**
   * Writes this launch's config.toml into the home — atomically, never
   * through a symlink (`writeCodexProviderConfigInto`). Runs ONCE, after
   * the resume claim and before anything spawns: a second resume racing
   * past the lock-free lookup is refused `session_busy` by the claim, and
   * must not have rewritten the live session's config — model and caps
   * included — before that refusal (review D5, correctness 3). Until it
   * runs, the home holds what its last session left: nothing for a fresh
   * one, the previous config for a resumed one.
   */
  prepareConfig: () => void;
  /**
   * The end-of-session settlement, called once from the driver's end path
   * (the child has settled; nothing writes the home anymore). A resumable
   * end keeps the home as this session's resume state — moved onto the
   * session-keyed path a `--resume` computes, when the session started on
   * a fresh run-shaped one, so the registry's recorded `harness_home` and
   * the directory's real name agree before any resume can run. For a
   * fresh session any other end removes it (`sessionId` null covers a
   * session that never adopted an id): the run-path rule, nothing
   * survives a session codemux will not vouch for. A RESUMED session's
   * home is never removed at settlement (review D3, correctness-2): its
   * state predates this process — the rule `abandon` carries — so a
   * failed or interrupted resume leaves it to the sweep instead of
   * deleting the earlier turns with it. A codemux that dies before its
   * end path leaves the run-shaped name to the stale-run sweep and the
   * session-keyed one to the stale-session sweep.
   *
   * Returns whether the home ended where a resume finds it (review D2,
   * correctness-2 2): true after a successful move onto the key, false
   * when the move failed — the state sits on in the run-shaped name a
   * resume never computes, and a `--resume` would open an empty home and
   * fail inside codex with thread-not-found, so the driver folds this
   * into the reported `resumable` and refuses the caller now instead.
   */
  settle: (sessionId: string | null, resumable: boolean) => boolean;
  /**
   * The failure backstop (the spawn threw, the driver never ran): a fresh
   * session's bare home is removed — nothing of value ever ran in it —
   * while a resumed session's home is left for the sweep, because its
   * state predates this process and is not this process's to delete.
   */
  abandon: () => void;
}

/** The shared stderr shape for a settlement that could not complete: the
 * session's end verdict is already out, so the loss is reported, not
 * raised — and the sweep is what reclaims the directory. */
function warnLostHome(action: string, path: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`codemux: could not ${action} the session's provider home ${path}: ${detail}`);
}

/** Removes a home through its parent's recorded identity (src/safe-remove.ts,
 * review round 104): a run with write access to `~/.codex` could have
 * replaced the parent with a symlink — or another directory — after the home
 * was made, and a recursive removal resolves that component like any path
 * operation would (rm never follows a link at the home's own name). Answers
 * whether the home is gone; a refusal or failure is reported, not raised,
 * because the sweep is what reclaims a kept directory. */
function removeHome(record: TrustedParentRecord, codexHome: string): boolean {
  return removeUnderTrustedParent(
    codexHome,
    record,
    `codex's provider-override home ${codexHome}`
  );
}

/**
 * Creates a FRESH session's home: one `run-<pid>-<random>` directory
 * (the run-path shape, so a codemux that dies mid-session leaves it to
 * the same stale-run sweep), empty until `prepareConfig` writes its
 * config.toml after the claim (a session refused before its spawn
 * writes nothing). The directory is moved onto its session-keyed path
 * only at an orderly, resumable end — the id that keys it arrives at
 * thread/start, after the child is already running against this one
 * (see `settle`).
 */
export function createCodexSessionProviderHome(
  realCodexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null,
  printOnly = false
): CodexSessionProviderHome {
  if (printOnly) return { codexHome: join(realCodexHome, PARENT_DIR_NAME, "preview"),
    prepareConfig: () => {}, settle: () => false, abandon: () => {} };
  const parent = prepareRunDirParent(realCodexHome, PARENT_DIR_NAME);
  // Recorded for the removal's revalidation (src/safe-remove.ts): every
  // session's child can write this shared parent, so a settle or abandon
  // that removes the home must confirm it is still the directory this
  // session's home was made under.
  const parentRecord = recordTrustedParent(parent);
  const codexHome = mkdtempSync(join(parent, runDirectoryPrefix()));
  // mkdtemp's 0700 is masked by the umask; the mode is stated whatever the
  // umask is (review round 401, item 1): a 0500 home would refuse the
  // config write below and end the session at its spawn.
  chmodSync(codexHome, 0o700);
  // The home's own identity, remembered at creation (review round 292):
  // the shared parent is writable by every sandboxed codex child, so one
  // can rename this home away and park another user-owned directory at
  // its name. That replacement passes the parent, shape, and owner checks
  // below, and `settle`'s move would persist it onto the session key —
  // resume state a later session loads. The device and inode pair is the
  // one fact a rename-and-replace cannot forge (the agy probe homes'
  // sameDirectory rule, src/adapters/agy-homes.ts).
  const homeIdentity = lstatSync(codexHome, { bigint: true });
  const prepareConfig = (): void => {
    writeCodexProviderConfigInto(codexHome, override, model, multiAgent);
  };
  let settled = false;
  const settle = (sessionId: string | null, resumable: boolean): boolean => {
    if (settled) return false;
    settled = true;
    if (!resumable || sessionId === null) {
      return removeHome(parentRecord, codexHome);
    }
    const target = codexSessionProviderHomePath(realCodexHome, override.baseUrl, sessionId);
    try {
      // Both components revalidated: a sandboxed child could have swapped
      // either for a symlink during the session, and rename resolves the
      // parent components while moving the name at codexHome itself. The
      // home's IDENTITY too (review round 292): the checks above accept
      // any user-owned replacement parked at the name, and the move would
      // persist that replacement as this session's resume state.
      assertTrustedDirectory(parent);
      assertTrustedDirectory(codexHome);
      const homeNow = lstatSync(codexHome, { bigint: true });
      if (homeNow.dev !== homeIdentity.dev || homeNow.ino !== homeIdentity.ino) {
        throw new Error(`${codexHome} is no longer the directory this session created`);
      }
      renameSync(codexHome, target);
    } catch (error) {
      // A target that already exists (a minted-id collision — the thread
      // ids are codex's own random ids) or a swapped component keeps both
      // directories on disk: warn, and let the sweeps reclaim them. Never
      // delete a directory this process did not create. The state did NOT
      // reach the key, so the session is not resumable: false.
      warnLostHome("set aside", codexHome, error);
      return false;
    }
    try {
      repairCodexHomeRollouts(target);
      return true;
    } catch (error) {
      // The home reached its session key, but its selected rollout paths
      // could not be repaired. Keep it there for recovery; do not claim
      // it is resumable until repair succeeds.
      warnLostHome("repair rollout paths in", target, error);
      return false;
    }
  };
  return {
    codexHome,
    prepareConfig,
    settle,
    abandon: (): void => {
      if (settled) return;
      settled = true;
      removeHome(parentRecord, codexHome);
    },
  };
}

/**
 * Opens a RESUMED session's home at `codexSessionProviderHomePath` — the
 * directory the original session's end moved its threads onto — leaving
 * its config.toml untouched until `prepareConfig` rewrites it after the
 * claim (the child of the earlier process could write this directory, so
 * that write must not follow anything). The home
 * is this session's recorded state, FOUND again — never made: a missing
 * keyed home is refused outright (review D2, correctness-2 2). Creating
 * one silently would hand the resume an empty CODEX_HOME whose only end
 * is a thread-not-found failure inside codex; the earlier session either
 * never settled onto the key (its end warned) or the sweep took it, and
 * the operator needs that said here, not from inside the harness.
 */
export function openCodexSessionProviderHome(
  realCodexHome: string,
  override: ProviderOverride & { baseUrl: string },
  model: string,
  multiAgent: boolean | null,
  sessionId: string,
  printOnly = false
): CodexSessionProviderHome {
  // The parent is created (and its stale entries swept) as a side
  // effect, as at any session or run start — with THIS home's entry
  // spared: the sweep's registry consult answers `free` for an ended
  // record, and a home idle past the 28-day gate would be deleted right
  // here, after `lookupForResume` already vouched for it, leaving the
  // resume a "missing or untrusted" refusal its own setup caused
  // (review D10, correctness-2 3). Any other codemux run may still sweep
  // it; this one just refused to delete what it came to open.
  const codexHome = codexSessionProviderHomePath(realCodexHome, override.baseUrl, sessionId);
  // The preview checks the same parent without creating it or sweeping state.
  if (printOnly) assertTrustedDirectory(codexProviderSessionsParent(realCodexHome));
  else prepareRunDirParent(realCodexHome, PARENT_DIR_NAME, undefined, basename(codexHome));
  try {
    assertTrustedDirectory(codexHome);
  } catch {
    throw new Error(
      `the recorded session home ${codexHome} is missing or untrusted; ` +
        "the session cannot be resumed (the original session's end may have failed " +
        "to settle it, or the stale-home sweep removed it)"
    );
  }
  if (printOnly) return { codexHome, prepareConfig: () => {}, settle: () => true, abandon: () => {} };
  const prepareConfig = (): void => {
    repairCodexHomeRollouts(codexHome);
    writeCodexProviderConfigInto(codexHome, override, model, multiAgent);
  };
  let settled = false;
  return {
    codexHome,
    prepareConfig,
    settle: (): boolean => {
      // Never remove a resumed home at settlement (review D3,
      // correctness-2): its state predates this process — the rule
      // `abandon` below already carries — and a resume that failed or was
      // interrupted before `thread/resume` answered only proves THIS run
      // did not complete, not that the stored state is invalid. Deleting
      // it there destroyed every earlier turn of the session; the 28-day
      // sweep reclaims a home no resume comes back for. The home never
      // moves either: it already sits at the key the next resume
      // computes, so the settlement answer is true whatever this run's
      // verdict was.
      if (settled) return false;
      settled = true;
      return true;
    },
    abandon: (): void => {
      // This process added only its config rewrite; the state underneath
      // predates it, so a failed resume leaves the home to the sweep.
      settled = true;
    },
  };
}
