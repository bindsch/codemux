import type { AgentId } from "./types.js";

const ALLOWED_CREDENTIAL_ENV: Record<AgentId, readonly string[]> = {
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
  codex: ["OPENAI_API_KEY"],
  copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_ENDPOINT", "CURSOR_API_KEY"],
  droid: ["FACTORY_API_KEY"],
  goose: [],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  opencode: [],
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
