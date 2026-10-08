/**
 * The session registry (design §4.8): one JSON file, one entry per
 * session, at a codemux-owned path outside harness state. It is a lookup
 * hint and a cross-agent guard, never an authorization boundary — every
 * security-relevant value of a resumed process comes from the resume
 * command alone; the record contributes no flag, no env, and no path.
 *
 * This module holds the model and the rules: strict shape validation
 * (fail-closed on anything unexpected), read, the locked atomic
 * read-modify-write for start/touch/end, the prune to the reader's caps
 * (1000 entries, 4 MiB) that
 * evicts ended or dead-owner entries first and only under an all-live
 * overflow the oldest live entry, and the resume guard bundle. File
 * mechanics — placement checks, the writer lock, the atomic replace —
 * live in registry-io.ts.
 */

import { linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { FileContentError, readUtf8FileBounded } from "../file-io.js";
import { readProcessTable } from "../process-table.js";
import type { AutonomyLevel } from "../types.js";
import { MAX_PASSTHROUGH_ENV_NAMES } from "../validation.js";
import { MAX_ID_CHARS } from "./protocol.js";
import {
  acquireLock,
  currentProcessIdentity,
  processIdentityAlive,
  REGISTRY_DIR_MODE,
  registryPlacementProblem,
  resolveRegistryPath,
  writeRegistryAtomic,
  type LockHandle,
  type LockOptions,
} from "./registry-io.js";

export { processIdentityAlive, currentProcessIdentity } from "./registry-io.js";

export type SandboxTrust = "untrusted" | "standard" | "trusted";

export interface SessionRecord {
  id: string;
  agent: string;
  created_at: string;
  last_activity: string;
  cwd: string;
  hermetic: boolean;
  harness_home: string;
  model: string | null;
  autonomy: AutonomyLevel;
  sandboxed: boolean;
  sandbox_trust: SandboxTrust;
  /** Containment flags the resume guard compares one-directionally:
   * created-with-`--sandbox-no-net`/`--sandbox-scrub-env` cannot resume
   * without them (a transcript may carry injected content, so the resume
   * may not grant reach creation never did); adding either on resume
   * raises containment and is allowed. */
  sandbox_no_net: boolean;
  sandbox_scrub_env: boolean;
  /** The `--pass-env` names (never values), sorted, and whether the
   * Playwright MCP was enabled: the same one-directional rule (review
   * live16) — a resume may drop a name or the MCP, never add one, since
   * either hands a secret or a browser to a transcript that may already
   * carry injected content. */
  pass_env: string[];
  playwright_mcp: boolean;
  /** The provider identity the session ran under (review D3, security):
   * the override's base URL, or null for the operator's own login. The
   * resume guard refuses a mismatch in both directions — a transcript
   * recorded on one endpoint never replays on another, and an
   * operator-login transcript never runs under an override (the recorded
   * state directory does not move with the endpoint for claude, opencode,
   * or aider, so the harness-home guard cannot carry this rule). Absent
   * on records codemux 0.9.0 wrote: sessions refused every override
   * there, so an absent field is an operator-login session exactly. */
  provider_base_url: string | null;
  owner_pid: number;
  /** Opaque process-start token (`ProcessEntry.start`), or null where
   * the process table was unreadable at record time. A null token makes
   * every later liveness check pid-only wherever it runs — with or
   * without a readable table — so the pid-reuse window is the residual
   * both for null tokens and for unreadable tables at check time. */
  owner_start: string | null;
  ended: string | null;
}

interface RegistryFile {
  version: 1;
  sessions: SessionRecord[];
}

export const REGISTRY_MAX_ENTRIES = 1000;
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
/** validation.ts's `--pass-env` name rule, restated for the reader. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The codemux-owned registry path for a home directory (design §4.8):
 * macOS `~/Library/Application Support/codemux/live-sessions.json`,
 * otherwise `$HOME/.local/state/codemux/live-sessions.json` — derived
 * from `$HOME` alone so moving `XDG_STATE_HOME` cannot hide the record
 * while the transcripts stay put. */
export function sessionRegistryPath(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "codemux", "live-sessions.json");
  }
  return join(home, ".local", "state", "codemux", "live-sessions.json");
}

/** Reach ranking for the resume-autonomy guard: what a session can be
 * made to do, not how much it asks. Per agent (review live9): for
 * claude/zai/codex a low caller can approve anything through the
 * permission round-trip, so low out-reaches high; high out-reaches
 * medium (unscoped edits plus Bash); medium out-reaches read-only.
 * agy has no permission path at all (`permissions: false`, approvals
 * turn into soft denials), so its levels are strictly additive —
 * read-only < low < medium < high, with high the
 * `--dangerously-skip-permissions` flag. */
const AUTONOMY_REACH: Record<AutonomyLevel, number> = {
  "read-only": 0,
  medium: 1,
  high: 2,
  low: 3,
};

