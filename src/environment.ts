import type { AgentId } from "./types.js";

const ALLOWED_CREDENTIAL_ENV: Record<AgentId, readonly string[]> = {
  // Antigravity authenticates through a cached OAuth login or an API key:
  // the binary's strings read both GEMINI_API_KEY and GOOGLE_API_KEY.
  // GOOGLE_APPLICATION_CREDENTIALS is deliberately absent: the ADC function
  // that would read it is linked into the binary, but a live probe (setting
  // it to a missing and then a valid-shaped service-account file) left the
  // headless auth path at the identical OAuth browser wall, so the variable
  // is never consulted and forwarding a service-account key would be a
  // claim without a reader. Nothing else it reads is a credential.
  agy: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  aider: [
    "ANTHROPIC_API_KEY",
    "AZURE_API_BASE",
    "AZURE_API_KEY",
    "AZURE_API_VERSION",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ],
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  cline: [],
  // 0.154 reads CODEX_API_KEY; OPENAI_API_KEY stays for older releases.
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_ENDPOINT", "CURSOR_API_KEY"],
  droid: ["FACTORY_API_KEY"],
  goose: [],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  // 0.31.1 authenticates through `kimi login` into ~/.kimi-code/credentials;
  // KIMI_API_KEY and OPENAI_API_KEY are the direct-credential paths.
  kimi: ["KIMI_API_KEY", "OPENAI_API_KEY"],
  opencode: [],
  // 1.16.0 ignores the environment unless --override-with-envs is passed.
  openhands: ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"],
  pi: [],
  qwen: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY"],
  zai: ["ANTHROPIC_AUTH_TOKEN"],
};

// Minimal environment needed for executable lookup, user config, terminals,
// temporary files, locale, and explicitly configured network proxies.
const INERT_ENV = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "GH_HOST",
  "GITHUB_HOST",
  "HOME",
  "HOSTNAME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const INERT_PREFIXES = ["LC_"] as const;

// These alter code loading, executable selection, or shell behavior before an
// external sandbox can enforce policy. Explicit grants cannot override them.
const FORBIDDEN_ENV = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "BUN_OPTIONS",
  "CDPATH",
  "COPILOT_ALLOW_ALL",
  // Copilot imports this directory's index.js instead of its installed distribution, including
  // for `--version`. Left inherited it lets an environment variable choose which code the harness
  // runs, and a version probe then reports whatever that code claims.
  "COPILOT_CLI_DIST_DIR",
  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
  "COPILOT_EXTENSIONS_CONFIG",
  "COPILOT_HOME",
  "ENV",
  "GEM_PATH",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PROXY_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "IFS",
  "GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS",
  "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
  "GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "LUA_CPATH",
  "LUA_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYLIB",
  "RUBYOPT",
  "SHELLOPTS",
  "_JAVA_OPTIONS",
]);
const FORBIDDEN_PREFIXES = [
  "AIDER_",
  "DYLD_",
  "GIT_CONFIG",
  "LD_",
  "SCODE_",
] as const;

/** The environment a version probe runs with: an allowlist, not a denylist.
 *
 * `sanitizeEnvironment` is for a launch, and needs an agent to know which credentials to keep. A
 * probe keeps none: it runs the binary to read a string, so it needs only what lets the binary be
 * found and produce readable output. Everything else is dropped, including credentials for other
 * agents, which a denylist would have passed through.
 *
 * It matters more here than at launch because the probe runs *before any sandbox exists*.
 * Copilot's COPILOT_CLI_DIST_DIR was the demonstration: inherited, it makes even `--version`
 * execute a chosen directory's JavaScript and report the version that code claims. Verified
 * against copilot 1.0.85 -- unscrubbed the probe read a fabricated 0.0.1 from a fixture directory.
 */
/** An environment that has been through `probeEnvironment`.
 *
 * The brand exists so `probeHarnessVersion` cannot be handed a raw `process.env`. Documenting the
 * requirement was not enough: two callers had to make the same decision independently, and both
 * got it wrong at least once -- the probe read the unfiltered parent environment in production,
 * and later the test did while production did not. The type makes the wrong call unrepresentable
 * rather than merely discouraged.
 */
/** Names that choose which executable a harness runs, as opposed to how it behaves.
 *
 * Deliberately empty. An earlier version carried `OPENCODE_BIN_PATH` here so the gate would
 * measure the binary the launch runs rather than the default. That is the right goal and the
 * wrong mechanism: the probe executes before scode exists, and only the launcher resolved from
 * `PATH` is validated, so honoring the variable runs an unvalidated binary outside the sandbox --
 * a worse failure than the mismeasurement it fixed.
 *
 * When a passed-through name could change which executable runs, the gate answers it one level
 * up, in `assertHarnessSupported` (see `EXECUTABLE_REDIRECTS`): it resolves the redirect to a
 * trusted executable itself and reads the verdict from that binary, or warns that the version
 * is unconfirmed when it cannot. The probe environment stays selector-free either way: a probe
 * that runs whatever a variable names is not recoverable the way a visible "cannot confirm" is.
 */
