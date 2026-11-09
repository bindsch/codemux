/**
 * Lane W2's closed session limitations: qwen, agy, and openhands cells
 * that are either pinned harness facts (the binary has no channel) or
 * the W3 registration pattern — the owned implementation is in-tree and
 * tested, and only the SHARED activation (the request threading, the
 * preview arm's agent list, the SESSION_AGENTS registration) rides a
 * patch the wave owner applies. "Not wired" alone is never a limitation;
 * every row here names the in-tree carrier and the patch that lights it,
 * or the installed file, version, and line it was read from.
 */
import { limitation, type FeatureState } from "./features.js";

// -- qwen -----------------------------------------------------------------

export const QWEN_SESSION_INTERRUPT: FeatureState = limitation(
  "A qwen session turn is one one-shot `qwen --output-format json` process that runs to completion or dies: the 0.24.0 option table defines no interrupt or abort command, and the message-array wire carries no inbound channel, so a codemux stop ends the turn child rather than interrupting a turn in flight.",
  "2026-11-09: installed @qwen-code/qwen-code 0.24.0 /opt/homebrew/lib/node_modules/@qwen-code/qwen-code chunks/chunk-BSIOCNDK.js option table (no interrupt or abort flag; the session flags are --session-id/--resume/--continue) and the one-shot json print chunk-ZJBYZN5D.js byte 3169; src/session/qwen-session.ts capabilities interrupt:false",
  "--turn-timeout requires an agent whose sessions support interrupt",
  "tests/qwen-session.test.ts",
);

export const QWEN_SESSION_TOOLS: FeatureState = limitation(
  "The carrier is in-tree: buildQwenSessionCommand emits the run path's --exclude-tools on every turn (the argv exclusion merges unconditionally, so a resumed turn keeps the set the first turn promised; tests/qwen-session.test.ts). The shared request threading — cli-request.ts's runLike carries tools for the eight integrated agents only — and the SESSION_AGENTS tools flag ride scratch/fix/w2-session-tools.patch; --tools stays refused until it lands.",
  "2026-11-09: src/session/qwen-session.ts tools carrier and QWEN_DRIVER_PROFILE threading (src/session/qwen-driver.ts); src/session/cli-request.ts runLike tools list; src/session/cli-agents.ts qwen tools=false",
  "--tools is not implemented for 'qwen' sessions in this release",
  "tests/qwen-session.test.ts",
);

export const QWEN_SESSION_PERMISSION_POLICY: FeatureState = limitation(
  "A qwen session fixes its approval contract at spawn (--approval-mode bounds the whole turn) and the headless json wire only reports permission_denials in the result message — it never issues an askable permission request — so there is no separate deny channel for a session to bind.",
  "2026-11-09: installed @qwen-code/qwen-code 0.24.0 chunk-6XRR4RYH.js byte 29697 buildResultMessage (permission_denials on the result message; the can_use_tool control_request frame lives on the interactive stream-json wire); src/session/cli-agents.ts qwen approvals='none' note",
  "--permission-policy deny is unavailable for 'qwen'",
  "tests/qwen-session.test.ts",
);

export const QWEN_SESSION_PRINT_SANDBOX: FeatureState = limitation(
  "The shared per-turn preview exists (cli-spawn-prep.ts builds the representative first turn through TURN_AGENT_PROFILES and prints its scode argv) and qwen's turn command builder is registered in it; the preview arm's agent list — pi, gemini, copilot today — is shared across the wave and qwen joins it in scratch/fix/w2-session-tools.patch.",
  "2026-11-09: src/session/cli-spawn-prep.ts print-sandbox branch (the pi/gemini/copilot arm) and its TURN_AGENT_PROFILES.qwen lookup; src/session/qwen-driver.ts buildTurnCommand",
  "--print-sandbox is not available for this agent: its session children spawn per turn, so there is no one scode argv to print",
  "tests/qwen-session.test.ts",
);

// -- agy ------------------------------------------------------------------

export const AGY_SESSION_INTERRUPT: FeatureState = limitation(
  "An agy session's NDJSON input loop accepts user events only: the binary names exactly one stream-input event ('stream input \"user\" message is missing the \"message\" field') and answers every other event name by ignoring it, so no interrupt or steer channel exists into a turn in flight.",
  "2026-11-09: installed agy 1.5.3 ~/.local/bin/agy (Mach-O arm64) strings at offsets 61105691 ('ignoring unknown stream input message event %q' beside the user-event grammar) and 60947817 ('stream input message is missing the \"event\" field'); src/session/agy-session.ts capabilities interrupt:false",
  "--turn-timeout requires an agent whose sessions support interrupt",
  "tests/session-cli-agy.test.ts",
);

export const AGY_SESSION_TOOLS: FeatureState = limitation(
  "The carrier is in-tree on both sides of the session: the run path's tools-none mode writes the deny-every-action settings file into the private home (src/adapters/agy.ts mode 'tools'), and the session's own deny-policy helper writes the same file through --settings (src/session/agy-permission-policy.ts). Threading the selection into buildAgySessionCommand and the SESSION_AGENTS tools flag rides scratch/fix/w2-session-tools.patch; --tools stays refused until it lands.",
  "2026-11-09: src/adapters/agy.ts prepareRun mode 'tools' settings write (tests/agy-isolation.test.ts) and src/session/agy-session.ts agySessionDenySettings carrier; src/session/cli-agents.ts agy tools=false",
  "--tools is not implemented for 'agy' sessions in this release",
  "tests/session-agy.test.ts",
);

