// Registry mutations: the locked atomic read-modify-write, the prune
// to the reader's caps, and the start/touch/end/release/discard
// operations on it. src/session/registry.ts owns the module surface.
import { linkSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { readProcessTable } from "../../process-table.js";
import { REGISTRY_DIR_MODE, acquireLock, currentProcessIdentity, processIdentityAlive, registryPlacementProblem, resolveRegistryPath, writeRegistryAtomic, type LockHandle, type LockOptions } from "../registry-io.js";
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
export function updateRegistry(
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
 * provenance. `final` (a `--final` session) stamps the record
 * non-resumable in the SAME atomic write as the end: the record is
 * either live-owned or ended-and-final, never ended-and-claimable
 * (review round 10, edges 4). */
export function recordSessionEnd(path: string, id: string, final = false): UpdateOutcome {
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
export function releaseSessionRecord(path: string, id: string, final = false): boolean {
  const outcome = recordSessionEnd(path, id, final);
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

