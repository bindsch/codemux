import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions } from "../sandbox.js";
import { canonicalSandboxBlockPath } from "../session/registry/format.js";
import { UsageRefusalError } from "../validation.js";

type HomeEnvironment = Readonly<Record<string, string | undefined>>;

// The sandbox must close every operator store, including other harnesses'
// instructions and credentials. A private HOME alone changes discovery,
// but leaves an absolute read of one of these stores possible.
const HOME_STORES = [
  ".claude", ".claude.json", ".codex", ".kimi-code", ".kimi", ".gemini",
  ".factory", ".cursor", ".cursor-agent", ".copilot", ".pi", ".agents",
  ".aider", ".aider.conf.yml", ".aider.model.settings.yml",
  ".aider.model.metadata.json", ".qwen", ".openhands", ".cline",
  ".goose", ".opencode", ".zai",
] as const;

const XDG_STORES = ["goose", "opencode", "cline", "github-copilot", "cursor"] as const;
const XDG_BASES = [
  ["XDG_CONFIG_HOME", ".config"],
  ["XDG_DATA_HOME", ".local/share"],
  ["XDG_STATE_HOME", ".local/state"],
  ["XDG_CACHE_HOME", ".cache"],
] as const;

// These variables name a store or a configuration file itself, unlike
// GEMINI_CLI_HOME and FACTORY_HOME_OVERRIDE, which replace HOME's base.
const STORE_ENV = [
  "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR",
  "COPILOT_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "GOOSE_PATH_ROOT",
  "GOOSE_CONFIG_DIR", "GOOSE_CONFIG_FILE", "GOOSE_DATA_DIR", "GOOSE_CACHE_DIR",
  "GOOSE_STATE_DIR", "CURSOR_CONFIG_DIR", "CLINE_DIR",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
  // OpenHands 1.16.0 locations.py:9-21 and stores/cli_settings.py:61-63:
  // "OPENHANDS_PERSISTENCE_DIR", "OPENHANDS_CONVERSATIONS_DIR", "PERSISTENCE_DIR".
  "OPENHANDS_PERSISTENCE_DIR", "OPENHANDS_CONVERSATIONS_DIR", "PERSISTENCE_DIR",
] as const;

function canonicalPath(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new UsageRefusalError(`${label} must be an absolute path without NUL bytes`);
  }
  return canonicalSandboxBlockPath(path);
}

/**
 * Snapshot operator stores before changing HOME or any harness/XDG variable.
 * Keep the defaults even when an alternate store is configured: either may
 * contain operator state. Canonicalization resolves symlinked ancestors and
 * missing tails with the same rule scode's conflict checks already use.
 */
export function harnessHomeBlockedPaths(
  env: HomeEnvironment,
  realHome: string = env.HOME || homedir(),
  cwd: string = process.cwd()
): string[] {
  const homes = new Set([canonicalPath(realHome, "operator HOME")]);
  for (const name of ["HOME", "USERPROFILE"] as const) {
    const value = env[name];
    if (value) homes.add(canonicalPath(value, name));
  }
  const paths: string[] = [];
  for (const home of homes) {
    for (const store of HOME_STORES) paths.push(join(home, store));
    for (const [, fallback] of XDG_BASES) {
      for (const store of XDG_STORES) paths.push(join(home, fallback, store));
    }
  }
  for (const [name] of XDG_BASES) {
    const value = env[name];
    if (!value) continue;
    const base = canonicalPath(value, name);
    for (const store of XDG_STORES) paths.push(join(base, store));
  }
  for (const name of STORE_ENV) {
    const value = env[name];
    if (value) paths.push(canonicalPath(value, name));
  }
  for (const [name, store] of [
    ["GEMINI_CLI_HOME", ".gemini"],
    ["FACTORY_HOME_OVERRIDE", ".factory"],
  ] as const) {
    const value = env[name];
    if (value) paths.push(join(canonicalPath(value, name), store));
  }
  // Qwen explicitly supports a relative QWEN_HOME. Resolve it against the
  // launch cwd, without trimming the bytes the harness itself receives.
  // Qwen 0.24.0 chunks/chunk-ZYDMQCQP.js:500-529: "QWEN_RUNTIME_DIR", "QWEN_HOME".
  for (const name of ["QWEN_HOME", "QWEN_RUNTIME_DIR"] as const) {
    const value = env[name];
    if (!value) continue;
    if (value.includes("\0")) {
      throw new UsageRefusalError(`${name} must not contain NUL bytes`);
    }
    paths.push(resolve(canonicalPath(cwd, "launch cwd"), value));
  }
  return [...new Set(paths.map((path) => canonicalPath(path, "operator harness store")))].sort();
}

function contains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

/**
 * Mutate the options shared by spawn and --print-sandbox only after every
 * check passes. Every allow must be disjoint from every operator store:
 * scode allows descendants after blocks, so allowing either an ancestor
 * or a descendant would reopen operator state. The caller validates the
 * private directory's ownership and permissions before calling this helper.
 */
export function applyHarnessHomeSandboxBlocks(
  options: SandboxOptions,
  privateHome: string,
  realPaths: readonly string[],
  /** Dedicated credential directories a caller home shares by symlink, as the
   * hermetic home does (kimi): each must lie strictly inside an operator store,
   * and only that directory is granted back. */
  sharedLoginDirs: readonly string[] = []
): void {
  const stateDirs = [...new Set([
    ...(options.harnessStateDirs ?? []), privateHome,
  ].map((path) => canonicalPath(path, "--harness-home state directory")))];
  const callerBlocks = (options.blockPaths ?? []).map((path) => canonicalPath(path, "--sandbox-block"));
  const operatorBlocks = [...new Set(realPaths.map((path) => canonicalPath(path, "operator harness store")))];
  if (operatorBlocks.length === 0) {
    throw new UsageRefusalError("--harness-home requires the operator's harness stores to be blocked");
  }
  assertNoCallerBlockOverStateDirs(callerBlocks, stateDirs);
  for (const directory of stateDirs) {
    for (const blocked of operatorBlocks) {
      if (contains(blocked, directory) || contains(directory, blocked)) {
        throw new UsageRefusalError(
          `--harness-home state directory ${directory} overlaps the operator's harness store ${blocked}; ` +
          "choose a private directory outside every operator harness store"
        );
      }
    }
  }
  const shared = [...new Set(sharedLoginDirs.map((path) => canonicalPath(path, "shared login directory")))];
  for (const directory of shared) {
    if (!operatorBlocks.some((blocked) => blocked !== directory && contains(blocked, directory))
        || operatorBlocks.some((blocked) => contains(directory, blocked))
        || stateDirs.some((state) => contains(state, directory) || contains(directory, state))) {
      throw new UsageRefusalError(`--harness-home cannot share the login directory ${directory}: ` +
        "it must lie strictly inside one operator harness store and outside the caller home");
    }
  }
  assertNoCallerBlockOverStateDirs(callerBlocks, shared);
  options.callerBlockPaths ??= callerBlocks;
  options.blockPaths = [...new Set([...callerBlocks, ...operatorBlocks])];
  options.harnessHomeBlockedPaths = operatorBlocks;
  options.harnessStateDirs = [...stateDirs, ...shared];
}