/** The strict (low < medium < high) ranking agy's flags exactly form;
 * opencode and aider borrow it as their conservative approximation (see
 * AUTONOMY_REACH_BY_AGENT). */
const STRICT_AUTONOMY_REACH: Record<AutonomyLevel, number> = {
  "read-only": 0,
  low: 1,
  medium: 2,
  high: 3,
};

const AUTONOMY_REACH_BY_AGENT: Record<string, Record<AutonomyLevel, number>> = {
  claude: AUTONOMY_REACH,
  zai: AUTONOMY_REACH,
  codex: AUTONOMY_REACH,
  agy: STRICT_AUTONOMY_REACH,
  // opencode's --agent plan/build and aider's --dry-run/--yes-always are
  // additive flag sets (no permission round-trip exists on either wire),
  // but NOT strictly: opencode's low and medium both spawn
  // `--agent build` and aider's medium and high both spawn
  // `--yes-always` — each ladder has one adjacent tie (opencode-session,
  // aider-session). Strict ranking stays because it is conservative on a
  // tie: it refuses a resume into a level whose command is byte-identical
  // (aider medium→high, opencode low→medium), which costs nothing but a
  // refused resume, while no ranking that folds a tie could ever allow a
  // WIDER command than the recorded one — the guard's one rule (review
  // D1, 2.1).
  opencode: STRICT_AUTONOMY_REACH,
  aider: STRICT_AUTONOMY_REACH,
};

const TRUST_RANK: Record<SandboxTrust, number> = {
  untrusted: 0,
  standard: 1,
  trusted: 2,
};

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = [
    "id", "agent", "created_at", "last_activity", "cwd", "hermetic",
    "harness_home", "model", "autonomy", "sandboxed", "sandbox_trust",
    "sandbox_no_net", "sandbox_scrub_env", "pass_env", "playwright_mcp",
    "provider_base_url", "owner_pid", "owner_start", "ended",
  ];
  if (keys.some((key) => !expected.includes(key))) return false;
  // `provider_base_url` may be the one missing key: a record codemux
  // 0.9.0 wrote. Sessions refused every provider override there, so an
  // absent field is an operator-login session exactly, and refusing it
  // would poison every existing registry as corrupt (review D3). Any
  // other missing key is still corrupt.
  // The tolerance is one-directional by design (review D7, correctness-2
  // 3): 0.10.0 records read fine here, but a co-installed 0.9.0 binary's
  // stricter exact-key validator reads a whole 0.10.0-written registry as
  // corrupt — it refuses every resume and stops recording. That breakage
  // is documented in the 0.10.0 release notes (CHANGELOG) as the
  // downgrade/co-install cost; widening 0.10.0's own validator cannot fix
  // the old binary.
  const missing = expected.filter((key) => !keys.includes(key));
  if (missing.length > 1 || (missing.length === 1 && missing[0] !== "provider_base_url")) {
    return false;
  }
  if (!isNonEmptyString(record["id"], MAX_ID_CHARS)) return false;
  if (!isNonEmptyString(record["agent"], 64)) return false;
  if (!isNonEmptyString(record["created_at"], 64)) return false;
  if (!isNonEmptyString(record["last_activity"], 64)) return false;
  if (typeof record["cwd"] !== "string" || record["cwd"].length === 0) return false;
  if (typeof record["hermetic"] !== "boolean") return false;
  if (typeof record["harness_home"] !== "string" || record["harness_home"].length === 0) return false;
  if (record["model"] !== null && typeof record["model"] !== "string") return false;
  // Object.hasOwn, never `in`: `"constructor" in AUTONOMY_REACH` is true
  // through the prototype chain, and a tampered record carrying such a key
  // would pass validation with a rank that is not a rank (review live11).
  if (typeof record["autonomy"] !== "string" || !Object.hasOwn(AUTONOMY_REACH, record["autonomy"])) return false;
  if (typeof record["sandboxed"] !== "boolean") return false;
  if (typeof record["sandbox_trust"] !== "string" || !Object.hasOwn(TRUST_RANK, record["sandbox_trust"])) return false;
  if (typeof record["sandbox_no_net"] !== "boolean") return false;
  if (typeof record["sandbox_scrub_env"] !== "boolean") return false;
  const passEnv = record["pass_env"];
  if (
    !Array.isArray(passEnv) ||
    passEnv.length > MAX_PASSTHROUGH_ENV_NAMES ||
    !passEnv.every((name) => typeof name === "string" && ENV_NAME_PATTERN.test(name))
  ) {
    return false;
  }
  if (typeof record["playwright_mcp"] !== "boolean") return false;
  const provider = record["provider_base_url"];
  if (provider !== undefined && provider !== null && typeof provider !== "string") return false;
  if (typeof provider === "string" && provider.length === 0) return false;
  if (!Number.isInteger(record["owner_pid"]) || (record["owner_pid"] as number) <= 0) return false;
  if (record["owner_start"] !== null && typeof record["owner_start"] !== "string") return false;
  if (record["ended"] !== null && typeof record["ended"] !== "string") return false;
  return true;
}