export const AGY_SESSION_PLAYWRIGHT: FeatureState = limitation(
  "The carrier is in-tree and owned: the same planted mcp_config.json the run path writes (src/agy-playwright-mcp.ts, tested in tests/agy-playwright-mcp.test.ts) serves a session turn's probe home, so the mechanism a session needs is implemented and tested; threading it into the session turn spawn (the turn-input playwright field and the per-turn home planting) rides scratch/fix/w2-playwright.patch with the run activation.",
  "2026-11-09: src/agy-playwright-mcp.ts plantAgyPlaywrightMcpConfig (tests/agy-playwright-mcp.test.ts); src/session/cli-request.ts runLike enablePlaywrightMcp list and src/mcp.ts PLAYWRIGHT_MCP_AGENTS omit agy",
  "--enable-playwright-mcp is supported only by",
  "tests/agy-playwright-mcp.test.ts",
);

// -- openhands ------------------------------------------------------------

const OPENHANDS_CLI = "~/.local/share/uv/tools/openhands/lib/python3.12/site-packages/openhands_cli";

export const OPENHANDS_SESSION_INTERRUPT: FeatureState = limitation(
  "An openhands session turn is one headless process that runs `conversation.run()` to completion: the only pause path (`conversation.pause()`) is reached from TUI controllers and the confirmation DEFER answer, which headless mode never shows, and a signal ends the process through the KeyboardInterrupt branch, which prints \"Goodbye\" without the Conversation ID line the session adopts and resumes. No channel interrupts a turn and leaves a resumable conversation behind.",
  `2026-11-09: openhands 1.16.0 (openhands-1.16.0.dist-info/METADATA, ${OPENHANDS_CLI}): tui/core/conversation_runner.py:168-171 (headless: \"Agent is working\" then self.conversation.run()); tui/core/conversation_manager.py:256 and :304 pause_conversation (TUI only); tui/textual_app.py:726 \"if headless or always_approve:\" selects NeverConfirm, so no DEFER answer exists; entrypoint.py:228-239 prints \"Conversation ID: {conversation_id.hex}\" only on a normal exit and entrypoint.py:240-241 \"except KeyboardInterrupt:\" prints \"Goodbye!\" alone; src/session/openhands-session.ts capabilities interrupt:false`,
  "--turn-timeout requires an agent whose sessions support interrupt",
  "tests/session-openhands-cells.test.ts",
);

export const OPENHANDS_SESSION_TOOLS: FeatureState = limitation(
  "Same binary finding as the run cell (openhandsTools): the 1.16.0 parser carries no tool flag, and --headless selects NeverConfirm, so no tool selection exists for a first turn to set or for a resumed turn to restore. A PreToolUse hook can block an action, but the model still sees every tool, so it is not a tool removal.",
  `2026-11-09: openhands 1.16.0 ${OPENHANDS_CLI}/argparsers/main_parser.py (no tool option) and tui/textual_app.py:726 NeverConfirm selection; src/parity/reasons-run-w2.ts openhandsTools; src/session/cli-agents.ts openhands tools=false`,
  "--tools none is refused for sessions",
  "tests/session-openhands-cells.test.ts",
);

export const OPENHANDS_SESSION_PLAYWRIGHT: FeatureState = limitation(
  "Same binary finding as the run cell (openhandsPlaywright): openhands 1.16.0 has no argv MCP flag and resolves MCP servers only from `<persistence dir>/mcp.json`. A plain session shares the operator's persistence dir, where a planted server would outlive the session, and the run path's activation of its hermetic carrier (the PLAYWRIGHT_MCP_AGENTS entry) is not in this tree, so the session refuses with the run path's message.",
  `2026-11-09: openhands 1.16.0 ${OPENHANDS_CLI}/locations.py MCP_CONFIG_FILE='mcp.json' under get_persistence_dir(), and argparsers/main_parser.py (no MCP option); src/parity/reasons-run-w2.ts openhandsPlaywright; src/mcp.ts PLAYWRIGHT_MCP_AGENTS omits openhands`,
  "--enable-playwright-mcp is supported only by",
  "tests/session-openhands-cells.test.ts",
);

export const OPENHANDS_SESSION_USAGE: FeatureState = limitation(
  "No openhands event carries token usage: the metrics live in conversation state, not the json event stream, so a session turn reports the same honest all-null block the run envelope pins — there is no usage fact to stream or report.",
  "2026-11-09: openhands 1.16.0 json event wire (openhands_cli/utils.py json_callback prints event models; TokenUsage stays in conversation state) — the run cell's identical finding (src/parity/reasons-run-w2.ts openhandsUsage); src/session/openhands-session.ts emptyUsage turn parse",
  "usage: omitted (OpenHands reports no tokens on the local wire)",
  "tests/openhands-session.test.ts",
);

export const QWEN_SESSION_PROJECT: FeatureState = limitation(
  "Same finding as the run cell (qwenProject): safe mode empties every settings-sourced permission rule, so no project-settings passthrough exists for a session to observe either.",
  "2026-11-09: src/parity/reasons-run-w2.ts qwenProject (chunk-HWKWZSZY.js offset 2085997 mergedDeny drops settings rules under safe mode); the session CLI's shared gate wording",
    "--experiment-project-settings applies to the",
  "tests/qwen-session.test.ts",
);

export const AGY_SESSION_PROJECT: FeatureState = limitation(
  "Same finding as the run cell (agyProject): agy's project channels are instruction files, not a permission-rule setting source, so no project-settings passthrough exists for a session to observe either.",
  "2026-11-09: src/parity/reasons-run-w2.ts agyProject; the session CLI's shared gate wording",
    "--experiment-project-settings applies to the",
  "tests/session-agy.test.ts",
);