const EXECUTABLE_SELECTORS: ReadonlySet<string> = new Set();

/** Per harness, the names that redirect which executable it runs.
 *
 * Keyed by agent, because a redirect belongs to one harness: OPENCODE_BIN_PATH is read by
 * OpenCode's npm launcher and means nothing to Claude. A flat set made passing that one name
 * skip the version check for *every* agent, which turned a narrow "cannot confirm" into a
 * universal bypass -- worse than the mismeasurement it was added for.
 */
export const EXECUTABLE_REDIRECTS: Readonly<Partial<Record<string, readonly string[]>>> = {
  opencode: ["OPENCODE_BIN_PATH"],
};

/** The redirects actually in play: named for this agent, and present in the environment.
 *
 * Both conditions matter. A name the operator passed through but never set redirects nothing,
 * and skipping enforcement for it is a bypass with no cause.
 */
export function activeRedirects(
  agent: string,
  environment: Record<string, string>,
  explicitPassthrough: readonly string[]
): string[] {
  const known = new Set(EXECUTABLE_REDIRECTS[agent] ?? []);
  // A set-but-empty value is not a redirect. OpenCode's launcher treats `OPENCODE_BIN_PATH=""`
  // as no override and runs its default binary, so counting it as one made the gate skip probing
  // a binary it could have read -- letting a release below the floor through without the explicit
  // compatibility override. Checked against the value, not merely its presence.
  return explicitPassthrough.filter(
    (name) => known.has(name) && (environment[name] ?? "") !== ""
  );
}

export type ProbeEnvironment = Record<string, string> & {
  readonly __probeEnvironment: unique symbol;
};

export function probeEnvironment(
  environment: Record<string, string>,
  explicitPassthrough: readonly string[] = [],
  adapterProvided: readonly string[] = []
): ProbeEnvironment {
  // No passed-through name reaches the probe: EXECUTABLE_SELECTORS is deliberately empty (see
  // its doc above), so a name that selects an executable -- OpenCode's launcher picks its binary
  // from OPENCODE_BIN_PATH -- is dropped here exactly like a credential. Carrying the selector
  // was tried and withdrawn: the probe runs before scode exists and only the PATH-resolved
  // launcher is validated, so honoring the variable would run an unvalidated binary outside the
  // sandbox. The launch-versus-probe difference is handled one level up instead:
  // `activeRedirects` names what the launch keeps that the probe dropped, and the gate either
  // resolves the redirect to a trusted executable and probes that binary directly, or warns
  // "cannot confirm" and still gates the default binary below the floor.
  // One rule for both sources. Filtering only `explicitPassthrough` left adapter-injected names
  // crossing unchecked, which is the same hole half-closed: the question is whether a name
  // selects an executable, not who supplied it. The filter stays even with an empty selector
  // set, so a name re-added to it applies to both sources from the first day.
  const selects = (name: string) => EXECUTABLE_SELECTORS.has(name);
  const allowed = new Set([
    ...INERT_ENV,
    ...explicitPassthrough.filter(selects),
    ...adapterProvided.filter(selects),
  ]);
  const probe: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    const canonicalName = name.toUpperCase();
    // Matched on `name`, exactly as `sanitizeEnvironment` matches its allowlist. Matching the
    // upper-cased form here let lowercase variants through -- `https_proxy`, common in corporate
    // setups and honored by most HTTP clients, reached the probe while the launch stripped it, so
    // the two execs could resolve the network differently. The probe environment must be a subset
    // of the launch environment, never a superset.
    if (
      !allowed.has(name) &&
      // The locale prefixes the launch keeps (INERT_PREFIXES, e.g. LC_ALL) reach the probe too:
      // an allowlist without them made the two execs run under different locales for no reason
      // either documents.
      !INERT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      continue;
    }
    // Belt and braces: a name can be both inert-listed and forbidden only by mistake, and the
    // forbidden set is the one that decides which code runs.
    if (
      FORBIDDEN_ENV.has(canonicalName) ||
      FORBIDDEN_PREFIXES.some((prefix) => canonicalName.startsWith(prefix))
    ) {
      continue;
    }
    probe[name] = value;
  }
  return probe as ProbeEnvironment;
}

export function sanitizeEnvironment(
  agentId: AgentId,
  environment: Record<string, string>,
  explicitPassthrough: readonly string[] = [],
  adapterProvided: readonly string[] = []
): Record<string, string> {
  const allowed = new Set([
    ...INERT_ENV,
    ...ALLOWED_CREDENTIAL_ENV[agentId],
    ...explicitPassthrough,
    ...adapterProvided,
  ]);
  const sanitized: Record<string, string> = {};

  for (const [name, value] of Object.entries(environment)) {
    const canonicalName = name.toUpperCase();
    if (
      FORBIDDEN_ENV.has(canonicalName) ||
      FORBIDDEN_PREFIXES.some((prefix) => canonicalName.startsWith(prefix))
    ) {
      continue;
    }
    if (allowed.has(name) || INERT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}
