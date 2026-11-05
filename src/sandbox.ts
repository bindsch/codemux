import type { AutonomyLevel } from "./types.js";
import { UsageRefusalError } from "./validation.js";
// From the format module, which owns the rule, rather than the registry
// barrel: sandbox.ts sits below the session layer and imports only this
// one helper from it.
import { canonicalSandboxBlockPath } from "./session/registry/format.js";

export type ScodeFsMode = "ro" | "rw";
export const SCODE_TRUST_LEVELS = ["trusted", "standard", "untrusted"] as const;
export type ScodeTrustLevel = (typeof SCODE_TRUST_LEVELS)[number];

export interface SandboxOptions {
  trust?: ScodeTrustLevel;
  fsMode?: ScodeFsMode;
  noNet?: boolean;
  scrubEnv?: boolean;
  /**
   * Environment names codemux itself injected into the child (the
   * adapter's standing and per-run variables). When scrubbing is on
   * (--sandbox-scrub-env, or scode's untrusted trust preset, which
   * implies --scrub-env) they ride scode's --keep-env exemption, so
   * the scrub strips the ambient environment without stripping the
   * configuration codemux chose -- a credential above all (a provider
   * override's key, or zai's gateway token).
   */
  keepEnv?: readonly string[];
  /**
   * True when the run cannot proceed without that exemption (a
   * credential codemux injected is the run's only one — a provider
   * override's key with the operator's own omitted on purpose, or zai's
   * gateway token): a scode without --keep-env then refuses the launch
   * instead of running it stripped.
   */
  keepEnvRequired?: boolean;
  /** Request scode's per-run scratch accounting (SCODE_ACCOUNT_FILE). */
  accountFile?: string;
  /** Opaque correlation token recorded in the accounting line (SCODE_ACCOUNT_ID). */
  accountId?: string;
  /** Launcher-owned temporary harness state, outside the read-only project. */
  harnessStateDirs?: readonly string[];
  /**
   * Paths scode must make unreachable, read and write, even though the
   * default profile allows them (an operator's harness config directory).
   * Absolute non-NUL paths, emitted as repeated `--block`. A later
   * harnessStateDirs allow can reopen a child of a blocked path — scode
   * emits the block first and the child allow after it, and its final
   * guards re-assert both, so exactly the allowed child stays reachable.
   * A caller-supplied block that overlaps one of the launcher's
   * harnessStateDirs — equal to it, an ancestor of it, or a path inside
   * it, which scode's recursive allow would drop — is refused before
   * that: see assertNoCallerBlockOverStateDirs.
   */
  blockPaths?: readonly string[];
}

export function mapAutonomyToScodeFsMode(autonomy?: AutonomyLevel): ScodeFsMode {
  return autonomy === undefined || autonomy === "read-only" ? "ro" : "rw";
}

export function mapAutonomyToScodeTrust(_autonomy?: AutonomyLevel): ScodeTrustLevel {
  return "standard";
}

/** Whether a sandbox with these options runs without network: the
 * explicit flag, or scode's untrusted preset, which implies --no-net
 * (withKeepEnvExemption's note below; review round 102). */
export function sandboxRestrictsNetwork(
  options?: { trust?: ScodeTrustLevel; noNet?: boolean }
): boolean {
  return options?.noNet === true || options?.trust === "untrusted";
}