function validRegistryFile(value: unknown): RegistryFile | null {
  if (typeof value !== "object" || value === null) return null;
  const file = value as Record<string, unknown>;
  if (file["version"] !== 1) return null;
  if (!Array.isArray(file["sessions"])) return null;
  if (file["sessions"].length > REGISTRY_MAX_ENTRIES) return null;
  if (!file["sessions"].every(validRecord)) return null;
  // Normalize the legacy shape: a 0.9.0 record that predates
  // `provider_base_url` (valid above) reads as operator login, so no use
  // site can ever see an `undefined` the type does not promise. The next
  // write persists the explicit null.
  return {
    version: 1,
    sessions: file["sessions"].map((entry) => ({
      ...entry,
      provider_base_url: entry["provider_base_url"] ?? null,
    })),
  };
}

export type RegistryRead =
  | { outcome: "ok"; file: RegistryFile }
  | { outcome: "missing" }
  | { outcome: "untrusted"; reason: string }
  | { outcome: "corrupt"; reason: string }
  /** The read failed for a reason that says nothing about the file
   * (descriptor exhaustion, an I/O error): a retry may pass (review
   * live22). */
  | { outcome: "unavailable"; reason: string };

/** Read errors that are the host's state, not the file's trust. */
const TRANSIENT_READ_CODES: ReadonlySet<string> = new Set([
  "EMFILE",
  "ENFILE",
  "EIO",
  "EAGAIN",
  "EINTR",
  "ENOMEM",
]);

/** Read and strictly validate the registry. Every failure is a distinct
 * outcome so resume can fail closed on each class (§4.8 failure
 * policy); only the fresh-start writers, `recordSessionStart` and
 * `probeRegistryForStart`, treat corrupt as recoverable (backup and
 * reset).
 * The read runs on the resolved path, so a symlinked ancestor passes
 * the placement check once and cannot be re-linked between check and
 * open. */
