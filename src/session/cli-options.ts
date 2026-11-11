/** The session command's option surface, split from src/session/cli.ts:
 * every `.option` row commander parses, in the order the reference lists
 * them. The action stays behind in cli.ts; only the registration moved. */

import type { Command } from "commander";
import { agentsSupporting } from "../parity/index.js";
import type { SessionFeature } from "../parity/features.js";
import { SESSION_AGENTS } from "./cli-agents.js";
import { AGENT_IDS } from "../types.js";

/** Help lists come from the declarations, so the text cannot drift from them. */
const agents = (feature: SessionFeature): string => agentsSupporting(feature).join(", ");

export function registerSessionOptions(command: Command, defaultAgent: string): void {
  command
    .option("-a, --agent <agent>", `Session agent: ${AGENT_IDS.filter((id) => SESSION_AGENTS[id] !== undefined).join(", ")}`, defaultAgent)
    .option("-m, --model <model>", "Model to use (supports aliases)")
    .option("--resume <id>", "Resume a recorded session id")
    .option("--harness-home <dir>", "Persistent caller-owned private harness home; absolute path, incompatible with --hermetic")
    .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
    .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
    .option("--cwd <path>", "Working directory")
    .option("--timeout <seconds>", "Whole-session cap: >0 to 86400 seconds; fractions rounded up to milliseconds (default: none)")
    .option("--turn-timeout <seconds>", "Per-turn cap for agents with interruption support; interrupts the current turn (default: none)")
    .option("--permission-timeout <seconds>", "How long a permission request waits before codemux answers deny", "300")
    .option("--shutdown-grace <seconds>", "How long the harness gets to answer the end before SIGTERM, and again to exit before the kill", "10")
    .option("--no-author-prefix", "Do not prefix harness-bound text with [author]")
    .option("--tools <selection>", `Tool selection: default or none (${agents("session.tools")}; opencode none requires --hermetic)`)
    .option("--enable-playwright-mcp", `Enable the local Playwright MCP (${agents("session.playwright-mcp")}; requires --sandbox; autonomy rules: docs/sessions.md)`)
    .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
    .option(
      "--hermetic",
      `Hermetic session: no operator instructions, skills, hooks, or MCP servers load (${agents("session.hermetic")}); per-session private state home except Qwen keeps its native state store`
    )
    .option(
      "--experiment-project-settings",
      `Run the session under the repository's own settings in a private per-session config directory (${agents("session.experiment-project-settings")}; requires --hermetic and scode)`
    )
    .option(
      "--final",
      "With --hermetic: remove the session's private home when this command ends; caller-owned --harness-home directories stay"
    )
    .option(
      "--permission-policy <policy>",
      "Permission policy: 'deny' denies approval requests or uses native deny rules (hermetic for Kimi/OpenCode/agy); 'default' uses the agent's ordinary policy"
    )
    .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
    .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
    .option("--sandbox-trust <level>", "scode trust override: trusted or standard (untrusted refused for sandboxed sessions)")
    .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
    .option("--sandbox-strict", "Pass --strict to scode (deny-default); requires --sandbox and must match on resume")
    .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
    .option(
      "--sandbox-block <path>",
      "Pass an extra scode --block for this session's children (repeatable); absolute paths only",
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option(
      "--print-sandbox",
      "Print scode argv for the session child, or a representative per-turn command for Aider, Cline, Copilot, Cursor, Droid, Gemini, Goose, Kimi, OpenCode, OpenHands, Pi, or Qwen, one argument per line (controls escaped, a newline prints as \\n), and exit 0 without starting a session; requires --sandbox"
    )
    .option(
      "--sandbox-account <file>",
      "Refused for sessions: the per-turn agents spawn several children, so a session has no single accounting stream; use run or tui"
    )
    .option(
      "--sandbox-account-id <id>",
      "Refused for sessions together with --sandbox-account; use run or tui"
    )
    .option(
      "--max-budget-usd <amount>",
      "Refused for sessions: Claude Code applies the spend limit to headless runs only; use run"
    )
    .option(
      "--quota-ceiling <percent>",
      "Refuse the session when a bounding usage window is below this percent remaining; overrides the config quota ceiling for this invocation"
    )
    .option("--no-quota-gate", "Skip the pre-launch usagemux quota check for this invocation");
}
