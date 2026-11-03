// Registry record format: the session record and file shapes, the
// autonomy/trust ranking tables, strict shape validation, and the
// classifying read. src/session/registry.ts owns the module surface.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { FileContentError, readUtf8FileBounded } from "../../file-io.js";
import type { AutonomyLevel } from "../../types.js";
import { MAX_PASSTHROUGH_ENV_NAMES, UsageRefusalError } from "../../validation.js";
import { MAX_ID_CHARS } from "../protocol.js";
import { registryPlacementProblem, resolveRegistryPath } from "../registry-io.js";

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
  /** The `--sandbox-block` paths, canonical, sorted, deduplicated
   * (canonicalSandboxBlockPaths): the same one-directional rule the
   * two flags above use — every recorded path must be present in the
   * resume's set (dropping a block grants reach creation denied the
   * resumed transcript), and a resume may add more. Absent on records
   * codemux before 2.0.0 wrote: sessions accepted no `--sandbox-block`
   * then, so an absent field reads as an empty block list exactly. */
  sandbox_block: string[];
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
  /** Containment provenance, not a preference: whether the session ran
   * under `--hermetic --experiment-project-settings` (a private Claude
   * config directory per session, `harness_home` naming it). The resume
   * guard refuses a mismatch in both directions — the mode decides where
   * the transcript lives and what the harness loads, so it cannot be
   * added to or removed from a session on resume. Absent on records
   * codemux 0.15.1 and earlier wrote: sessions refused the mode entirely
   * there, so an absent field is a plain session exactly. */
  project_settings: boolean;
  /** Whether the session ran with `--final` (project-settings only): the
   * private config directory is removed at end, so the record is stamped
   * non-resumable atomically with its end — a resume that claimed an
   * ended record in the window before the directory removal would have
   * its transcript and credentials deleted under it (review round 10,
   * edges 4). The resume guard refuses a final record outright. Absent on
   * records codemux before 2.0.0 wrote: `--final` did not exist there,
   * so an absent field reads as an ordinary resumable session. */
  final: boolean;
  owner_pid: number;
  /** Opaque process-start token (`ProcessEntry.start`), or null where
   * the process table was unreadable at record time. A null token makes
   * every later liveness check pid-only wherever it runs — with or
   * without a readable table — so the pid-reuse window is the residual
   * both for null tokens and for unreadable tables at check time. */
  owner_start: string | null;
  ended: string | null;
}

export interface RegistryFile {
  version: 1;
  sessions: SessionRecord[];
}

export const REGISTRY_MAX_ENTRIES = 1000;
export const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
/** validation.ts's `--pass-env` name rule, restated for the reader. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const AUTONOMY_REACH: Record<AutonomyLevel, number> = {
  "read-only": 0,
  medium: 1,
  high: 2,
  low: 3,
};

/** The strict (low < medium < high) ranking agy's flags exactly form;
 * opencode and aider borrow it as their conservative approximation (see
 * AUTONOMY_REACH_BY_AGENT). */
export const STRICT_AUTONOMY_REACH: Record<AutonomyLevel, number> = {
  "read-only": 0,
  low: 1,
  medium: 2,
  high: 3,
};