export function readRegistry(path: string): RegistryRead {
  const placement = registryPlacementProblem(path);
  if (placement !== null) return { outcome: "untrusted", reason: placement };
  // An oversize file passed the placement checks, so it is codemux's own
  // file with bad content: corrupt, which a fresh start backs up and
  // resets, not untrusted, which blocked every new session until someone
  // deleted it (review live18). The bounded read below classes a file
  // that grows past the cap after this check, or holds invalid UTF-8, the
  // same way (review live23).
  try {
    const stat = lstatSync(resolveRegistryPath(path));
    if (stat.isFile() && stat.size > REGISTRY_MAX_BYTES) {
      return {
        outcome: "corrupt",
        reason: `the session registry exceeds ${REGISTRY_MAX_BYTES} bytes`,
      };
    }
  } catch {
    // Missing or unreadable: the read below classifies it.
  }
  let text: string;
  try {
    text = readUtf8FileBounded(resolveRegistryPath(path), {
      maxBytes: REGISTRY_MAX_BYTES,
      label: "session registry",
      noFollow: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { outcome: "missing" };
    if (error instanceof FileContentError) return { outcome: "corrupt", reason: error.message };
    if (code !== undefined && TRANSIENT_READ_CODES.has(code)) {
      return { outcome: "unavailable", reason: `cannot read the session registry: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { outcome: "untrusted", reason: `cannot read the session registry: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { outcome: "corrupt", reason: "the session registry is not valid JSON" };
  }
  const file = validRegistryFile(parsed);
  if (file === null) {
    return { outcome: "corrupt", reason: "the session registry does not match the expected shape" };
  }
  return { outcome: "ok", file };
}

/** The bytes one record adds to the written file: its pretty-printed
 * JSON, four spaces of array indentation per line, and its separator. */
function recordBytes(entry: SessionRecord): number {
  const text = JSON.stringify(entry, null, 2);
  return Buffer.byteLength(text) + 4 * text.split("\n").length + 2;
}

/** The written file's bytes outside its records, rounded up. */
const REGISTRY_FRAME_BYTES = 64;

function prune(file: RegistryFile): void {
  // Two budgets, both the reader's: the entry cap and the byte cap. A
  // file past either is one the reader rejects, so the writer evicts
  // until both hold (review live18 — only the count was enforced, and a
  // registry of long records could pass 4 MiB and lock every start out).
  const sizes = new Map(file.sessions.map((entry) => [entry.id, recordBytes(entry)]));
  let count = file.sessions.length;
  let bytes = REGISTRY_FRAME_BYTES;
  for (const size of sizes.values()) bytes += size;
  const over = (): boolean => count > REGISTRY_MAX_ENTRIES || bytes > REGISTRY_MAX_BYTES;
  if (!over()) return;
  const ordered = [...file.sessions].sort((a, b) =>
    a.last_activity < b.last_activity ? -1 : a.last_activity > b.last_activity ? 1 : 0
  );
  const doomed = new Set<string>();
  // One process-table snapshot for the whole pass: each unread table is
  // a process enumeration, and this runs inside the held writer lock —
  // a liveness probe per live owner would hold the lock for that many
  // enumerations and starve every other codemux writer (review live13).
  const table = readProcessTable();
  // Pass 1 — ended or dead-owner entries go first, oldest first; a live
  // owner is never evicted while an evictable entry remains (§4.8).
  const doom = (entry: SessionRecord): void => {
    doomed.add(entry.id);
    count -= 1;
    bytes -= sizes.get(entry.id) ?? 0;
  };
  for (const entry of ordered) {
    if (!over()) break;
    if (entry.ended === null && processIdentityAlive(entry.owner_pid, entry.owner_start, table)) {
      continue;
    }
    doom(entry);
  }
  // Pass 2 — the file the writer leaves must be one its own validator
  // accepts (validRegistryFile rejects more than REGISTRY_MAX_ENTRIES as
  // corrupt), and the corrupt path is the worse loss: every resume fails
  // closed untrusted, and the next start's backup-and-reset drops EVERY
  // record, live owners included. When every survivor of pass 1 has a
  // live owner, evict the oldest by last_activity anyway — the registry
  // is a lookup hint (§4.8), so an evicted session's resume answers
  // not_found, a smaller, fail-closed loss than a registry no reader
  // trusts (review live13).
  for (const entry of ordered) {
    if (!over()) break;
    if (doomed.has(entry.id)) continue;
    doom(entry);
  }
  file.sessions = file.sessions.filter((entry) => !doomed.has(entry.id));
}

/** A failed update names its class (review live22): `untrusted` is a
 * registry codemux will not vouch from (placement, owner or mode, a
 * corrupt file under the "fail" policy, a write no reader would accept)
 * or a refusal the mutation named; `unavailable` is an I/O failure that
 * says nothing about the file's trust — a lock held past the budget,
 * ENOSPC, EACCES — and may pass on a retry. */
export type UpdateOutcome =
  | { ok: true }
  | { ok: false; error: string; kind: "untrusted" | "unavailable" };

/** Serialize on the lock, read strictly, mutate, prune, write atomically.
 * `mutate` returns null on success or the specific failure message — a
 * refusal it can name (the ownership claim) rather than the generic
 * not-found error the caller cannot act on. `onCorrupt` decides the
 * recoverable class: a new session's start backs the file up beside the
 * registry and starts fresh; an update against a corrupt registry is
 * skipped with an error (nothing trustworthy to update). Every file
 * operation — lock, read, backup, atomic write — runs on the resolved
 * path. The outcome contract is total: a filesystem error anywhere in
 * here (a parent directory that cannot be created — an EPERM'd home, a
 * file where a directory is needed) is a failed update, never a throw
 * past the caller's fail-closed branch.
 *
 * The lock's retry sleep is a synchronous Atomics.wait, so a waiting
 * update freezes the caller's whole event loop — reads of the harness's
 * stdout, caller events, signal handlers — for the full budget. The
 * turn-path touch therefore passes a single-attempt lock (`attempts: 1`:
 * one sweep, fail fast, never a wait); start and end keep the full
 * budget, because their writes are load-bearing (a failed start fails
 * the session closed, a failed end leaves a live-looking owner) and
 * they run at session boundaries, where a wait delays the boundary
 * rather than a live exchange (review live13). */
function updateRegistry(
  originalPath: string,
  mutate: (file: RegistryFile) => string | null,
  onCorrupt: "backup-and-reset" | "fail",
  lockOptions?: LockOptions
): UpdateOutcome {
  let lock: LockHandle | null = null;
  try {
    // The placement rules read the caller's own spelling first: the
    // reader refuses a symlinked registry directory or file under it, and
    // a writer that only ever saw the resolved spelling accepted the link
    // and recorded sessions no resume could then read (review live18).
    const placement = registryPlacementProblem(originalPath);
    if (placement !== null) {
      return { ok: false, error: `untrusted session registry: ${placement}`, kind: "untrusted" };
    }
    const path = resolveRegistryPath(originalPath);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    lock = acquireLock(`${path}.lock`, lockOptions);
    let read = readRegistry(path);
    if (read.outcome === "unavailable") {
      return { ok: false, error: read.reason, kind: "unavailable" };
    }
    if (read.outcome === "untrusted") {
      return { ok: false, error: `untrusted session registry: ${read.reason}`, kind: "untrusted" };
    }
    if (read.outcome === "corrupt") {
      if (onCorrupt === "fail") {
        return { ok: false, error: `corrupt session registry: ${read.reason}`, kind: "untrusted" };
      }
      // Back the corrupt file up beside the registry, start fresh.
      const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        linkSync(path, backup);
        unlinkSync(path);
      } catch (error) {
        return { ok: false, error: `cannot back up the corrupt session registry: ${error instanceof Error ? error.message : String(error)}`, kind: "unavailable" };
      }
      read = { outcome: "missing" };
    }
    const file: RegistryFile =
      read.outcome === "ok" ? read.file : { version: 1, sessions: [] };
    const failure = mutate(file);
    if (failure !== null) {
      return { ok: false, error: failure, kind: "untrusted" };
    }
    prune(file);
    // Validate what is about to be written with the reader's own rules: a
    // record the reader rejects (a harness-supplied id past the cap) would
    // otherwise make the whole file corrupt — every resume fails closed
    // and the next start's backup-and-reset drops every record, live
    // owners included (review live16). Refuse the update instead.
    const payload = `${JSON.stringify(file, null, 2)}\n`;
    if (validRegistryFile(file) === null || Buffer.byteLength(payload) > REGISTRY_MAX_BYTES) {
      return { ok: false, error: "the update would leave a session registry no reader accepts; nothing was written", kind: "untrusted" };
    }
    writeRegistryAtomic(path, payload);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `cannot update the session registry: ${error instanceof Error ? error.message : String(error)}`, kind: "unavailable" };
  } finally {
    lock?.release();
  }
}

/** The record's timestamps and owner identity are registry-owned; the
 * caller supplies everything else (§4.8 sketch). */
export type NewSessionRecord = Omit<
  SessionRecord,
  "created_at" | "last_activity" | "ended" | "owner_pid" | "owner_start"
>;

/** Written at `session_started` — the session exists once the harness
 * ack'd an id. A same-id record updates in place (a resumed claude
 * session continues under the same `session_id`) — but only when no
 * other live process owns it. A resume already claimed the record
 * before spawning (`claimForResume`), so this check is the backstop
 * for a harness-supplied id that collides with a live record: the
 * second start write must not silently take over a record whose live
 * owner is another session. The loser fails closed (the driver's
 * registry-start fatal, exit 1) with the same `session_busy` refusal
 * resume uses. This decides who owns the record — a lookup hint, never
 * an authorization boundary. */
export function recordSessionStart(path: string, record: NewSessionRecord): UpdateOutcome {
  const now = new Date().toISOString();
  const identity = currentProcessIdentity();
  return updateRegistry(
    path,
    (file) => {
      const existing = file.sessions.find((entry) => entry.id === record.id);
      // The self check compares the pid alone: no other live process can
      // hold this process's pid, so a record under it is this process's
      // own claim or a dead predecessor's. Comparing the start token too
      // refused the resume's own claim whenever the claim's `ps` reading
      // and this one disagreed (one timed out to null, review live20).
      if (
        existing !== undefined &&
        existing.ended === null &&
        existing.owner_pid !== identity.pid &&
        processIdentityAlive(existing.owner_pid, existing.owner_start)
      ) {
        return `session ${record.id} is still owned by live process ${existing.owner_pid} (session_busy)`;
      }
      const full: SessionRecord = {
        ...record,
        pass_env: [...record.pass_env].sort(),
        created_at: existing?.created_at ?? now,
        last_activity: now,
        ended: null,
        owner_pid: identity.pid,
        owner_start: identity.start,
      };
      if (existing !== undefined) {
        file.sessions[file.sessions.indexOf(existing)] = full;
      } else {
        file.sessions.push(full);
      }
      return null;
    },
    "backup-and-reset"
  );
}

/** The pre-spawn check for a fresh agy session, whose id only its first
 * result names — that turn necessarily runs before the record can be
 * written (codex records at the thread handshake, before any turn; the
 * claude family records before the spawn). The same locked read-and-write a start record
 * performs, with nothing changed, so an untrusted registry, a busy lock,
 * or an unwritable directory refuses the session before its harness can
 * act on the caller's first input (review live22). A failure between
 * this check and the start record still fails the session closed. */
export function probeRegistryForStart(path: string): UpdateOutcome {
  return updateRegistry(path, () => null, "backup-and-reset");
}

/** Stamp `last_activity` (the pruning key) without touching state. The
 * optional lock budget exists for the turn path: `attempts: 1` never
 * waits behind another writer (see updateRegistry). */
export function touchSession(path: string, id: string, lockOptions?: LockOptions): UpdateOutcome {
  return updateRegistry(
    path,
    (file) => {
      const entry = file.sessions.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        return "the session registry does not contain that session";
      }
      entry.last_activity = new Date().toISOString();
      return null;
    },
    "fail",
    lockOptions
  );
}

/** Set `ended` and refresh `last_activity`; the owner fields stay as
 * provenance. */
export function recordSessionEnd(path: string, id: string): UpdateOutcome {
  return updateRegistry(
    path,
    (file) => {
      const entry = file.sessions.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        return "the session registry does not contain that session";
      }
      entry.ended = new Date().toISOString();
      entry.last_activity = entry.ended;
      return null;
    },
    "fail"
  );
}

