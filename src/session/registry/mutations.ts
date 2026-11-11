// Registry mutations: the locked atomic read-modify-write, the prune
// to the reader's caps, and the start/touch/end/release/discard
// operations on it. src/session/registry.ts owns the module surface.
import { chmodSync, lstatSync, linkSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readProcessTable } from "../../process-table.js";
import { LOCK_ATTEMPTS, LOCK_RETRY_MS, REGISTRY_DIR_MODE, LockBusyError, acquireLock, currentProcessIdentity, processIdentityAlive, registryPlacementProblem, resolveRegistryPath, writeRegistryAtomic, type LockHandle, type LockOptions } from "../registry-io.js";
import { readRegistry, validRegistryFile, REGISTRY_MAX_BYTES, REGISTRY_MAX_ENTRIES, type RegistryFile, type SessionRecord } from "./format.js";

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
 * or a refusal the mutation named; `busy` is the writer lock held by a
 * live writer past the budget — contention, and the one class the
 * off-stream session start retries behind; `unavailable` is an I/O
 * failure that says nothing about the file's trust — ENOSPC, EACCES, a
 * directory that cannot be created — and failing the update again on a
 * timer would only delay the same verdict. */
export type UpdateOutcome =
  | { ok: true }
  | { ok: false; error: string; kind: "untrusted" | "busy" | "unavailable" };

/** Serialize on the lock, read strictly, mutate, prune, write atomically.
 * `mutate` returns null to write, false to finish without a write, or a failure message — a
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
 * rather than a live exchange (review live13). The one start that runs
 * inside a live exchange — an agent whose first turn's own output names
 * the session id (kimi, opencode, agy) — records off the stream instead:
 * one attempt here, then the deferred retries of
 * `recordSessionStartOffStream` (review round 341). */
export function updateRegistry(
  originalPath: string,
  mutate: (file: RegistryFile) => string | null | false,
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
    // Whether this update creates the directory decides if the mode may
    // be stated: a pre-existing directory keeps the permissions it has —
    // a read-only one the operator froze fails the write below, fail
    // closed, instead of being silently repaired.
    let dirExisted = true;
    try {
      lstatSync(dir);
    } catch {
      dirExisted = false;
    }
    mkdirSync(dir, { recursive: true, mode: REGISTRY_DIR_MODE });
    if (!dirExisted) {
      // The mode is stated whatever the umask is (round 401, item 1): the
      // mkdir mode is masked, and the reader enforces the unmasked value
      // — a hardened umask would wedge every session command behind an
      // untrusted registry.
      chmodSync(dir, REGISTRY_DIR_MODE);
    }
    lock = acquireLock(`${path}.lock`, lockOptions);
    let read = readRegistry(path);
    let corruptBackup: string | null = null;
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
      // Back the corrupt file up beside the registry, start fresh. The
      // live file is NOT removed: the atomic write's rename replaces it
      // once the replacement is known to be writable, so a refusal after
      // this point (a payload the reader rejects) or a failed write
      // leaves a registry the reader still judges — corrupt, fail-closed
      // — instead of a missing one resumes answer not_found (round 401,
      // item 5).
      const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        linkSync(path, backup);
      } catch (error) {
        return { ok: false, error: `cannot back up the corrupt session registry: ${error instanceof Error ? error.message : String(error)}`, kind: "unavailable" };
      }
      corruptBackup = backup;
      read = { outcome: "missing" };
    }
    const file: RegistryFile =
      read.outcome === "ok" ? read.file : { version: 1, sessions: [] };
    const failure = mutate(file);
    // A locked read/action can finish without rewriting or pruning records.
    if (failure === false) return { ok: true };
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
    if (corruptBackup !== null) pruneCorruptBackups(path);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `cannot update the session registry: ${error instanceof Error ? error.message : String(error)}`,
      kind: error instanceof LockBusyError ? "busy" : "unavailable",
    };
  } finally {
    // A release that cannot remove the lock file reports the leftover and
    // never throws: this update already wrote the registry file, so its
    // outcome stays `ok` (registry-io's release, review round 115).
    lock?.release();
  }
}

/** How many `.corrupt-*` backups one registry keeps: repeated corruption
 * must not accumulate copies until the disk fills (round 401, item 5). */
const CORRUPT_BACKUPS_KEPT = 5;

/** After a recovery wrote its replacement, drop the oldest corrupt
 * backups beyond `CORRUPT_BACKUPS_KEPT`. The names carry fixed-width ISO
 * stamps, so lexical order is chronological order; the newest stay. A
 * removal failure is swallowed — the rotation is hygiene, the recovery
 * it follows already succeeded, and the next recovery retries. */
function pruneCorruptBackups(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const backups = names.filter((name) => name.startsWith(prefix)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - CORRUPT_BACKUPS_KEPT))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* left behind; the next recovery retries */
    }
  }
}

/** The record's timestamps and owner identity are registry-owned; the
 * caller supplies everything else (§4.8 sketch). `final` is end-stamped
 * only (recordSessionEnd), never supplied at start. */
