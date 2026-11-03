/** The session command's option surface, split from src/session/cli.ts:
 * every `.option` row commander parses, in the order the reference lists
 * them. The action stays behind in cli.ts; only the registration moved. */

import type { Command } from "commander";

export function registerSessionOptions(command: Command, defaultAgent: string): void {
  command
    .option("-a, --agent <agent>", "Session agent: claude, zai, codex, agy, opencode, aider, kimi", defaultAgent)
    .option("-m, --model <model>", "Model to use (supports aliases)")
    .option("--resume <id>", "Resume a recorded session id")
    .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
    .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
    .option("--cwd <path>", "Working directory")
    .option("--timeout <seconds>", "Whole-session cap: >0 to 86400 seconds; fractions rounded up to milliseconds (default: none)")
    .option("--turn-timeout <seconds>", "Per-turn cap (claude/zai/codex); first expiry interrupts, second expiry on the same turn ends the session (default: none)")
    .option("--permission-timeout <seconds>", "How long a permission request waits before codemux answers deny", "300")
    .option("--shutdown-grace <seconds>", "How long the harness gets to answer the end before SIGTERM, and again to exit before the kill", "10")
    .option("--no-author-prefix", "Do not prefix harness-bound text with [author]")
    .option("--tools <selection>", "Tool selection (refused for sessions in this release)")
    .option("--enable-playwright-mcp", "Enable the local Playwright MCP (claude/zai; requires --sandbox and --auto low)")
    .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
    .option(
      "--hermetic",
      "Hermetic session mode; accepted only together with --experiment-project-settings (claude/zai), refused alone"
    )
    .option(
      "--experiment-project-settings",
      "Run the session under the repository's Claude settings in a private per-session config directory (claude/zai; requires --hermetic and scode)"
    )
    .option(
      "--final",
      "With --experiment-project-settings: remove the session's private config directory when this command ends"
    )
    .option(
      "--permission-policy <policy>",
      "Permission policy: 'deny' answers every permission request with an immediate deny; 'default' (the default) leaves requests to the caller (claude/zai)"
    )
    .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
    .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
    .option("--sandbox-trust <level>", "scode trust override: trusted or standard (untrusted refused for sandboxed sessions)")
    .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
    .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
    .option(
      "--sandbox-block <path>",
      "Pass an extra scode --block for this session's children (repeatable); absolute paths only",
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option(
      "--print-sandbox",
      "Print the scode argv the session's long-lived child would exec, one argument per line (controls escaped, a newline prints as \\n), and exit 0 without starting a session; requires --sandbox"
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
      "--quota-ceiling <percent>",
      "Refuse the session when a bounding usage window is below this percent remaining; overrides the config quota ceiling for this invocation"
    )
    .option("--no-quota-gate", "Skip the pre-launch usagemux quota check for this invocation");
}