/** Stamp the end on every end path — the drivers' and the CLI's
 * spawn-failure release — and report a lost stamp on stderr. The stamp
 * is what clears the record's live-looking owner; losing it can cost a
 * `session_busy` refusal on the next resume (whenever a reused pid passes
 * the liveness check), never a wrong allow: a stale entry is stolen only
 * once this process is dead. `recordSessionEnd` returns failures as
 * values, so a caller that drops the outcome leaves no trace (review
 * live13 for the drivers, live21 for the CLI). */
export function releaseSessionRecord(path: string, id: string): void {
  const outcome = recordSessionEnd(path, id);
  if (!outcome.ok) {
    console.error(
      `codemux: cannot stamp the session end for ${id} ` +
        `(${outcome.error}); a resume may report session_busy until the record's owner is reaped`
    );
  }
}

/** Remove a fresh session's pre-spawn record that the harness never
 * confirmed (review live22): no transcript exists behind it, so keeping
 * it would send a later `--resume` to the harness (exit 1) instead of
 * the not-found answer (exit 66). Only this process's own record is
 * removed; a lost removal is reported on stderr like a lost end stamp
 * and leaves an ended record, which costs only that exit code. */
export function discardUnconfirmedRecord(path: string, id: string): void {
  const identity = currentProcessIdentity();
  const outcome = updateRegistry(
    path,
    (file) => {
      const index = file.sessions.findIndex(
        (candidate) => candidate.id === id && candidate.owner_pid === identity.pid
      );
      if (index !== -1) file.sessions.splice(index, 1);
      return null;
    },
    "fail"
  );
  if (!outcome.ok) {
    console.error(
      `codemux: cannot remove the unconfirmed session record ${id} (${outcome.error})`
    );
    releaseSessionRecord(path, id);
  }
}