export type NewSessionRecord = Omit<
  SessionRecord,
  "created_at" | "last_activity" | "ended" | "owner_pid" | "owner_start" | "final"
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
export function recordSessionStart(
  path: string,
  record: NewSessionRecord,
  lockOptions?: LockOptions
): UpdateOutcome {
  const now = new Date().toISOString();
  const identity = currentProcessIdentity();
  return updateRegistry(
    path,
    (file) => {
      const existing = file.sessions.find((entry) => entry.id === record.id);
      if (existing !== undefined &&
          (existing.agent !== record.agent || existing.harness_home !== record.harness_home)) {
        return `session ${record.id} already belongs to a different agent or harness home (session_collision)`;
      }
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
        // Canonicalized upstream (canonicalSandboxBlockPaths); sorted
        // and deduplicated here so a repeated flag writes one entry.
        sandbox_block: [...new Set(record.sandbox_block)].sort(),
        created_at: existing?.created_at ?? now,
        last_activity: now,
        // A start never stamps final, not even over an existing final
        // record a same-id harness session replaces: the new session is
        // a fresh one whatever the old record carried.
        final: false,
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
    "backup-and-reset",
    lockOptions
  );
}

/** The fatal every driver reports when a session reaches its end with
 * its start record still pending (review round 345): the retries stop
 * at the session's summary with no verdict delivered, the record can
 * never land, and the session ran untracked — the old synchronous
 * record's fail-closed verdict, restored at the one point that still
 * composes the end. */
export const PENDING_RECORD_FATAL =
  "cannot record the session in the registry: the lock stayed busy until the session ended";

/** The session-start record for a driver that learns its session id from
 * its first turn's own output stream (kimi, opencode, agy): one lock
 * attempt inside the stream, and when the failure is merely contention
 * (`busy` — a live writer holds the lock) the same total budget retried
 * on a timer off the stream, so the event loop keeps reading harness
 * output, caller events and signals instead of freezing in the lock's
 * synchronous Atomics.wait (review round 341). `busy` exhausts the
 * budget and delivers the failure; `untrusted` and `unavailable`
 * outcomes deliver at once — nothing a timer can change (an ENOTDIR
 * blocker or an unwritable directory fails every retry identically) —
 * so the caller's fail-closed rule is unchanged. `settled` stops the
 * retries once the session no longer exists to be recorded — and that
 * stop delivers nothing, so the driver's end path owes the pending
 * record its own fail-closed verdict (`PENDING_RECORD_FATAL`). */
export function recordSessionStartOffStream(
  path: string,
  record: NewSessionRecord,
  settled: () => boolean,
  deliver: (outcome: UpdateOutcome) => void,
  warn: (error: string) => void,
  /** A shorter retry budget than the shipped one, for tests that prove
   * the exhaustion path without holding a lock for ten seconds. */
  budget?: { attempts: number; retryMs: number }
): void {
  let attemptsLeft = budget?.attempts ?? LOCK_ATTEMPTS;
  let warned = false;
  const attempt = (): void => {
    if (settled()) return;
    const outcome = recordSessionStart(path, record, { attempts: 1 });
    if (outcome.ok || outcome.kind !== "busy") {
      deliver(outcome);
      return;
    }
    attemptsLeft -= 1;
    if (attemptsLeft <= 0) {
      deliver(outcome);
      return;
    }
    if (!warned) {
      warned = true;
      warn(outcome.error);
    }
    const timer = setTimeout(attempt, budget?.retryMs ?? LOCK_RETRY_MS);
    timer.unref?.();
  };
  attempt();
}

/** The notice a resumed session emits when its off-stream start record
 * exhausts the retry budget behind a busy lock (round 361, item 16): the
 * CLI's pre-spawn claim already wrote the record, so the exhausted
 * retries lost a refresh of a record that exists, not a session that ran
 * untracked — one stderr line, and the session keeps running. The final
 * form of the retrying warning `recordSessionStartOffStream` prints,
 * answering it. Contrast `PENDING_RECORD_FATAL`, the crash a session
 * with no claim owes the same exhaustion. */
export function busyRecordExhaustedNotice(id: string, error: string): string {
  return (
    `codemux: the registry lock stayed busy recording session ${id} (${error}); ` +
    "the retry budget is spent and the resumed session's claim stays the record"
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
 * provenance. `final` (a `--final` session) stamps the record
 * non-resumable in the SAME atomic write as the end: the record is
 * either live-owned or ended-and-final, never ended-and-claimable
 * (review round 10, edges 4). */
export function recordSessionEnd(path: string, id: string, final = false, lockOptions?: LockOptions): UpdateOutcome {
  return updateRegistry(
    path,
    (file) => {
      const entry = file.sessions.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        return "the session registry does not contain that session";
      }
      entry.ended = new Date().toISOString();
      entry.last_activity = entry.ended;
      if (final) entry.final = true;
      return null;
    },
    "fail",
    lockOptions
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
export function releaseSessionRecord(path: string, id: string, final = false, lockOptions?: LockOptions): boolean {
  // The shared turn driver's end path asks for one attempt: a held rival lock
  // must not block shutdown for the default forty tries.
  const outcome = recordSessionEnd(path, id, final, lockOptions);
  if (!outcome.ok) {
    console.error(
      `codemux: cannot stamp the session end for ${id} ` +
        `(${outcome.error}); a resume may report session_busy until the record's owner is reaped`
    );
  }
  return outcome.ok;
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