export function buildScodeCommand(
  command: string[],
  cwd?: string,
  autonomy?: AutonomyLevel,
  options?: SandboxOptions,
  executable = "scode"
): string[] {
  if (
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("sandbox command must contain non-NUL string arguments");
  }
  const scodeCmd = [executable];

  if (cwd) {
    scodeCmd.push("-C", cwd);
  }

  const trust = options?.trust ?? mapAutonomyToScodeTrust(autonomy);
  scodeCmd.push("--trust", trust);
  const fsMode = trust === "untrusted"
    ? "ro"
    : options?.fsMode ?? mapAutonomyToScodeFsMode(autonomy);
  scodeCmd.push(fsMode === "ro" ? "--ro" : "--rw");
  if (options?.noNet) {
    scodeCmd.push("--no-net");
  }
  if (options?.scrubEnv) {
    scodeCmd.push("--scrub-env");
  }
  if (options?.keepEnv && options.keepEnv.length > 0) {
    scodeCmd.push("--keep-env", options.keepEnv.join(","));
  }
  const blockedPaths = options?.blockPaths ?? [];
  for (const blocked of blockedPaths) {
    if (!blocked.startsWith("/") || blocked.includes("\0")) {
      throw new Error("sandbox block path must be an absolute non-NUL path");
    }
    scodeCmd.push("--block", blocked);
  }
  for (const directory of options?.harnessStateDirs ?? []) {
    if (!directory.startsWith("/") || directory.includes("\0")) {
      throw new Error("sandbox harness state directory must be an absolute non-NUL path");
    }
    scodeCmd.push("--allow", directory);
  }

  scodeCmd.push("--", ...command);

  return scodeCmd;
}

/** Whether an environment name is a credential codemux itself injected:
 * the claude family's gateway token (`ANTHROPIC_AUTH_TOKEN`, zai's fixed
 * gateway above all — injected with no provider override to name it — and
 * claude's override) or any provider key (`*_API_KEY`, the codex, kimi,
 * and other override spellings). Under a scrub (--sandbox-scrub-env, or
 * scode's untrusted trust preset implying it) such a name cannot ride
 * the ambient environment (the scrub strips that too), so the
 * exemption is the only way the child keeps its credential — the
 * run cannot proceed without it (round al11's re-review, edges 1). */
export function isCredentialEnvName(name: string): boolean {
  return name === "ANTHROPIC_AUTH_TOKEN" || name.endsWith("_API_KEY");
}

/** The sandbox options with scode's --keep-env exemption attached for the
 * environment codemux itself injected (the adapter's standing and
 * per-run variables): when scrubbing is on those names ride the
 * exemption, so the scrub strips the ambient environment without
 * stripping the configuration codemux deliberately injected. Scrubbing
 * is on when codemux itself asked for it (`scrubEnv`) OR the trust
 * preset implies it (`trust === "untrusted"` — scode 0.6.0's untrusted
 * preset is --strict + --no-net + --scrub-env + --ro, per its --help),
 * so the exemption rides both spellings. Not on any other launch: scode
 * prints "--keep-env has no effect without --scrub-env" on stderr for
 * every run that carries the flag without a scrub (verified on the
 * installed 0.6.0), so the flag rides only where it can act. A scode
 * config file's `scrub_env: true` is invisible to codemux and stays the
 * operator's responsibility (README "Sandbox Integration"). The
 * exemption is REQUIRED — a scode without --keep-env refuses rather
 * than run it stripped — when the caller passed `keepEnvRequired` (a
 * provider override: its key is the run's only credential, the
 * operator's own having been omitted on purpose) OR the injected
 * environment itself carries a credential-shaped name
 * (isCredentialEnvName — zai's gateway token, injected with no override
 * mechanism to mark it). Options with no scrub possible or no injected
 * environment come back unchanged. One rule serves run (launch.ts),
 * tui (index.ts), and session spawns (session/cli.ts). */
export function withKeepEnvExemption(
  sandboxOptions: SandboxOptions,
  injectedEnv: Record<string, string>,
  keepEnvRequired: boolean
): SandboxOptions {
  const scrubbing =
    sandboxOptions.scrubEnv === true || sandboxOptions.trust === "untrusted";
  if (!scrubbing || Object.keys(injectedEnv).length === 0) {
    return sandboxOptions;
  }
  return {
    ...sandboxOptions,
    keepEnv: Object.keys(injectedEnv),
    keepEnvRequired:
      keepEnvRequired ||
      Object.keys(injectedEnv).some((name) => isCredentialEnvName(name)),
  };
}

