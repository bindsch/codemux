import { featureFloor } from "../harness-contracts.js";
/**
 * The claude-family session wiring (design §4.7): the spawn command, the
 * stream-json parsers under the three tiers, and the control-response
 * writer that enforces the ceiling. Pure functions and one small parser
 * class — all live state lives in the launcher-owned driver context.
 *
 * Wire facts here are pinned by the step-0 fixtures
 * (tests/fixtures/live/): the `--verbose` requirement, the
 * `--permission-prompt-tool stdio` carrier, the per-turn `system/init`,
 * the can_use_tool round-trip shapes, the interrupt round-trip, and the
 * `user`-frame replay echo. The fake harness the e2e tests drive is
 * generated from those fixtures, so this parser cannot drift from the
 * recorded reality.
 */

/** The session-only version floor (design §4.3): 2.1.280, the audited
 * `--permission-prompt-tool stdio` build. The run contract's 2.1.220
 * admits pre-hardening builds where the bypass flag is honored and the
 * resume ladder's reasoning would not hold. The value lives in
 * FEATURE_FLOORS (harness-contracts.ts), the one table the session
 * drivers, the experiment path, and doctor read. */
export const CLAUDE_SESSION_FLOOR = featureFloor("claude", "sessions");

export {
  claudeSessionAutonomyFlags,
  buildClaudeSessionCommand,
  claudeSessionCapabilities,
  buildHarnessUserMessage,
  buildInterruptRequest,
  buildControlResponse,
  buildControlErrorResponse,
  DEFAULT_DENIAL_MESSAGE,
} from "./claude-session/builders.js";
export type { ClaudeSessionCommand } from "./claude-session/builders.js";
export { ClaudeStreamParser } from "./claude-session/parser.js";
export type { ClaudeParse, ClaudeParseContext } from "./claude-session/parser.js";