/** What a resume attempt is running as, for the guard bundle. */
export interface ResumeProbe {
  agent: string;
  harnessHome: string;
  /** The resume's validated (canonical) working directory: it must be
   * the recorded one — a resumed transcript gets no other tree. */
  cwd: string;
  /** The resume's `--pass-env` names and Playwright flag: neither may
   * add what creation lacked (review live16). */
  passEnv: readonly string[];
  playwrightMcp: boolean;
  autonomy: AutonomyLevel;
  sandboxed: boolean;
  sandboxTrust: SandboxTrust;
  /** The flags the resuming command actually runs with — a resume may
   * not clear one the entry was created under. */
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
  /** The provider identity the resume runs under (review D3, security):
   * the override's base URL, or null for the operator's own login. Must
   * equal the recorded identity — the harness state directory does not
   * move with the endpoint, so this is the only guard that stops a
   * transcript replaying on another provider. */
  providerBaseUrl: string | null;
  hermetic: boolean;
}

export type ResumeLookup =
  | { outcome: "ok"; entry: SessionRecord }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: string }
  | { outcome: "untrusted"; reason: string }
  /** The claim could not reach the registry (a busy lock, an I/O error):
   * nothing was judged, so this is no refusal, and a retry may pass
   * (review live22). */
  | { outcome: "unavailable"; reason: string };

function stripTrailingSlash(dir: string): string {
  if (dir.length > 1 && dir.endsWith("/")) return dir.slice(0, -1);
  return dir;
}

/** Whether the registry (at `path`) sits inside `dir`, both sides
 * resolved like every registry I/O (§4.8): the containment test behind
 * both the start-time writable-set refusal and the resume-time untrusted
 * check — one rule, so the two cannot drift. A root `dir` ("/") contains
 * every absolute path; the prefix form below would otherwise demand the
 * double leading slash no real path has, letting a `--cwd /` session
 * bypass both guards (review live7). */
export function registryInside(path: string, dir: string): boolean {
  const scope = stripTrailingSlash(resolveRegistryPath(dir));
  const resolved = resolveRegistryPath(path);
  const prefix = scope === "/" ? "/" : `${scope}/`;
  return resolved === scope || resolved.startsWith(prefix);
}

/** What the registry says about a session id right now: `held` (an open
 * record whose owner identity is alive), `free` (a readable registry
 * holds no live record for the id — no record, an ended one, or a dead
 * owner), or `unknown` (the registry could not be read: a busy lock, an
 * I/O error, an untrusted or corrupt file). The file-sweepers'
 * liveness skip — a session another codemux process is running must
 * never be aged out of on-disk state however old its files look (aider
 * only ever appends to `history.md`, so a long-lived session's
 * directory mtime can sit at creation time; review D2, security 2).
 * A DELETION acts only on a positive `free`: `unknown` spares the
 * directory, because an unreadable registry turned into a false
 * "not held" deleted a live session's home during a transient read
 * failure (review D5, correctness 1). A missing registry is `free`
 * outright — no file means no session can be held. */
