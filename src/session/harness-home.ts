import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageRefusalError } from "../validation.js";
import type { AgentId } from "../types.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { settledPrivateHomePath } from "./private-home-key.js";
import { scodeDefaultBlockedPaths } from "../launch/scode-default-blocks.js";
import { canonicalSandboxBlockPath } from "./registry/format.js";
import { copyClaudeCredentialMirror } from "../claude-credential-mirror.js";
import { qwenLoginPath, writeQwenAccessOnlyLogin } from "../qwen-access-login.js";

function refuse(reason: string): never {
  throw new UsageRefusalError(`--harness-home ${reason}`);
}

function info(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function owned(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

/** Resolve absent descendants without accepting a symlink in their path. */
function checkedPath(path: string): string {
  const stat = info(path);
  if (stat !== null) {
    if (stat.isSymbolicLink()) refuse("must not contain a symlink");
    if (!stat.isDirectory()) refuse("must be a directory");
    const canonical = realpathSync(path);
    if (canonical !== path) refuse("must use a canonical path without symlink ancestors");
    return canonical;
  }
  const parent = dirname(path);
  if (parent === path) refuse("has no existing directory ancestor");
  return join(checkedPath(parent), relative(parent, path));
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Validation does not create directories. Resume and print use this same spelling.
 * scode's default blocks refuse too: an allow beneath one reopens it (M2). */
export function validateHarnessHome(path: string, cwd: string, blockedPaths: readonly string[],
  sandboxDefaults: readonly string[] = scodeDefaultBlockedPaths()): string {
  if (!isAbsolute(path) || path.trim() !== path || path.includes("\0")) {
    refuse("must be an absolute, unpadded directory path");
  }
  const canonical = checkedPath(resolve(path));
  const stat = info(canonical);
  if (stat !== null && !owned(stat)) refuse("must be owned by the invoking user");
  const roots = [realpathSync(cwd), ...blockedPaths];
  for (const root of roots) {
    // An ancestor would grant access to the same forbidden tree through scode.
    const resolved = info(root) === null ? resolve(root) : realpathSync(root);
    if (inside(canonical, resolved) || inside(resolved, canonical)) {
      refuse("must be separate from the working directory and real harness homes");
    }
  }
  for (const root of sandboxDefaults) {
    const resolved = canonicalSandboxBlockPath(root);
    if (inside(canonical, resolved) || inside(resolved, canonical)) {
      refuse(`must not overlap scode's default-blocked path ${resolved}`);
    }
  }
  return canonical;
}

function privateDirectory(path: string): void {
  checkedPath(path);
  const before = info(path);
  if (before === null) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = info(path);
  if (stat === null || !stat.isDirectory() || !owned(stat)) {
    refuse("requires an owned directory without symlinks");
  }
  checkedPath(path);
  chmodSync(path, 0o700);
}

/** No symlink fallback: the sandbox must never reopen the real login path. */
export function linkHarnessLogin(source: string, destination: string, required: boolean): void {
  const original = info(source);
  const linked = info(destination);
  if (original === null) {
    if (required || linked !== null) refuse("needs the real file login; a missing login cannot be reused");
    return;
  }
  checkedPath(dirname(source));
  privateDirectory(dirname(destination));
  if (!original.isFile() || !owned(original)) refuse("login must be an owned regular file without symlinks");
  if (linked !== null) {
    if (!linked.isFile() || !owned(linked) || linked.dev !== original.dev || linked.ino !== original.ino) {
      refuse("login link changed; remove the stale private login before launching again");
    }
  } else {
    try { linkSync(source, destination); }
    catch { refuse("cannot hard-link the login; use a directory on the login filesystem"); }
  }
  const after = info(source);
  const target = info(destination);
  if (after === null || target === null || !after.isFile() || !target.isFile() || !owned(after) || !owned(target)
      || after.dev !== original.dev || after.ino !== original.ino || target.dev !== original.dev || target.ino !== original.ino) {
    refuse("login changed while linking; retry after restoring the file login");
  }
}

export interface CallerHarnessHome extends SessionPrivateHome {
  readonly callerOwned: true;
  readonly environment: Record<string, string>;
  /** Native file/config redirects removed inside the sandbox's env command. */
  readonly environmentOmissions?: readonly string[];
  /** Revalidate the directory and login immediately before each child launch. */
  verify(): void;
}

export function isCallerHarnessHome(home: object | null | undefined): home is CallerHarnessHome {
  return home != null && "callerOwned" in home && home.callerOwned === true;
}

export function recordedHarnessHome(home: SessionPrivateHome, sessionId: string): string {
  return isCallerHarnessHome(home) ? home.dir : settledPrivateHomePath(home.dir, sessionId);
}

export function callerHarnessHomeEnvAssignments(home: CallerHarnessHome): string[] {
  return [
    ...(home.environmentOmissions ?? []).flatMap((name) => ["-u", name]),
    ...Object.entries(home.environment).map(([name, value]) => `${name}=${value}`),
  ];
}

type HomeEnvironment = Readonly<Record<string, string | undefined>>;
type HomeAgent = AgentId;
type Login = { source: string; destination: string; required: boolean };
/** An access-token-only login codemux rebuilds from `source` on every launch. */
type Mirror = { source: string; directory: string; write: (source: string, directory: string) => void };
type Recipe = {
  environment: Record<string, string>; omissions?: readonly string[]; logins: Login[];
  needsKey?: boolean; flags?: Record<string, string>;
  /** Why the agent requires a provider override; unset when it does not. */
  needsOverride?: string;
  mirrors?: Mirror[];
  /** A dedicated credential directory shared by a directory symlink (kimi). */
  sharedStore?: { source: string; destination: string };
};

const MIXED_STORE = "its native login store also contains settings";

/** Only credential names count: an endpoint or model alone is not authentication. */
export function callerHarnessHomeAuthEnvironment(agent: AgentId, env: HomeEnvironment): Record<string, string> {
  const names: Record<AgentId, readonly string[]> = {
    agy: ["GEMINI_API_KEY"],
    aider: ["ANTHROPIC_API_KEY", "AZURE_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
      "GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], cline: [],
    codex: ["CODEX_API_KEY", "OPENAI_API_KEY"], copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    cursor: ["CURSOR_API_KEY"], droid: ["FACTORY_API_KEY"], gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    goose: [], kimi: ["KIMI_API_KEY", "OPENAI_API_KEY"], opencode: [], openhands: ["LLM_API_KEY"], pi: [],
    qwen: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY"], zai: ["ANTHROPIC_AUTH_TOKEN", "ZAI_API_KEY"],
  };
  const credentials: Record<string, string> = {};
  for (const name of names[agent]) {
    const value = env[name];
    if (value?.trim()) credentials[name] = value;
  }
  return credentials;
}

export function callerHarnessHomeApiKeyAuth(agent: AgentId, env: HomeEnvironment): boolean {
  return Object.keys(callerHarnessHomeAuthEnvironment(agent, env)).length > 0;
}

function redirectedRoot(env: HomeEnvironment, name: string, fallback: string, cwd: string): string {
  const value = env[name];
  if (!value) return fallback;
  if (value.includes("\0")) refuse(`${name} must not contain NUL bytes`);
  return resolve(cwd, value);
}

/** Source roots are captured before a child changes HOME. No credential contents are read. */
function homeRecipe(agent: HomeAgent, dir: string, source: string, env: HomeEnvironment, cwd: string, inspectLogin: boolean): Recipe {
  const root = (name: string, fallback: string): string => redirectedRoot(env, name, fallback, cwd);
  const login = (from: string, to: string, required = true): Login => ({ source: from, destination: to, required });
  const same = (base: string, target: string, names: readonly string[]): Login[] =>
    names.map((name, index) => login(join(base, name), join(target, name), index === 0));
  switch (agent) {
    // Claude 2.1.317 bin/claude.exe: "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    // ".credentials.json", "~/.agents/skills". The existing Claude layout is the caller root itself.
    // The login is never linked: a link hands the child the mirror's inode, refresh token
    // included, and breaks on every rename refresh (review R420 B1, M1). The caller home gets
    // the hermetic path's access-token-only copy (claude-credential-mirror.ts), rebuilt per launch.
    case "claude":
    case "zai":
      return { environment: { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir }, logins: [],
        mirrors: agent === "zai" ? [] : [{ source: join(source, ".credentials.json"), directory: dir,
          write: (from, to) => copyClaudeCredentialMirror(to, from, "--harness-home session") }] };
    // Codex 0.166.0 bin/codex: "CODEX_HOME", "auth.json", 'cli_auth_credentials_store = "file"'.
    case "codex":
      return { environment: { CODEX_HOME: join(dir, ".codex") }, logins: same(source, join(dir, ".codex"), ["auth.json"]) };
    // Agy 1.5.3 .local/bin/agy: "os.UserHomeDir", "~/.gemini/antigravity-cli/settings.json",
    // "Added support for GEMINI_API_KEY". No portable OAuth filename is established.
    case "agy": return { environment: {}, logins: [], needsKey: true };
    // Aider 0.86.2 aider/main.py:370,476: 'Path.home() / ".aider" / "oauth-keys.env"', 'Path.home() / conf_fname'.
    case "aider": return { environment: {}, logins: same(join(source, ".aider"), join(dir, ".aider"), ["oauth-keys.env"]) };
    // Copilot 1.0.85 app.js:189,3379,3439: "COPILOT_HOME", "config.json", "COPILOT_GITHUB_TOKEN".
    // config.json also defines hooks; it is not an auth-only store.
    case "copilot": return { environment: { COPILOT_HOME: join(dir, ".copilot") }, logins: [], needsOverride: MIXED_STORE };
    // Cursor 2026.11.05-86047df index.js:414: "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "auth.json".
    // The Darwin credential backend uses HOME independently of CURSOR_CONFIG_DIR.
    case "cursor": {
      const from = process.platform === "darwin" ? join(source, ".cursor")
        : join(root("XDG_CONFIG_HOME", join(source, ".config")), "cursor");
      const to = process.platform === "darwin" ? join(dir, ".cursor") : join(dir, ".config", "cursor");
      return { environment: { CURSOR_CONFIG_DIR: join(dir, ".cursor") }, logins: same(from, to, ["auth.json"]) };
    }
    // Droid 0.221.0 .local/bin/droid: "FACTORY_HOME_OVERRIDE", ".factory", "auth.json", "settings.json".
    case "droid": return { environment: { FACTORY_HOME_OVERRIDE: dir },
      logins: same(join(root("FACTORY_HOME_OVERRIDE", source), ".factory"), join(dir, ".factory"), ["auth.json"]) };
    // Gemini 0.60.0 bundle/chunk-VCAJDPDX.js:251982-251990,253147: "GEMINI_CLI_HOME", "google_accounts.json", "oauth_creds.json".
    case "gemini": return { environment: { GEMINI_CLI_HOME: dir },
      omissions: ["GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_SYSTEM_DEFAULTS_PATH"],
      logins: same(join(root("GEMINI_CLI_HOME", source), ".gemini"), join(dir, ".gemini"), ["oauth_creds.json", "google_accounts.json"]) };
    // Goose 1.50.1 crates/goose/src/config/paths.rs: "GOOSE_PATH_ROOT", "Config"; .local/bin/goose: "secrets.yaml".
    // GOOSE_PATH_ROOT selects root/config directly, without the XDG brand suffix. No login is
    // linked: the installed binary does not establish that secrets.yaml is rewritten in place,
    // so the hermetic run's rule applies (adapters/goose.ts): the provider override is the credential.
    case "goose":
      return { environment: { GOOSE_PATH_ROOT: dir, XDG_CONFIG_HOME: join(dir, "config"),
        XDG_DATA_HOME: join(dir, "share"), XDG_CACHE_HOME: join(dir, "cache") },
        omissions: ["GOOSE_CONFIG_DIR", "GOOSE_CONFIG_FILE", "GOOSE_DATA_DIR", "GOOSE_CACHE_DIR", "GOOSE_STATE_DIR"],
        // Goose 1.50.1 .local/bin/goose: "GOOSE_DISABLE_KEYRING=true" selects "File-based Storage".
        flags: { GOOSE_DISABLE_KEYRING: "true" }, logins: [],
        needsOverride: "the installed binary does not establish that secrets.yaml is rewritten in place" };
    // Cline cli-v3.0.74 shared/src/storage/paths.ts:91-166,431-452: HOME, CLINE_DIR, and the
    // CLINE_*_PATH and CLINE_*_DATA_DIR overrides. Its provider settings file stores API keys
    // beside settings, so it follows the copilot rule: the provider override is the credential.
    case "cline": return { environment: { CLINE_DIR: join(dir, ".cline") },
      omissions: ["CLINE_DATA_DIR", "CLINE_SESSION_DATA_DIR", "CLINE_PROVIDER_SETTINGS_PATH",
        "CLINE_GLOBAL_SETTINGS_PATH", "CLINE_MCP_SETTINGS_PATH"], logins: [],
      needsOverride: "its provider settings file stores API keys beside settings" };
    // Kimi 2.5.2 .kimi-code/bin/kimi:644187-644189: "KIMI_CODE_HOME", "credentials", "FileTokenStorage".
    // Kimi replaces token files by rename, so a hard link would strand a rotated token in the
    // caller home. The hermetic home's mechanism applies instead (kimi-hermetic.ts:351): one
    // directory symlink to the dedicated store, which the sandbox grants by name.
    case "kimi": {
      const from = kimiCredentialStore(source, env, cwd);
      if (inspectLogin) {
        if (info(from) !== null) checkedPath(from);
        if (info(from) === null || readdirSync(from).length === 0) refuse("needs a nonempty dedicated credential store for 'kimi'");
      }
      return { environment: { KIMI_CODE_HOME: join(dir, ".kimi-code") }, logins: [],
        sharedStore: { source: from, destination: join(dir, ".kimi-code", "credentials") } };
    }
    // OpenCode 1.19.5 .opencode/bin/opencode: "OPENCODE_CONFIG_DIR??", "XDG_DATA_HOME", 'join(de.data,"auth.json")'.
    case "opencode": return { environment: { OPENCODE_CONFIG_DIR: join(dir, ".config", "opencode") },
      omissions: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_AUTH_CONTENT"],
      logins: same(join(root("XDG_DATA_HOME", join(source, ".local", "share")), "opencode"),
        join(dir, ".local", "share", "opencode"), ["auth.json"]) };
    // OpenHands 1.16.0 openhands_cli/locations.py:9-21 and stores/cli_settings.py:61-63:
    // "OPENHANDS_PERSISTENCE_DIR", "OPENHANDS_CONVERSATIONS_DIR", "PERSISTENCE_DIR".
    // stores/agent_store.py:473-475: 'context={"expose_secrets": True}' mixes settings and secrets.
    case "openhands": return { environment: { OPENHANDS_PERSISTENCE_DIR: join(dir, ".openhands"),
      OPENHANDS_CONVERSATIONS_DIR: join(dir, ".openhands", "conversations"), PERSISTENCE_DIR: join(dir, ".openhands") },
      logins: [], needsOverride: MIXED_STORE };
    // Pi 0.85.1 dist/config.js:405,421-442: "PI_CODING_AGENT_DIR", "auth.json", "settings.json".
    case "pi": return { environment: { PI_CODING_AGENT_DIR: join(dir, ".pi", "agent") },
      logins: same(root("PI_CODING_AGENT_DIR", join(source, ".pi", "agent")), join(dir, ".pi", "agent"), ["auth.json"]) };
    // Qwen 0.24.0 chunks/chunk-ZYDMQCQP.js:500-541,820,918-922: "QWEN_HOME", "QWEN_RUNTIME_DIR",
    // "oauth_creds.json"; sibling skills use HOME. google_accounts.json has a path getter and no reader.
    // Qwen renames oauth_creds.json on refresh, so only its access fields ride in (qwen-access-login.ts).
    case "qwen": return { environment: { QWEN_HOME: join(dir, ".qwen"), QWEN_RUNTIME_DIR: join(dir, ".qwen", "runtime") },
      omissions: ["QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH"], logins: [],
      mirrors: [{ source: qwenLoginPath(root("QWEN_HOME", join(source, ".qwen"))), directory: join(dir, ".qwen"),
        write: (from, to) => writeQwenAccessOnlyLogin(from, to) }] };
  }
}

/** Roots every caller home sets, whatever the agent. */
const CALLER_HOME_ROOTS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

/** Every name a caller home sets or clears in the child's environment:
 * the shared roots, the agent's own redirects, its cleared redirects,
 * and its flags. Paths are placeholders; no file is read or created. */
export function callerHarnessHomeEnvNames(agent: AgentId): readonly string[] {
  const recipe = homeRecipe(agent, "/", "/", {}, "/", false);
  return [...new Set([...CALLER_HOME_ROOTS, ...Object.keys(recipe.environment), ...(recipe.omissions ?? []),
    ...Object.keys(recipe.flags ?? {})])];
}

/** A --pass-env name the caller home sets or clears would be replaced
 * without notice, so it is refused, as `check --session` refuses its own. */
export function assertHarnessHomePassEnv(agent: AgentId, passthroughEnv: readonly string[]): void {
  const owned = callerHarnessHomeEnvNames(agent);
  const conflicts = passthroughEnv.filter((name) => owned.includes(name));
  if (conflicts.length > 0) {
    refuse(`sets or clears ${conflicts.join(", ")} for '${agent}'; remove ${conflicts.length === 1 ? "it" : "them"} from --pass-env`);
  }
}

/** Directories a caller home shares by symlink, which the sandbox must grant by name. */
export function callerHarnessHomeSharedLogins(agent: AgentId, sourceHome: string, env: HomeEnvironment,
  cwd: string, apiKeyAuth: boolean): string[] {
  return agent === "kimi" && !apiKeyAuth ? [kimiCredentialStore(sourceHome, env, cwd)] : [];
}

/** The dedicated kimi store a caller home shares; the sandbox grants exactly this path. */
export function kimiCredentialStore(sourceHome: string, env: HomeEnvironment, cwd: string): string {
  return join(redirectedRoot(env, "KIMI_CODE_HOME", join(sourceHome, ".kimi-code"), cwd), "credentials");
}

function verifySharedStore(store: NonNullable<Recipe["sharedStore"]>): void {
  const stat = info(store.source);
  if (stat === null || !stat.isDirectory() || !owned(stat)) refuse("dedicated credential store was removed before launch");
  checkedPath(store.source);
  privateDirectory(dirname(store.destination));
  const linked = info(store.destination);
  if (linked === null) symlinkSync(store.source, store.destination, "dir");
  else if (!linked.isSymbolicLink() || readlinkSync(store.destination) !== store.source) {
    refuse(`credential store link changed; remove ${store.destination} before launching again`);
  }
}

function writeMirror(mirror: Mirror): void {
  if (info(mirror.source) === null) refuse("needs the real file login; a missing login cannot be reused");
  privateDirectory(mirror.directory);
  mirror.write(mirror.source, mirror.directory);
}

/** Caller homes never settle to a session key and never belong to cleanup. */
export function openCallerHarnessHome(input: {
  agent: AgentId; dir: string; cwd: string; blockedPaths: readonly string[];
  sourceHome: string; apiKeyAuth: boolean; resumed?: boolean; printOnly?: boolean;
  sourceEnv?: HomeEnvironment;
  providerOverride?: boolean;
}): CallerHarnessHome {
  const dir = validateHarnessHome(input.dir, input.cwd, input.blockedPaths);
  const sourceEnv = { ...(input.sourceEnv ?? process.env) };
  const apiKeyAuth = input.apiKeyAuth || input.providerOverride === true;
  const recipe = homeRecipe(input.agent, dir, input.sourceHome, sourceEnv, input.cwd, !apiKeyAuth && !input.printOnly);
  if (recipe.needsOverride && !input.providerOverride) {
    refuse(`for '${input.agent}' requires a provider override; ${recipe.needsOverride}`);
  }
  if (recipe.needsKey && !apiKeyAuth) {
    refuse(`for '${input.agent}' requires provider/token authentication; no dedicated portable login file is available`);
  }
  const environment: Record<string, string> = {
    HOME: dir,
    USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, ".config"), XDG_DATA_HOME: join(dir, ".local", "share"),
    XDG_STATE_HOME: join(dir, ".local", "state"), XDG_CACHE_HOME: join(dir, ".cache"),
    ...recipe.environment,
  };
  const directories = Object.values(environment);
  Object.assign(environment, recipe.flags);
  let prepared = false;
  const verify = (): void => {
    validateHarnessHome(dir, input.cwd, input.blockedPaths);
    if (input.printOnly) return;
    if (prepared && info(dir) === null) refuse("was removed before launch; restore the caller directory");
    privateDirectory(dir);
    for (const path of directories) privateDirectory(path);
    if (!apiKeyAuth) {
      if (recipe.sharedStore) verifySharedStore(recipe.sharedStore);
      for (const mirror of recipe.mirrors ?? []) writeMirror(mirror);
      for (const login of recipe.logins) linkHarnessLogin(login.source, login.destination, login.required);
    }
    prepared = true;
  };
  verify();
  return {
    dir, callerOwned: true, environment, environmentOmissions: recipe.omissions, resumed: input.resumed === true, settled: true,
    blockedPaths: input.blockedPaths, verify,
    settle: () => {},
    remove: () => false,
  };
}
