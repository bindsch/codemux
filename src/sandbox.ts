import { realpathSync } from "node:fs";
import { accountHome } from "./account-home.js";
import { agyLoginPaths, AGY_FILE_TOKEN } from "./agy-auth.js";
import { nativeLoginPaths } from "./native-login-paths.js";
import { grantsAgyFileToken, grantsLoginStore } from "./sandbox-login-policy.js";
import { claudeLoginPaths } from "./claude-login.js";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AgentId, AutonomyLevel } from "./types.js";
import { UsageRefusalError } from "./validation.js";
import { assertStrictExecutables, containsPath, needsWrappedExecutableGrant, strictCommandPaths, StrictSandboxRefusalError } from "./sandbox-command.js";
import { strictRuntimeGrants } from "./sandbox-runtime-grants.js";
// From the format module, which owns the rule, rather than the registry
// barrel: sandbox.ts sits below the session layer and imports only this
// one helper from it.
import { canonicalSandboxBlockPath } from "./session/registry/format.js";

export type ScodeFsMode = "ro" | "rw";
export const SCODE_TRUST_LEVELS = ["trusted", "standard", "untrusted"] as const;
export type ScodeTrustLevel = (typeof SCODE_TRUST_LEVELS)[number];

export interface SandboxOptions {
  /** Adapter identity, preserved independently of resolved executable paths. */
  agentId?: AgentId;
  /** Deny-default filesystem access while retaining detected and explicit grants. */
  strict?: boolean;
  trust?: ScodeTrustLevel;
  fsMode?: ScodeFsMode;
  noNet?: boolean;
  loginStore?: boolean;
  noLoginStore?: boolean;
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
  /** Caller blocks captured before appending launcher isolation blocks. */
  callerBlockPaths?: readonly string[];
  /** Operator stores blocked by --harness-home, distinct from caller policy. */
  harnessHomeBlockedPaths?: readonly string[];
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

/** scode blocks the account home wholesale when HOME names a different
 * directory (scode 0.6.6, "A caller may intentionally use a synthetic HOME").
 * A harness installed in the real home then needs the same exact-file grant
 * as one installed in a blocked operator store. */
export function scodeAccountHomeBlock(environment: NodeJS.ProcessEnv, account = accountHome()): string[] {
  if (account === null) return [];
  let home: string;
  try {
    home = realpathSync(environment.HOME ?? "");
  } catch {
    return [];
  }
  return account !== home ? [account] : [];
}

export function buildScodeCommand(
  command: string[],
  cwd?: string,
  autonomy?: AutonomyLevel,
  options?: SandboxOptions,
  executable = "scode",
  environment: NodeJS.ProcessEnv = process.env,
  allowReadOnlyExecutables = false,
  allowStagedLogin = false,
  supportsNoLoginStore = false,
  platform: NodeJS.Platform = process.platform,
  supportsNoCredentialSync = true
): string[] {
  if (
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("sandbox command must contain non-NUL string arguments");
  }
  // scode added credential synchronization, and this switch, in 0.4.0.
  // An older scode has neither and refuses the unknown option, so the
  // callers that know the version leave it out there (review round 4).
  const scodeCmd = supportsNoCredentialSync ? [executable, "--no-credential-sync"] : [executable];

  if (cwd) {
    scodeCmd.push("-C", cwd);
  }

  const trust = options?.trust ?? mapAutonomyToScodeTrust(autonomy);
  scodeCmd.push("--trust", trust);
  if (options?.strict) scodeCmd.push("--strict");
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
  const loginStore = grantsLoginStore({ ...options, trust }, environment);
  if (supportsNoLoginStore) scodeCmd.push(loginStore ? "--login-store" : "--no-login-store");
  const home = environment.HOME || homedir();
  const nativePaths = !loginStore ? []
    : options?.agentId === "agy" ? agyLoginPaths(home, platform)
      : options?.agentId === "claude" ? nativeLoginPaths(home, platform) : [];
  const stagedPaths: string[] = [];
  // agy's file token is agy's own state file, not the Keychain login store:
  // every agy sandbox on the operator login gets that one existing file,
  // read-write, by exact path. A caller's own block over it wins unless
  // the login store was requested, where the conflict is refused below.
  const token = join(home, AGY_FILE_TOKEN);
  const tokenGranted = grantsAgyFileToken({ ...options, trust }, environment);
  if (tokenGranted && existsSync(token) &&
      (loginStore || !callerBlockCovers(options?.callerBlockPaths ?? blockedPaths, token))) nativePaths.push(token);
  // A withheld token is blocked by exact path: a plain run leaves the real
  // ~/.gemini reachable as harness state, so omitting the grant alone would
  // not withhold it (review round 12).
  const withheldToken = options?.agentId === "agy" && !tokenGranted && existsSync(token) &&
    !callerBlockCovers(blockedPaths, token) ? [token] : [];
  if (platform === "darwin" && loginStore && options?.agentId === "claude") {
    const loginPaths = claudeLoginPaths(environment, cwd);
    nativePaths.push(...loginPaths);
    if (allowStagedLogin) stagedPaths.push(...loginPaths.filter((path) =>
      [".credentials.json", ".oauth_refresh.lock.owner"].includes(basename(path))));
  }
  if (nativePaths.length) assertNoCallerBlockOverStateDirs(options?.callerBlockPaths ?? blockedPaths, nativePaths);
  const readOnlyLoginPaths = nativePaths.filter((path) => path.endsWith("/Library/Preferences/com.apple.security.plist"));
  if (readOnlyLoginPaths.length && !allowReadOnlyExecutables) {
    throw new UsageRefusalError("--sandbox-login-store requires scode 0.6.7 or newer for read-only security preferences");
  }
  // A caller may block one bounded staging name without blocking its base.
  for (const path of stagedPaths) {
    const prefix = `${canonicalSandboxBlockPath(path)}.tmp.`;
    for (const blocked of options?.callerBlockPaths ?? blockedPaths) {
      const canonical = canonicalSandboxBlockPath(blocked);
      if (canonical.toLowerCase().startsWith(prefix.toLowerCase()) && /^[0-9a-fA-F]{8}(?:\/|$)/.test(canonical.slice(prefix.length))) {
        throw new UsageRefusalError(`--sandbox-block ${blocked} conflicts with the staged login grant for ${path}`);
      }
    }
  }
  for (const blocked of [...blockedPaths, ...withheldToken]) {
    if (!blocked.startsWith("/") || blocked.includes("\0")) {
      throw new Error("sandbox block path must be an absolute non-NUL path");
    }
    scodeCmd.push("--block", blocked);
  }
  for (const directory of [...(options?.harnessStateDirs ?? []), ...nativePaths]) {
    if (!directory.startsWith("/") || directory.includes("\0")) {
      throw new Error("sandbox harness state directory must be an absolute non-NUL path");
    }
    scodeCmd.push(readOnlyLoginPaths.includes(directory) ? "--allow-ro" : stagedPaths.includes(directory) ? "--allow-staged" : "--allow", directory);
  }

  const grants = [...(options?.harnessStateDirs ?? []), ...nativePaths.filter((path) => !readOnlyLoginPaths.includes(path))];
  const readOnlyGrants: string[] = [...readOnlyLoginPaths];
  // A harness can be installed inside its own operator store. Reopen only
  // the resolved executable files, never their containing config directory.
  // Older scode needs a writable exception, which strict mode refuses.
  const strict = options?.strict || trust === "untrusted";
  if (options?.harnessHomeBlockedPaths?.length || allowReadOnlyExecutables) {
    const stores = [...(options?.harnessHomeBlockedPaths ?? []), ...scodeAccountHomeBlock(environment)].map(canonicalSandboxBlockPath);
    const blocks = blockedPaths.map(canonicalSandboxBlockPath);
    for (const [index, executable] of strictCommandPaths(command).entries()) {
      if (!executable.startsWith("/")) continue;
      const path = canonicalSandboxBlockPath(executable);
      const blockedStore = stores.some((store) => containsPath(store, path));
      const wrapped = allowReadOnlyExecutables && strict && index > 0 && needsWrappedExecutableGrant(path, blocks);
      if (!blockedStore && !wrapped) continue;
      // Session turns map only StrictSandboxRefusalError to exit 64.
      try {
        assertNoCallerBlockOverStateDirs(options?.callerBlockPaths ?? blockedPaths, [path]);
      } catch (error) {
        if (error instanceof UsageRefusalError) throw new StrictSandboxRefusalError(error.message);
        throw error;
      }
      const target = allowReadOnlyExecutables ? readOnlyGrants : grants;
      if (target.includes(path)) continue;
      target.push(path);
      scodeCmd.push(allowReadOnlyExecutables ? "--allow-ro" : "--allow", path);
    }
  }
  if (options?.strict && trust !== "untrusted") {
    const runtimePaths = strictRuntimeGrants(options.agentId, command, environment);
    try {
      assertNoCallerBlockOverStateDirs(options?.callerBlockPaths ?? blockedPaths, runtimePaths);
    } catch (error) {
      if (error instanceof UsageRefusalError) throw new StrictSandboxRefusalError(error.message);
      throw error;
    }
    // Runtime detection must not reopen launcher isolation blocks. Private
    // state beneath an intentional parent block already has its own allow.
    const blocks = blockedPaths.map(canonicalSandboxBlockPath);
    for (const path of runtimePaths) {
      if (blocks.some((block) => containsPath(block, path) || containsPath(path, block))) continue;
      grants.push(path);
      scodeCmd.push("--allow", path);
    }
  }
  if (strict) assertStrictExecutables(command, blockedPaths, grants, readOnlyGrants);

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
 * run cannot proceed without it (round al11's re-review, edges 1).
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` is not one: it selects which Keychain
 * item Claude reads and carries no secret, so it never makes the
 * exemption required (review round 5). */
export function isCredentialEnvName(name: string): boolean {
  return name === "ANTHROPIC_AUTH_TOKEN" || name.endsWith("_API_KEY");
}

/** Claude's login selector on macOS. Under untrusted trust the login store
 * is never granted, so the selector has nothing to select: it is neither
 * exempted from the scrub nor left in the child's environment. */
export const CLAUDE_LOGIN_SELECTOR_ENV = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

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
 * operator's responsibility (docs/autonomy-and-sandboxing.md). The
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
  const names = Object.keys(injectedEnv).filter((name) =>
    sandboxOptions.trust !== "untrusted" || name !== CLAUDE_LOGIN_SELECTOR_ENV);
  if (!scrubbing || names.length === 0) {
    return sandboxOptions;
  }
  return {
    ...sandboxOptions,
    keepEnv: names,
    keepEnvRequired:
      keepEnvRequired ||
      names.some((name) => isCredentialEnvName(name)),
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
  const stateDirs = harnessStateDirs.map((dir) => canonicalSandboxBlockPath(dir));
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

/** Whether a caller's block equals or contains `path` (canonical forms). */
function callerBlockCovers(callerBlockPaths: readonly string[], path: string): boolean {
  const canonical = canonicalSandboxBlockPath(path);
  return callerBlockPaths.some((blocked) => containsPath(canonicalSandboxBlockPath(blocked), canonical));
}

/** The ambient SCODE_* scrub every codemux-side scode spawn applies
 * (review round 162, finding 4): scode consumes SCODE_* names itself —
 * scratch accounting's output sink among them — so an ambient variable
 * must never choose where a spawn writes. Real launches have scrubbed
 * here since buildSandboxEnv existed; the diagnostic spawns (the
 * namespace probes) use this directly on `process.env`. The only
 * SCODE_* names in a codemux spawn are the ones codemux sets itself,
 * after this scrub. */
export function withoutAmbientScodeEnv(
  env: Record<string, string>
): Record<string, string> {
  const sanitized = { ...env };
  for (const name of Object.keys(sanitized)) {
    if (name.toUpperCase().startsWith("SCODE_")) {
      delete sanitized[name];
    }
  }
  return sanitized;
}

export function buildSandboxEnv(
  extraEnv: Record<string, string> = {},
  sandboxOptions?: SandboxOptions
): Record<string, string> {
  const sanitized = withoutAmbientScodeEnv(extraEnv);
  if (sandboxOptions?.trust === "untrusted") delete sanitized[CLAUDE_LOGIN_SELECTOR_ENV];
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
