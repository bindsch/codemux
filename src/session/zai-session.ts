/**
 * The zai session wiring (design §4.7, plan step 7): the Z.AI mode of
 * the claude-family path. Zai is not a second harness — it is the same
 * `claude` binary (the adapter's binaryName) pointed at the Z.AI
 * endpoint through `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`, with
 * the API key checked before launch (`ZAI_API_KEY` or `~/.zai`, the
 * adapter's `beforeLaunch`). The driver, parser, ceiling, and spawn
 * shape are the claude-family ones verbatim (src/session/driver.ts,
 * src/session/claude-session.ts); what lives here is the identity the
 * registry and the caller see.
 *
 * The store is shared: a zai session's transcripts live under the same
 * `~/.claude` (or `CLAUDE_CONFIG_DIR`) a claude session uses — `~/.zai`
 * holds only the key file. Round 17's replay hazard (a claude-home
 * session resumed through zai replays the transcript to the Z.AI
 * endpoint) is closed by the registry's agent match at resume (§4.8),
 * never by splitting the home.
 */

import type { SessionCapabilities } from "./protocol.js";
import {
  CLAUDE_SESSION_FLOOR,
  buildClaudeSessionCommand,
  claudeSessionCapabilities,
  type ClaudeSessionCommand,
} from "./claude-session.js";

/** The session-only version floor (§4.3): the claude floor verbatim,
 * because zai sessions run the same installed binary the claude
 * contract probes — one floor, one gate. */
export const ZAI_SESSION_FLOOR = CLAUDE_SESSION_FLOOR;

/** Capability flags for zai sessions (§3.4's "same" column): the
 * claude-family matrix unchanged — a mid-turn `user` line is rejected
 * `busy`, the control round-trip carries interrupts and permissions,
 * deltas stream, file changes derive from tool calls. The endpoint
 * change touches transport, not the wire contract. */
export function zaiSessionCapabilities(): SessionCapabilities {
  return claudeSessionCapabilities();
}

/** The spawn command: the claude-family argv unchanged. The Z.AI
 * identity rides the environment the adapter builds (its `getEnv`),
 * not the command line. */
export function buildZaiSessionCommand(
  command: Omit<ClaudeSessionCommand, "agent">
): { argv: string[]; sessionId: string } {
  return buildClaudeSessionCommand({ ...command, agent: "zai" });
}