export const AUTONOMY_REACH_BY_AGENT: Record<string, Record<AutonomyLevel, number>> = {
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

export const TRUST_RANK: Record<SandboxTrust, number> = {
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
    "sandbox_no_net", "sandbox_scrub_env", "sandbox_block", "pass_env",
    "playwright_mcp", "provider_base_url", "project_settings", "final",
    "owner_pid", "owner_start", "ended",
  ];
  if (keys.some((key) => !expected.includes(key))) return false;
  // `provider_base_url`, `project_settings`, `sandbox_block`, and `final`
  // may be the missing keys: records an older codemux wrote before the
  // field existed. Sessions refused every provider override before 0.10.0
  // and the project-settings mode before 2.0.0, accepted no
  // `--sandbox-block` before 2.0.0, and had no `--final` before 2.0.0, so
  // an absent field reads as exactly what those releases could have
  // written — an operator-login session, a plain session, an empty block
  // list, an ordinary resumable session — and refusing it would poison
  // every existing registry as corrupt (review D3). Any other missing
  // key is still corrupt.
  // The tolerance is one-directional by design (review D7, correctness-2
  // 3): newer records read fine here, but a co-installed older binary's
  // stricter exact-key validator reads a whole newer-written registry as
  // corrupt — it refuses every resume and stops recording. That breakage
  // is documented in the release notes (CHANGELOG) as the
  // downgrade/co-install cost; widening this validator cannot fix
  // the old binary.
  const LEGACY_OPTIONAL_KEYS = new Set(["provider_base_url", "project_settings", "sandbox_block", "final"]);
  const missing = expected.filter((key) => !keys.includes(key) && !LEGACY_OPTIONAL_KEYS.has(key));
  if (missing.length > 0) {
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
  // The record's block spelling is canonical (absolute, no NUL); a
  // relative or padded entry is a record no writer of this shape makes.
  const block = record["sandbox_block"];
  if (
    block !== undefined &&
    (!Array.isArray(block) ||
      !block.every(
        (path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0")
      ))
  ) {
    return false;
  }
  const passEnv = record["pass_env"];
  if (
    !Array.isArray(passEnv) ||
    passEnv.length > MAX_PASSTHROUGH_ENV_NAMES ||
    !passEnv.every((name) => typeof name === "string" && ENV_NAME_PATTERN.test(name))
  ) {
    return false;
  }
  if (typeof record["playwright_mcp"] !== "boolean") return false;
  if (record["project_settings"] !== undefined && typeof record["project_settings"] !== "boolean") {
    return false;
  }
  if (record["final"] !== undefined && typeof record["final"] !== "boolean") {
    return false;
  }
  const provider = record["provider_base_url"];
  if (provider !== undefined && provider !== null && typeof provider !== "string") return false;
  if (typeof provider === "string" && provider.length === 0) return false;
  if (!Number.isInteger(record["owner_pid"]) || (record["owner_pid"] as number) <= 0) return false;
  if (record["owner_start"] !== null && typeof record["owner_start"] !== "string") return false;
  if (record["ended"] !== null && typeof record["ended"] !== "string") return false;
  return true;
}

export function validRegistryFile(value: unknown): RegistryFile | null {
  if (typeof value !== "object" || value === null) return null;
  const file = value as Record<string, unknown>;
  if (file["version"] !== 1) return null;
  if (!Array.isArray(file["sessions"])) return null;
  if (file["sessions"].length > REGISTRY_MAX_ENTRIES) return null;
  if (!file["sessions"].every(validRecord)) return null;
  // Normalize the legacy shape: a 0.9.0 record that predates
  // `provider_base_url` (valid above) reads as operator login, a
  // pre-2.0.0 record that predates `project_settings` reads as a plain
  // session, a pre-2.0.0 record that predates `sandbox_block` reads
  // as an empty block list, and a pre-2.0.0 record that predates `final`
  // reads as an ordinary resumable session, so no use site can ever see
  // an `undefined` the type does not promise. The next write persists
  // the explicit values.
  return {
    version: 1,
    sessions: file["sessions"].map((entry) => ({
      ...entry,
      provider_base_url: entry["provider_base_url"] ?? null,
      project_settings: entry["project_settings"] ?? false,
      sandbox_block: entry["sandbox_block"] ?? [],
      final: entry["final"] ?? false,
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

/** Canonicalize `--sandbox-block` paths for the record and the resume
 * probe: realpath where the path resolves (a symlinked ancestor must not
 * make one tree count as two blocks, or as none); where it does not, the
 * longest existing ancestor is resolved and the missing tail kept
 * literal (scode blocks a path that does not exist yet, but blocks it
 * wherever its symlinked ancestor points, so a literal spelling could be
 * retargeted between the record and the resume — review round 8, edges).
 * Then deduplicated and sorted. Both sides of the resume comparison run
 * this, so the spawn's raw spelling never has to match the record's. An
 * ancestor that exists but cannot be resolved (permissions, a symlink
 * loop) refuses the request: 64, naming the path. */
export function canonicalSandboxBlockPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(canonicalSandboxBlockPath))].sort();
}

/** The one-path rule both the record and the launch-time conflict check
 * run (src/sandbox.ts's assertNoCallerBlockOverStateDirs): scode
 * dereferences symlinks and collapses `..` and trailing slashes, so a
 * spelling that differs from the canonical form still names the same
 * tree to scode and must compare as it. */
const MAX_BLOCK_PATH_LINK_HOPS = 40;

export function canonicalSandboxBlockPath(path: string, hops = 0): string {
  // A dangling-link chain is followed at most MAX_BLOCK_PATH_LINK_HOPS
  // times: a self-referential or cyclic chain refuses instead of recursing
  // to stack exhaustion (round 34, edges 8).
  if (hops > MAX_BLOCK_PATH_LINK_HOPS) {
    throw new UsageRefusalError(`--sandbox-block cannot resolve ${path}: more than ${MAX_BLOCK_PATH_LINK_HOPS} symlink hops`);
  }
  try {
    return realpathSync(path);
  } catch {
    return canonicalMissingSandboxBlockPath(path, hops);
  }
}

function canonicalMissingSandboxBlockPath(path: string, hops: number): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new UsageRefusalError(
          `--sandbox-block cannot resolve ${path}: ${(error as NodeJS.ErrnoException).code ?? "realpath failed"}`
        );
      }
    }
    // A component that exists but does not resolve is a dangling symlink
    // (realpath fails ENOENT while lstat succeeds): scode dereferences
    // the link once its target exists, so the canonical form follows the
    // target — resolved against the link's directory, then the same
    // longest-existing-ancestor rule — instead of keeping the link's own
    // name literal, which a retarget would leave unchanged in the record
    // (review round 10, contracts-2 2).
    let linkTarget: string | null = null;
    try {
      if (lstatSync(current).isSymbolicLink()) linkTarget = readlinkSync(current);
    } catch {
      // Not a symlink, or it vanished between the calls: the walk above
      // keeps treating the component as missing.
    }
    if (linkTarget !== null) {
      const resolved = isAbsolute(linkTarget)
        ? linkTarget
        : join(dirname(current), linkTarget);
      return join(canonicalSandboxBlockPath(resolved, hops + 1), ...tail);
    }
    const parent = dirname(current);
    if (parent === current) {
      // The root itself did not resolve: nothing exists above it.
      throw new UsageRefusalError(`--sandbox-block cannot resolve ${path}`);
    }
    tail.unshift(basename(current));
    current = parent;
  }
}

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