/** Refuses a caller-supplied `--sandbox-block` path that overlaps — in
 * EITHER direction — a directory the launcher itself must allow as
 * harness state. A block that equals or contains the state directory
 * loses to scode's ordering: scode emits the block first and the child
 * allow after it, so the pair silently re-opens exactly the blocked tree
 * (review round 9, edges finding 1). A block INSIDE the state directory
 * loses to scode's resolution: the launcher's recursive `--allow` of the
 * state directory covers its descendants, and scode drops a descendant
 * block from its blocked set, so the block never reaches the child at all
 * (review round 20, contracts-2 finding 1 — a block of the session's own
 * `.credentials.json` was emitted and then silently discarded). The
 * launcher's own project-settings blocks are the deliberate exception —
 * the allow child of a block is that design — so the check runs where the
 * caller's blocks are still alone, before the launcher appends its own
 * (launch.ts, session/cli-launch.ts).
 * Both sides are canonicalized with the registry's own rule
 * (canonicalSandboxBlockPath) before the prefix tests: scode collapses
 * `..` and trailing slashes and dereferences symlinks, so a raw-spelling
 * comparison let `/tmp/state/`, `/tmp/state/../state`, and a symlink
 * alias of a state directory through (review round 10, contracts 4,
 * edges 2, contracts-2 1). The refusal names the caller's raw spelling
 * and the state directory as given. */
export function assertNoCallerBlockOverStateDirs(
  callerBlockPaths: readonly string[],
  harnessStateDirs: readonly string[]
): void {
  const stateDirs = harnessStateDirs.map(canonicalSandboxBlockPath);
  for (const blocked of callerBlockPaths) {
    const canonicalBlocked = canonicalSandboxBlockPath(blocked);
    // The canonical form never ends in a slash except for the root, whose
    // descendant prefix stays "/" — every absolute state directory starts
    // with it — instead of "//", which matched nothing and let a caller
    // block of "/" re-open every state tree (review round 11, edges 1).
    const descendantPrefix = canonicalBlocked === "/" ? "/" : `${canonicalBlocked}/`;
    for (let index = 0; index < stateDirs.length; index += 1) {
      const directory = harnessStateDirs[index] as string;
      const canonicalDirectory = stateDirs[index] as string;
      if (
        canonicalDirectory === canonicalBlocked ||
        canonicalDirectory.startsWith(descendantPrefix)
      ) {
        throw new UsageRefusalError(
          `--sandbox-block ${blocked} covers the launch's own harness state directory ${directory}, ` +
            "which the launch must allow; scode would re-allow it after the block. Remove the block or narrow it."
        );
      }
      // The reverse overlap, with the root's prefix spelled the same way:
      // a state directory of "/" would recursively allow everything and
      // drop every caller block beneath it.
      const statePrefix = canonicalDirectory === "/" ? "/" : `${canonicalDirectory}/`;
      if (canonicalBlocked.startsWith(statePrefix)) {
        throw new UsageRefusalError(
          `--sandbox-block ${blocked} sits inside the launch's own harness state directory ${directory}, ` +
            "which the launch must allow recursively; scode drops a block beneath its own allow, so the block cannot be honored. " +
            "Remove the block or move it outside the state directory."
        );
      }
    }
  }
}

export function buildSandboxEnv(
  extraEnv: Record<string, string> = {},
  sandboxOptions?: SandboxOptions
): Record<string, string> {
  const sanitized = { ...extraEnv };
  for (const name of Object.keys(sanitized)) {
    if (name.toUpperCase().startsWith("SCODE_")) {
      delete sanitized[name];
    }
  }
  // The only SCODE_* names codemux sets itself: scratch-accounting opt-ins
  // requested through --sandbox-account / --sandbox-account-id. scode
  // consumes both into private state and never passes them to the sandboxed
  // child, so setting them here does not leak into the harness environment.
  // That is confidentiality, not integrity (see scode): keep the sink
  // outside the sandbox's writable area.
  if (sandboxOptions?.accountFile) {
    sanitized.SCODE_ACCOUNT_FILE = sandboxOptions.accountFile;
  }
  if (sandboxOptions?.accountId) {
    sanitized.SCODE_ACCOUNT_ID = sandboxOptions.accountId;
  }
  return sanitized;
}
