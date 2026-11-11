import {
  accessSync,
  constants,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function isWithin(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

/** What a trust check saw, for the pre-spawn re-stat below. Size and the
 * two nanosecond timestamps join dev/ino/mode because an in-place rewrite
 * (open, truncate, write) keeps the inode, the mode, and — when the writer
 * back-dates it — even the mtime; ctime cannot be set from user space, so
 * any rewrite still changes the recorded identity. */
interface ExecutableIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** One place builds the identity, so the record and the re-stat compare
 * the same fields by construction. */
const identityOf = (stat: BigIntStats): ExecutableIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
});

/** One place compares it: every recorded field must match the re-stat. */
const identityChanged = (recorded: ExecutableIdentity, stat: BigIntStats): boolean =>
  recorded.dev !== stat.dev ||
  recorded.ino !== stat.ino ||
  recorded.mode !== stat.mode ||
  recorded.size !== stat.size ||
  recorded.mtimeNs !== stat.mtimeNs ||
  recorded.ctimeNs !== stat.ctimeNs;

/** Appends one accepted identity under one spelling, deduplicated: an
 * unchanged binary re-resolved by a later launch in the same process adds
 * no second copy of the identity it already has. */
const recordIdentity = (path: string, identity: ExecutableIdentity): void => {
  const recorded = trustedIdentities.get(path);
  if (recorded === undefined) {
    trustedIdentities.set(path, [identity]);
    return;
  }
  const unchanged = (candidate: ExecutableIdentity): boolean =>
    candidate.dev === identity.dev &&
    candidate.ino === identity.ino &&
    candidate.mode === identity.mode &&
    candidate.size === identity.size &&
    candidate.mtimeNs === identity.mtimeNs &&
    candidate.ctimeNs === identity.ctimeNs;
  if (!recorded.some(unchanged)) recorded.push(identity);
};

// Every executable resolveTrustedExecutable accepted, by resolved path — a
// LIST per path, never one record. Two launches in one process can check
// different versions of the same path (the binary replaced between them),
// and a single record would let the second check overwrite the first's
// expected identity; each accepted identity is kept instead. The spawn
// sites re-stat their command against this before exec, so a binary
// swapped after its check — by any writer with access to the file — is
// refused instead of executed: a re-stat passes only when it matches one
// recorded identity exactly, and an exact match is proof the bytes are
// ones this process trust-checked (same inode, size, mode, and every
// timestamp — ctime cannot be set back from user space).
const trustedIdentities = new Map<string, ExecutableIdentity[]>();

