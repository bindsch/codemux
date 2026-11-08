/**
 * The machine check's remedy table (audit report D, section 3): the one
 * line per harness-and-state that says what the owner types. Two sources
 * are deliberately kept apart: usagemux owns provider remedies (its
 * `message` is printed verbatim by the usage check, never reworded here),
 * and this table owns only the states codemux itself defines. No remedy
 * carries an account name, a token, or a home path beyond `~/` notation.
 */

import type { AgentId } from "./types.js";
import type { MachineCheckState } from "./doctor-model.js";

/** What a remedy line may need to know about its row. */
export interface RemedyContext {
  /** The unmet feature floor, for FEATURE-FLOOR. */
  feature?: string;
  /** The floor version, for FEATURE-FLOOR and SANDBOX-TOO-OLD. */
  floor?: string;
  /** The resolved binary path, for UNTRUSTED. */
  path?: string;
}

/** The harness's own upgrade command, where one exists (report D). */
const UPDATE_COMMANDS: Readonly<Partial<Record<AgentId, string>>> = {
  agy: "agy update",
  kimi: "kimi upgrade",
  copilot: "copilot update",
  droid: "droid update",
  qwen: "qwen update",
  goose: "goose update",
  pi: "pi update",
};

const NO_LOGIN_REMEDIES: Readonly<Partial<Record<AgentId, string>>> = {
  claude: "claude auth login",
  zai: 'umask 077; read -rs ZAI_KEY; printf \'%s\\n\' "$ZAI_KEY" > ~/.zai; unset ZAI_KEY (docs/authentication.md)',
  codex: 'codex login; for hermetic runs set cli_auth_credentials_store = "file" in ~/.codex/config.toml first, or export CODEX_API_KEY',
  kimi: "kimi login (device-code flow)",
  agy: "run agy once interactively to create the file token, or export GEMINI_API_KEY",
  cursor: "AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login; or --pass-env CURSOR_API_KEY",
  opencode: "opencode auth login",
  gemini: "run gemini once and sign in, or export GEMINI_API_KEY",
  qwen: "run qwen once with --auth-type qwen-oauth, or export the OpenAI-compatible key",
  goose: "goose configure",
  copilot: "copilot login (--device-code over SSH); account policy may still refuse",
  droid: "droid doctor --auth, then droid to log in",
  pi: "export the provider key (pi auth check --provider <p> names it)",
  aider: "export the provider key the configured model needs (OPENAI_API_KEY, ANTHROPIC_API_KEY); aider --list-models shows the provider",
  openhands: "export the provider key the configured model needs (LLM_API_KEY)",
};

const FEATURE_FLOOR_REMEDIES: Readonly<{
  agent: AgentId;
  feature: string;
  remedy: string;
}[]> = [
  {
    agent: "claude",
    feature: "sessions",
    remedy:
      "brew upgrade claude or npm i -g @anthropic-ai/claude-code@latest to >= 2.1.280; if the link is pinned by another workload, prepend a PATH directory with the newer binary",
  },
  {
    agent: "claude",
    feature: "experiment-mcp",
    remedy:
      "brew upgrade claude or npm i -g @anthropic-ai/claude-code@latest to >= 2.1.280; if the link is pinned by another workload, prepend a PATH directory with the newer binary",
  },
  {
    agent: "zai",
    feature: "sessions",
    remedy:
      "brew upgrade claude or npm i -g @anthropic-ai/claude-code@latest to >= 2.1.280 (zai runs the same binary); if the link is pinned, prepend a PATH directory with the newer binary",
  },
  {
    agent: "zai",
    feature: "experiment-mcp",
    remedy:
      "brew upgrade claude or npm i -g @anthropic-ai/claude-code@latest to >= 2.1.280 (zai runs the same binary); if the link is pinned, prepend a PATH directory with the newer binary",
  },
  { agent: "codex", feature: "experiment-mcp", remedy: "upgrade codex to >= 0.165.0" },
  { agent: "kimi", feature: "experiment-mcp", remedy: "kimi upgrade to >= 2.3.2" },
];

/** The remedy line for one harness state, or null when the state needs
 * no action. QUOTA-UNREADABLE is deliberately absent: usagemux's own
 * message is the remedy there (printed verbatim in the row), except for
 * claude's timeout case. */
export function remedyFor(
  agent: AgentId,
  state: MachineCheckState,
  context: RemedyContext = {}
): string | null {
  switch (state) {
    case "NOT-INSTALLED":
      return "install from the harness's own installer; `codemux list --json` names the expected binary (the `binary` field)";
    case "UNTRUSTED":
      return context.path
        ? `chmod go-w ${context.path}; or move the binary out of the working directory; owner must be you or root`
        : "chmod go-w the binary; or move it out of the working directory; owner must be you or root";
    case "VERSION-BELOW-MIN": {
      const update = UPDATE_COMMANDS[agent];
      return update !== undefined
        ? `${update}; or CODEMUX_ALLOW_UNTESTED_HARNESS=1 for one run`
        : `upgrade ${agent}; or CODEMUX_ALLOW_UNTESTED_HARNESS=1 for one run`;
    }
    case "VERSION-UNREADABLE":
      return "the launch gate warns and continues; run the harness's own --version to see why the probe cannot read it";
    case "VERSION-ABOVE-CEILING":
      return "no action; the row names the ceiling so a live gate can move it";
    case "FEATURE-FLOOR": {
      const specific = FEATURE_FLOOR_REMEDIES.find(
        (entry) => entry.agent === agent && entry.feature === context.feature
      );
      return (
        specific?.remedy ??
        `upgrade ${agent} to >= ${context.floor ?? "the recorded floor"} for ${context.feature ?? "this feature"}`
      );
    }
    case "SANDBOX-TOO-OLD":
      return `brew upgrade bindsch/tap/scode to >= ${context.floor ?? "the recorded floor"}`;
    case "SANDBOX-MISSING":
      return "brew install bindsch/tap/scode (needed for every autonomy below high)";
    case "NO-LOGIN":
      return (
        NO_LOGIN_REMEDIES[agent] ??
        "log in through the harness's own login flow"
      );
    case "LOGIN-EXPIRED":
      if (agent === "claude") {
        return "claude auth login; if the Keychain is readable but the mirror is stale, one unsandboxed claude run refreshes it";
      }
      if (agent === "kimi") {
        return "kimi login (device-code flow); the store holds no refresh token, so kimi cannot renew the access token itself";
      }
      return "log in again through the harness's own login flow";
    case "OVERRIDE-INVALID":
      return `the row names the variable (CODEMUX_${agent.toUpperCase()}_PROVIDER_*): set all three of BASE_URL, API_KEY, MODEL, or unset all`;
    case "QUOTA-LOW":
      return "wait for the reset time in the row; or --quota-ceiling <n> for one run; route to a harness with headroom (usagemux snapshot)";
    case "QUOTA-UNREADABLE":
      return agent === "claude"
        ? "add quota: { timeoutSeconds: 60 } to ~/.config/codemux/config.yaml"
        : null;
    case "USAGEMUX-MISSING":
      return "brew install bindsch/tap/usagemux";
    case "USAGEMUX-UNREADABLE":
      return "brew reinstall bindsch/tap/usagemux; the row's detail names why its --version could not be read";
    case "USAGEMUX-STALE":
      return "brew upgrade bindsch/tap/usagemux";
    case "PROBE-FAILED":
      return `rerun codemux check -a ${agent} for the full output`;
    default:
      return null;
  }
}
