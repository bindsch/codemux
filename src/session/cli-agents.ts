// The session-capable agent table (design §4.1, §4.5): which agents
// have a session driver, the floor each runs at, and the id shape
// --resume accepts. src/session/cli.ts owns the command;
// session/cli-request.ts refuses an agent outside this table.
import {
  CODEX_SESSION_FLOOR,
  CODEX_THREAD_ID_PATTERN,
} from "./codex-session.js";
import { CLAUDE_SESSION_FLOOR } from "./claude-session.js";
import { ZAI_SESSION_FLOOR } from "./zai-session.js";
import {
  AGY_CONVERSATION_ID_PATTERN,
  AGY_SESSION_FLOOR,
} from "./agy-session.js";
import {
  AIDER_SESSION_FLOOR,
  AIDER_SESSION_ID_PATTERN,
} from "./aider-session.js";
import {
  KIMI_SESSION_FLOOR,
  KIMI_SESSION_ID_PATTERN,
} from "./kimi-session.js";
import {
  OPENCODE_SESSION_FLOOR,
  OPENCODE_SESSION_ID_PATTERN,
} from "./opencode-session.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agents whose session drivers have landed (design §7). Each later step
 * widens this set; an agent outside it gets a clear usage refusal, never
 * a silent fallback to some other harness. */
export interface SessionAgentSupport {
  floor: string;
  interrupt: boolean;
  /** The id shape --resume accepts for this agent (§4.5). */
  resumePattern: RegExp;
  resumeLabel: string;
  /** Whether --tools is accepted beyond the shared refusal of "none". */
  tools: boolean;
}

/** The agents with a session driver (design §4.1). Exported for the
 * `sessions` capability label `codemux list` and `doctor` print and the
 * documentation test that keeps docs/sessions.md's agent list equal to
 * this set. */
export const SESSION_AGENTS: Readonly<Record<string, SessionAgentSupport>> = {
  claude: {
    floor: CLAUDE_SESSION_FLOOR,
    interrupt: true,
    resumePattern: UUID_PATTERN,
    resumeLabel: "UUID",
    tools: false,
  },
  codex: {
    floor: CODEX_SESSION_FLOOR,
    interrupt: true,
    resumePattern: CODEX_THREAD_ID_PATTERN,
    resumeLabel: "codex thread id",
    // --tools is refused outright: `none` has no verified carrier on any
    // harness (the shared refusal below), and `default` names no
    // selection a session needs to carry — accepting it silently would
    // be a flag that does nothing (design §4.7, amended).
    tools: false,
  },
  zai: {
    floor: ZAI_SESSION_FLOOR,
    interrupt: true,
    // The claude-family id shape: zai pins the same --session-id UUIDs
    // (same binary); a claude-created id matches the pattern but the
    // registry's agent match refuses it (§4.8).
    resumePattern: UUID_PATTERN,
    resumeLabel: "UUID",
    // The same binary, so the same --tools refusal as claude: no
    // verified carrier restores a tool selection for a resumed
    // session (§4.5).
    tools: false,
  },
  agy: {
    floor: AGY_SESSION_FLOOR,
    // No verified interrupt channel exists on agy (§3.4): --turn-timeout
    // is refused rather than pretending a turn can be ended mid-flight.
    interrupt: false,
    // No live conversation id was ever recorded (the fixture's frame
    // carries an empty one), so the pattern accepts the registry's own
    // id class — see agy-session.ts.
    resumePattern: AGY_CONVERSATION_ID_PATTERN,
    resumeLabel: "agy conversation id",
    // No tool-removal flag exists on agy, and none is needed: there is
    // no session-carried tool selection to restore.
    tools: false,
  },
  opencode: {
    floor: OPENCODE_SESSION_FLOOR,
    // A turn in flight is a process whose stdin already sits at EOF (the
    // prompt is the whole stdin stream): no verified channel reaches into
    // it, so --turn-timeout is refused like agy's (§3.4).
    interrupt: false,
    resumePattern: OPENCODE_SESSION_ID_PATTERN,
    resumeLabel: "opencode session id",
    tools: false,
  },
  aider: {
    floor: AIDER_SESSION_FLOOR,
    // Same shape as opencode's: one process per turn, stdin at EOF the
    // moment the canned negatives land (§3.4).
    interrupt: false,
    resumePattern: AIDER_SESSION_ID_PATTERN,
    resumeLabel: "UUID",
    tools: false,
  },
  kimi: {
    floor: KIMI_SESSION_FLOOR,
    // Same shape as opencode's and aider's: one process per turn whose
    // prompt rides argv, and kimi's own signal handlers self-exit
    // (130/129/143) without answering — no verified channel interrupts a
    // turn mid-flight (§3.4).
    interrupt: false,
    resumePattern: KIMI_SESSION_ID_PATTERN,
    resumeLabel: "kimi session id",
    tools: false,
  },
};