export function resolveTrustedExecutable(
  binaryPath: string,
  label: string,
  forbiddenRoot?: string
): string {
  let resolvedBinary: string;
  let identity: ExecutableIdentity;
  try {
    resolvedBinary = realpathSync(resolve(binaryPath));
    // BigInt stats: the identity below needs the nanosecond timestamps.
    const stat = statSync(resolvedBinary, { bigint: true });
    if (!stat.isFile()) {
      throw new Error("path is not a regular file");
    }
    accessSync(resolvedBinary, constants.X_OK);
    if (process.platform !== "win32") {
      if ((stat.mode & 0o022n) !== 0n) {
        throw new Error("path must not be group- or world-writable");
      }
      if (
        typeof process.getuid === "function" &&
        stat.uid !== BigInt(process.getuid()) &&
        stat.uid !== 0n
      ) {
        throw new Error("path must be owned by the current user or root");
      }
    }
    identity = identityOf(stat);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${label} binary is not a trusted executable${detail}`);
  }

  if (
    forbiddenRoot !== undefined &&
    isWithin(resolvedBinary, realpathSync(resolve(forbiddenRoot)))
  ) {
    // No record survives a refusal (review round 14, edges 13): the
    // identity is recorded only after every refusal has passed, so a
    // binary this call refused leaves nothing a later spawn in this
    // process could re-check — and pass — against.
    throw new Error(
      `${label} binary must not be inside the execution working directory`
    );
  }
  // The identity is recorded under BOTH spellings the caller may pass
  // back to assertExecutablesUnchanged: the resolved path and the path
  // as it was handed in. resolveTrustedCommand returns the unresolved
  // path for an `env` prefix (to keep argv[0]), so recording only the
  // resolved path left the re-check lookup empty — and the check
  // silently skipped — for every env command reached through a symlink
  // (review round 2, edges 2). statSync follows symlinks, so a re-stat
  // of the as-passed path still compares the target's identity.
  recordIdentity(resolvedBinary, identity);
  if (resolvedBinary !== resolve(binaryPath)) {
    recordIdentity(resolve(binaryPath), identity);
  }
  return resolvedBinary;
}

/**
 * Re-stats every trust-checked executable the spawn is about to exec and
 * refuses a change. Probes, option resolution, and environment builds can
 * sit between a command's trust check and its spawn, and a writer with
 * access to the binary could replace it inside that window; comparing
 * dev/ino/mode/size/mtimeNs/ctimeNs closes it except for the short window
 * between this stat and the exec itself (the documented same-UID residual,
 * docs/isolation.md). An in-place rewrite is caught too: it keeps the inode
 * and the mode, but its size or timestamps move, and ctime cannot be set
 * back from user space. Arguments that were never trust-checked are
 * ignored, so a whole command array can be passed as-is.
 *
 * A path this launch resolved itself arrives as a check (executableCheck /
 * trustCheckedCommandChecks) and its re-stat compares THAT identity alone
 * (review round 13, edges 2): a process holding two recorded identities
 * for one path — the binary replaced between two launches — must not let
 * either launch exec the bytes only the other checked. Paths without a
 * check fall back to the recorded list, the shape a spawn site whose
 * resolution lives in another module keeps.
 */
export function assertExecutablesUnchanged(
  paths: readonly string[],
  label: string,
  /** Paths the caller knows were trust-checked (trustCheckedCommandPaths
   * computes them for a resolveTrustedCommand result). A required path
   * with no recorded identity is REFUSED, not skipped: an argument that
   * was never trust-checked is ignored, but a path the caller marks as
   * trust-checked must never silently drop its re-check because the
   * recording missed its spelling (review round 2, edges 2). */
  requiredPaths?: readonly string[],
  /** This launch's own resolutions (the checks above): when a path has
   * one, only that identity passes its re-stat. */
  checks?: readonly ExecutableCheck[]
): void {
  const own = new Map((checks ?? []).map((check) => [check.path, check.identity]));
  for (const path of new Set([...paths, ...own.keys()])) {
    const thisLaunch = own.get(path);
    const expected = thisLaunch === undefined ? trustedIdentities.get(path) : [thisLaunch];
    if (expected === undefined) continue;
    let stat;
    try {
      stat = statSync(path, { bigint: true });
    } catch {
      throw new Error(`${label} executable disappeared after its trust check: ${path}`);
    }
    if (!expected.some((recorded) => !identityChanged(recorded, stat))) {
      throw new Error(`${label} executable changed after its trust check: ${path}`);
    }
  }
  for (const path of new Set(requiredPaths ?? [])) {
    if (!trustedIdentities.has(path)) {
      throw new Error(
        `${label} executable was trust-checked but has no recorded identity to re-check: ${path}`
      );
    }
  }
}

/** The positions of a resolveTrustedCommand result that were resolved
 * and trust-checked: the leading executable, plus the program an `env`
 * prefix launches. Exported so a spawn site can re-check exactly those
 * (assertExecutablesUnchanged's requiredPaths) and refuse a recording
 * gap instead of skipping it. Resolution parses each resolved executable
 * too, so an alias of env has the same wrapper semantics here. */
export function trustCheckedCommandPaths(
  resolved: readonly string[]
): readonly string[] {
  if (resolved.length === 0) return [];
  const checked: string[] = [];
  let offset = 0;
  while (offset < resolved.length) {
    checked.push(resolved[offset]!);
    const program = envProgramIndex(resolved.slice(offset));
    if (program === null) break;
    offset += program;
  }
  return checked;
}

/** One launch's own resolution of one path, as an opaque handle for
 * assertExecutablesUnchanged (review round 13, edges 2): a process that
 * trust-checked two versions of one path holds two identities for it,
 * and a re-stat that accepts EITHER would let a launch execute bytes
 * only another launch checked. A check pins the re-stat to this
 * resolution's identity alone. */
export interface ExecutableCheck {
  readonly path: string;
  readonly identity: ExecutableIdentity;
}

/** The identity the most recent trust check of `path` recorded, as this
 * launch's check. The capture must run in the same synchronous block as
 * the caller's own resolveTrustedExecutable / resolveTrustedCommand —
 * before the first await between them: a capture after an await reads
 * whatever launch probed the path last, which need not be this one
 * (round 20, minor 7), so spawn sites carry the captured check across
 * their awaits instead of re-deriving it at the spawn. A path never
 * trust-checked returns null and the caller falls back to the recorded
 * list. */
export function executableCheck(path: string): ExecutableCheck | null {
  const recorded = trustedIdentities.get(path);
  if (recorded === undefined || recorded.length === 0) return null;
  return { path, identity: recorded[recorded.length - 1]! };
}

/** The same positions trustCheckedCommandPaths names, as this launch's
 * checks (executableCheck of each): handed to
 * assertExecutablesUnchanged so each re-stat compares the identity this
 * launch's own resolution recorded, never another launch's. A position
 * with no recorded identity is dropped here and caught by the
 * requiredPaths belt the caller passes beside these. */
export function trustCheckedCommandChecks(
  resolved: readonly string[]
): readonly ExecutableCheck[] {
  return trustCheckedCommandPaths(resolved)
    .map(executableCheck)
    .filter((check): check is ExecutableCheck => check !== null);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The index of the program an `env` prefix launches, or null when the
 * command does not start with one. The single parse both
 * resolveTrustedCommand and trustCheckedCommandPaths walk, so the
 * resolved positions and the re-checked positions cannot disagree.
 * Throws the caller's label-prefixed refusals for a malformed prefix.
 * Exported for the live gate's print probe, which must find the program a
 * printed argv starts by this same parse. */
export function envProgramIndex(command: readonly string[], label = "sandbox command"): number | null {
  if (command.length === 0 || typeof command[0] !== "string") return null;
  const isEnv = command[0] === "env" || command[0].endsWith("/env");
  if (!isEnv) return null;
  let index = 1;
  let sawAssignment = false;
  while (index < command.length) {
    const part = command[index]!;
    // Unsetting needs no assignment value, but only these two spellings
    // are honored, and only before the first assignment: past one, BSD
    // env (and POSIX env generally) treats every later option as the
    // program to run, so honoring it here would validate the wrong
    // binary. Every other option (notably -i and -S) can reinterpret
    // the rest of the prefix and is refused outright below.
    if ((part === "-u" || part === "--unset") && !sawAssignment) {
      const name = command[index + 1];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`${label} env prefix unsets an invalid variable name`);
      }
      index += 2;
      continue;
    }
    if (ENV_ASSIGNMENT.test(part)) {
      sawAssignment = true;
      index++;
      continue;
    }
    break;
  }
  if (index >= command.length || command[index]!.startsWith("-")) {
    throw new Error(`${label} env prefix names no program to run`);
  }
  return index;
}

/**
 * Resolves every executable a command names to a trusted absolute path.
 *
 * A command may start with `env NAME=value ... program`, the only way to
 * hand a child a different HOME than the sandbox wrapper itself runs with
 * (Codex's hermetic home). Validating `env` alone would let the program it
 * launches come from PATH unchecked, so both are resolved and validated.
 */
export function resolveTrustedCommand(
  command: readonly string[],
  label: string,
  forbiddenRoot?: string,
  pathEnv: string | undefined = process.env.PATH
): string[] {
  if (command.length === 0 || typeof command[0] !== "string" || command[0].length === 0) {
    throw new Error(`${label} produced an invalid command`);
  }
  const resolved = [...command];
  const resolveAt = (index: number, keepName = false): void => {
    const name = command[index]!;
    const binaryPath = Bun.which(name, { PATH: pathEnv });
    if (!binaryPath) {
      throw new Error(`${label} executable '${name}' was not found`);
    }
    const trusted = resolveTrustedExecutable(binaryPath, name, forbiddenRoot);
    // A multi-call binary (busybox, single-binary coreutils) picks its
    // applet from argv[0], so `env` must run under its own name; the
    // realpath is only validated. The spelling the child gets is absolute:
    // a relative PATH entry was validated against this process's directory
    // and would resolve under the child's --cwd to another file (round 48).
    resolved[index] = keepName ? (isAbsolute(binaryPath) ? binaryPath : resolve(binaryPath)) : trusted;
  };
  let offset = 0;
  while (offset < command.length) {
    const rawProgram = envProgramIndex(command.slice(offset), label);
    resolveAt(offset, rawProgram !== null);
    const program = envProgramIndex(resolved.slice(offset), label);
    if (program === null) break;
    offset += program;
  }
  return resolved;
}