export type SessionHold = "held" | "free" | "unknown";

export function sessionHoldState(path: string, id: string): SessionHold {
  const read = readRegistry(path);
  if (
    read.outcome === "unavailable" ||
    read.outcome === "untrusted" ||
    read.outcome === "corrupt"
  ) {
    return "unknown";
  }
  if (read.outcome === "missing") return "free";
  const entry = read.file.sessions.find((session) => session.id === id);
  if (entry === undefined) return "free";
  return entry.ended === null && processIdentityAlive(entry.owner_pid, entry.owner_start)
    ? "held"
    : "free";
}

/** The §4.8 resume guard bundle. Every rule is a refusal (the registry
 * bounds, it never widens): the entry exists (exit 66 at the CLI),
 * `agent` matches (the cross-agent replay guard, checked by agent so it
 * holds even on the shared claude/zai home), `harness_home` matches (no
 * account hop), the provider identity matches — the override base URL,
 * or operator login when none; a transcript recorded on one endpoint
 * never replays on another (review D3) — containment does not drop
 * (`sandboxed`, never at a
 * higher trust than creation, and never clearing the recorded
 * `--sandbox-no-net`/`--sandbox-scrub-env` flags), `cwd` matches, no
 * `--pass-env` name and no Playwright MCP is added (review live16), the
 * resuming `--auto` does not exceed the recorded autonomy ranked by
 * reach, `hermetic` matches, the owner
 * is not live (exit 78 `session_busy`), and the registry itself does
 * not sit inside the resumed entry's own `cwd` or `harness_home` — the
 * file the child could have altered is untrusted. This read takes no
 * lock: it only exits early, and `claimForResume` repeats the judgment
 * under the lock before anything spawns. */
export function lookupForResume(
  path: string,
  id: string,
  probe: ResumeProbe
): ResumeLookup {
  const read = readRegistry(path);
  if (read.outcome === "missing") return { outcome: "not_found" };
  if (read.outcome === "untrusted") return { outcome: "untrusted", reason: read.reason };
  if (read.outcome === "unavailable") return { outcome: "unavailable", reason: read.reason };
  if (read.outcome === "corrupt") {
    return { outcome: "untrusted", reason: `fail-closed on a corrupt registry: ${read.reason}` };
  }
  return judgeResumeEntry(path, read.file, id, probe);
}

/** The resume guard bundle and the ownership claim in one locked
 * update (review live19). `lookupForResume` reads without the lock, so
 * two resumes of one id could both pass it; on the claude family the
 * record was claimed only at the init frame, after the caller's first
 * input had already reached the harness, so the loser's harness acted
 * on that input before it was refused. The claim runs before the spawn:
 * it re-judges the entry under the writer lock and stamps this process
 * as the live owner, so a concurrent resume is refused `session_busy`
 * before it spawns anything. The driver's later `recordSessionStart`
 * finds its own pid and updates in place. The CLI hands the claim to the
 * driver (`adoptResumeClaim`), whose every end path stamps `ended`, and
 * releases it itself when the spawn throws (review live20). */
export function claimForResume(path: string, id: string, probe: ResumeProbe): ResumeLookup {
  let verdict: ResumeLookup | null = null;
  const identity = currentProcessIdentity();
  const outcome = updateRegistry(
    path,
    (file) => {
      verdict = judgeResumeEntry(path, file, id, probe);
      if (verdict.outcome !== "ok") return verdict.outcome;
      const entry = verdict.entry;
      entry.owner_pid = identity.pid;
      entry.owner_start = identity.start;
      entry.ended = null;
      entry.last_activity = new Date().toISOString();
      return null;
    },
    "fail"
  );
  const judged = verdict as ResumeLookup | null;
  if (judged !== null && (judged.outcome !== "ok" || outcome.ok)) return judged;
  if (!outcome.ok && outcome.kind === "unavailable") {
    return { outcome: "unavailable", reason: outcome.error };
  }
  return {
    outcome: "untrusted",
    reason: outcome.ok ? "the resume claim was not judged" : outcome.error,
  };
}

/** The provider identity as a refusal names it: the override's
 * endpoint, or the operator's own login (review D3). */
function providerSurface(baseUrl: string | null): string {
  return baseUrl === null ? "the operator's own login" : `the provider override at ${baseUrl}`;
}

function judgeResumeEntry(
  path: string,
  file: RegistryFile,
  id: string,
  probe: ResumeProbe
): ResumeLookup {
  const entry = file.sessions.find((candidate) => candidate.id === id);
  if (entry === undefined) return { outcome: "not_found" };
  if (entry.agent !== probe.agent) {
    return {
      outcome: "refused",
      reason: `session ${id} belongs to agent ${entry.agent}, not ${probe.agent}`,
    };
  }
  if (entry.harness_home !== probe.harnessHome) {
    return {
      outcome: "refused",
      reason: `session ${id} was created against harness home ${entry.harness_home}, not ${probe.harnessHome}`,
    };
  }
  // The provider identity (review D3, security): the harness state
  // directory does not move with the endpoint for claude, opencode, or
  // aider, so the home guard above cannot carry this rule. A transcript
  // recorded on one endpoint never replays on another, and an
  // operator-login transcript never runs under an override — either
  // direction hands the conversation to a provider the caller never
  // chose at creation.
  if (entry.provider_base_url !== probe.providerBaseUrl) {
    return {
      outcome: "refused",
      reason: `session ${id} was created against ${providerSurface(entry.provider_base_url)} and cannot resume against ${providerSurface(probe.providerBaseUrl)}`,
    };
  }
  if (entry.sandboxed && !probe.sandboxed) {
    return {
      outcome: "refused",
      reason: `session ${id} was created under scode and cannot resume unsandboxed`,
    };
  }
  if (entry.sandboxed && TRUST_RANK[probe.sandboxTrust] > TRUST_RANK[entry.sandbox_trust]) {
    return {
      outcome: "refused",
      reason: `session ${id} was created at sandbox trust ${entry.sandbox_trust} and cannot resume at ${probe.sandboxTrust}`,
    };
  }
  // One-directional containment flags (§4.8): clearing a flag grants reach
  // creation never allowed — the resumed transcript may carry injected
  // content — while adding one only tightens.
  if (entry.sandbox_no_net && !probe.sandboxNoNet) {
    return {
      outcome: "refused",
      reason: `session ${id} was created with --sandbox-no-net and cannot resume without it`,
    };
  }
  if (entry.sandbox_scrub_env && !probe.sandboxScrubEnv) {
    return {
      outcome: "refused",
      reason: `session ${id} was created with --sandbox-scrub-env and cannot resume without it`,
    };
  }
  // The same rule for the remaining reach a resume could add (review
  // live16): another tree, a secret, or a browser handed to a transcript
  // that may already carry injected content. Both cwds are canonical
  // (validateWorkingDirectory realpaths them), so equality is exact.
  if (entry.cwd !== probe.cwd) {
    return {
      outcome: "refused",
      reason: `session ${id} was created in ${entry.cwd} and cannot resume in ${probe.cwd}`,
    };
  }
  const added = probe.passEnv.filter((name) => !entry.pass_env.includes(name));
  if (added.length > 0) {
    return {
      outcome: "refused",
      reason: `session ${id} was created without --pass-env ${[...added].sort().join(",")} and cannot resume with it`,
    };
  }
  if (probe.playwrightMcp && !entry.playwright_mcp) {
    return {
      outcome: "refused",
      reason: `session ${id} was created without --enable-playwright-mcp and cannot resume with it`,
    };
  }
  // Ranked per agent (review live9): agy's ranking is strict, and an
  // agent without a mapping is ranked strict too — the conservative
  // reading for a name a future release may add.
  const reach = AUTONOMY_REACH_BY_AGENT[probe.agent] ?? STRICT_AUTONOMY_REACH;
  if (reach[probe.autonomy] > reach[entry.autonomy]) {
    return {
      outcome: "refused",
      reason: `session ${id} was created at autonomy ${entry.autonomy} and cannot resume above it at ${probe.autonomy}`,
    };
  }
  if (entry.hermetic !== probe.hermetic) {
    return {
      outcome: "refused",
      reason: `session ${id} was created ${entry.hermetic ? "hermetic" : "non-hermetic"} and the resume is ${probe.hermetic ? "hermetic" : "non-hermetic"}`,
    };
  }
  // This process's own pid is never a rival owner, the same exemption
  // recordSessionStart makes: an unended record a dead process left under
  // a pid since reused by this one (start token null, so liveness is the
  // bare pid) refused every resume from it as busy (review live25).
  if (
    entry.ended === null &&
    entry.owner_pid !== process.pid &&
    processIdentityAlive(entry.owner_pid, entry.owner_start)
  ) {
    return {
      outcome: "refused",
      reason: `session ${id} is still owned by live process ${entry.owner_pid} (session_busy)`,
    };
  }
  // Containment is judged with both sides resolved: the registry path is
  // resolved like every other registry I/O, and the recorded cwd/home are
  // resolved to match, so a symlinked ancestor on either spelling cannot
  // hide a real containment.
  const insideCwd = registryInside(path, entry.cwd);
  const insideHome = registryInside(path, entry.harness_home);
  if (insideCwd || insideHome) {
    return {
      outcome: "untrusted",
      reason: `the registry sits inside the session's own ${insideCwd ? "cwd" : "harness home"} — the child could have altered it`,
    };
  }
  return { outcome: "ok", entry };
}
