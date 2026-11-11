// The session-capable agent table (design §4.1, §4.5): which agents
// have a session driver, the floor each runs at, and the id shape
// --resume accepts. src/session/cli.ts owns the command;
// session/cli-request.ts refuses an agent outside this table.
import { sessionIdPattern } from "./id-pattern.js";
import { scopedResumePattern } from "./scoped-id.js";
import type { AgentId } from "../types.js";
import { CLINE_SESSION_FLOOR, CLINE_SESSION_ID_PATTERN } from "./cline-session.js";
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
import {
  CURSOR_SESSION_FLOOR,
  CURSOR_SESSION_ID_PATTERN,
} from "./cursor-session.js";
import {
  DROID_SESSION_FLOOR,
  DROID_SESSION_ID_PATTERN,
} from "./droid-session.js";
import {
  PI_SESSION_FLOOR,
  PI_SESSION_ID_PATTERN,
} from "./pi-session.js";
import {
  QWEN_SESSION_FLOOR,
  QWEN_SESSION_ID_PATTERN,
} from "./qwen-session.js";
import {
  GEMINI_SESSION_FLOOR,
  GEMINI_SESSION_ID_PATTERN,
} from "./gemini-session.js";
import {
  COPILOT_SESSION_FLOOR,
  COPILOT_SESSION_ID_PATTERN,
} from "./copilot-session.js";
import {
  GOOSE_SESSION_FLOOR,
  GOOSE_SESSION_ID_PATTERN,
} from "./goose-session.js";
import { openhandsSessionFloor, OPENHANDS_CONVERSATION_ID_PATTERN } from "./openhands-session.js";

const UUID_PATTERN = sessionIdPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** Agents whose session drivers have landed (design §7). Each later step
 * widens this set; an agent outside it gets a clear usage refusal, never
 * a silent fallback to some other harness. */
export interface SessionAgentSupport {
  floor: string;
  interrupt: boolean;
  /** The id shape --resume accepts for this agent (§4.5). */
  resumePattern: RegExp;
  resumeLabel: string;
  /** Whether the session has a verified native tool-selection carrier. */
  tools: boolean;
  /** Whether the session wire exposes requests the caller can answer. */
  approvals: "ask" | "none";
  /** Harness evidence for a missing ask channel. */
  approvalsNote: string | null;
  /** Native deny rules require an isolated config when there is no ask channel. */
  denyRules?: "hermetic" | "native";
  /** Whether a verified hermetic SESSION mode exists: a session-lifetime
   * private home that carries the harness's own state across turns and
   * `--resume` (docs/sessions.md, "Hermetic sessions"). The run path's
   * per-run home is not sufficient; this field, not the adapter's run
   * capability, is what the session and its canary judge. */
  hermetic: boolean;
}

/** The agents with a session driver (design §4.1). Exported for the
 * `sessions` capability label `codemux list` and `doctor` print and the
 * documentation test that keeps docs/sessions.md's agent list equal to
 * this set. */
export const SESSION_AGENTS: Readonly<Partial<Record<AgentId, SessionAgentSupport>>> = {
  cline: {
    floor: CLINE_SESSION_FLOOR, interrupt: true, resumePattern: scopedResumePattern("cline", CLINE_SESSION_ID_PATTERN),
    resumeLabel: "Cline timestamp_nanoid_cli identity", tools: true, hermetic: true,
    approvals: "none", denyRules: "native",
    approvalsNote: "no permission channel: ACP permission requests are rejected (Cline 3.0.74); default medium/high enables native automatic approval, while --permission-policy deny disables it",
  },
  openhands: {
    // OpenHands 1.16.0 entrypoint.py: "Conversation ID:" and --resume.
    // Caller-owned roots use the in-tree headless conversation driver.
    floor: openhandsSessionFloor(), interrupt: false,
    resumePattern: OPENHANDS_CONVERSATION_ID_PATTERN,
    resumeLabel: "OpenHands conversation UUID", tools: false,
    // Headless confirms nothing; deny plants a PreToolUse hook in the
    // hermetic home (src/session/openhands-home.ts).
    approvals: "none", denyRules: "hermetic",
    approvalsNote: "no permission channel: headless mode uses NeverConfirm (OpenHands 1.16.0 textual_app.py); the native deny rule is a PreToolUse hook in the hermetic session home",
    // A session-lifetime private HOME under ~/.openhands/.codemux-hermetic.
    hermetic: true,
  },
  claude: {
    approvals: "ask",
    approvalsNote: null,
    floor: CLAUDE_SESSION_FLOOR,
    interrupt: true,
    resumePattern: UUID_PATTERN,
    resumeLabel: "UUID",
    tools: true,
    hermetic: true,
  },
  codex: {
    approvals: "ask",
    approvalsNote: null,
    floor: CODEX_SESSION_FLOOR,
    interrupt: true,
    resumePattern: CODEX_THREAD_ID_PATTERN,
    resumeLabel: "codex thread id",
    // Native config is reapplied on start/resume; writable levels use a model catalog.
    tools: true,
    hermetic: true,
  },
  zai: {
    approvals: "ask",
    approvalsNote: null,
    floor: ZAI_SESSION_FLOOR,
    interrupt: true,
    // The claude-family id shape: zai pins the same --session-id UUIDs
    // (same binary); a claude-created id matches the pattern but the
    // registry's agent match refuses it (§4.8).
    resumePattern: UUID_PATTERN,
    resumeLabel: "UUID",
    // Reapply the native --tools choice on every fresh or resumed process.
    tools: true,
    hermetic: true,
  },
  agy: {
    // agy 1.5.3, bin/agy: "Print mode: soft-denying tool confirmation %q at step %d";
    // "--dangerously-skip-permissions set, auto-approving all tool permissions".
    approvals: "none",
    approvalsNote: "no permission channel: print mode soft-denies confirmations it cannot show; " +
      "--dangerously-skip-permissions approves tools unless denied by rules; " +
      "stream-json carries no request (agy 1.5.3)",
    denyRules: "hermetic",
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
    hermetic: true,
  },
  opencode: {
    // opencode 1.19.5, bin/opencode run handler: permission.asked replies "once" with
    // --auto, otherwise "reject" and "auto-rejecting"; neither reaches JSON output.
    approvals: "none",
    approvalsNote: "no permission channel: opencode run answers permission.asked itself, " +
      "once under --auto and reject otherwise; the JSON stream carries no request (1.19.5)",
    denyRules: "hermetic",
    floor: OPENCODE_SESSION_FLOOR,
    // Interruption stops the current child. The next turn resumes its
    // native session ID after that child settles.
    interrupt: true,
    resumePattern: OPENCODE_SESSION_ID_PATTERN,
    resumeLabel: "opencode session id",
    tools: true,
    hermetic: true,
  },
  aider: {
    // aider 0.86.2, aider/io.py:807-870 confirm_ask: "(Y)es/(N)o";
    // self.yes True selects "y", False selects "n". No machine request frame.
    approvals: "none",
    approvalsNote: "no permission channel: confirmations are stdin yes/no prompts; " +
      "codemux answers no at read-only and low and passes --yes-always at medium and high " +
      "(aider 0.86.2)",
    floor: AIDER_SESSION_FLOOR,
    // Interruption stops the child and rolls back only its current history delta.
    interrupt: true,
    resumePattern: AIDER_SESSION_ID_PATTERN,
    resumeLabel: "UUID",
    tools: true,
    // The session-lifetime form of the run path's verified hermetic mode
    // (src/aider-hermetic.ts): a private home under
    // `~/.aider/.codemux-hermetic/session-<id>`, opened settled (the id
    // is codemux-minted), carrying the history file flat inside it and
    // the HOME redirect on every turn's argv (cli-drivers.ts,
    // aider-session.ts) — across turns and --resume, removed by --final
    // or the dead-owner sweep.
    hermetic: true,
  },
  kimi: {
    // kimi 2.5.2, bin/kimi runV2Print: nonInteractive: true, setMode("auto");
    // user-configured-deny precedes auto-mode-approve in AgentPermissionPolicyService.
    approvals: "none",
    approvalsNote: "no permission channel: headless kimi (--prompt) forces permission mode auto " +
      "and approves every tool except configured deny rules; nothing asks (2.5.2)",
    denyRules: "hermetic",
    floor: KIMI_SESSION_FLOOR,
    // The supervisor stops one turn child and resumes the native session.
    interrupt: true,
    resumePattern: KIMI_SESSION_ID_PATTERN,
    resumeLabel: "kimi session id",
    tools: true,
    hermetic: true,
  },
  cursor: {
    approvals: "none",
    approvalsNote: "no permission channel: the headless loop answers interaction queries " +
      "itself (ask-question gets \"Questions skipped in headless mode\", switch-mode " +
      "\"Switch mode requires approval\", 1706.index.js offset 766086); the autonomy " +
      "boundary is set at spawn via --mode/--auto-review/--force (2026.11.05)",
    floor: CURSOR_SESSION_FLOOR,
    // One --print process per turn, prompt on stdin: no verified channel
    // reaches into it (§3.4).
    interrupt: false,
    resumePattern: CURSOR_SESSION_ID_PATTERN,
    resumeLabel: "UUIDv4",
    // The run path's --allowed-tools allowlist reapplies on every turn
    // (src/session/cursor-session.ts), so a resumed session keeps the
    // tool set the first turn promised.
    tools: true,
    // The run path has no verified hermetic mode for cursor (no state
    // relocation exists to build a session-lifetime home on), so the
    // session refuses --hermetic on this field and runs plain.
    hermetic: false,
  },
  droid: {
    approvals: "none",
    approvalsNote: "no permission channel: autonomy is fixed at spawn via --auto and the " +
      "one json result object carries no request (droid 0.221.0)",
    floor: DROID_SESSION_FLOOR,
    // One exec process per turn, prompt on stdin (§3.4).
    interrupt: false,
    resumePattern: DROID_SESSION_ID_PATTERN,
    resumeLabel: "droid session id",
    // The run path's --only-tools carrier reapplies on every turn
    // (src/session/droid-session.ts), so a resumed session keeps the
    // tool set the first turn promised.
    tools: true,
    // The run path's HOME redirect (src/droid-hermetic.ts), held for the
    // session's lifetime under the registry-keyed private home.
    hermetic: true,
  },
  pi: {
    approvals: "none",
    approvalsNote: "no permission channel: headless runs pass --no-approve and the json " +
      "wire's event vocabulary (message_start/update/end, agent_start/end/settled) has " +
      "no permission request frame (0.85.1)",
    floor: PI_SESSION_FLOOR,
    // The native RPC abort command preserves the session after interruption.
    interrupt: true,
    resumePattern: PI_SESSION_ID_PATTERN,
    resumeLabel: "pi session id",
    tools: true,
    // The run path's PI_CODING_AGENT_DIR relocation (src/pi-provider.ts),
    // held for the session's lifetime.
    hermetic: true,
  },
  qwen: {
    approvals: "none",
    approvalsNote: "no permission channel: the headless json wire prints the message array " +
      "once at exit and only reports permission_denials (buildResultMessage, " +
      "chunk-6XRR4RYH.js byte 29697); the can_use_tool control_request frame lives on the " +
      "interactive stream-json wire, and --approval-mode bounds the turn at spawn (0.24.0)",
    floor: QWEN_SESSION_FLOOR,
    // One-shot process per turn; the prompt is the whole stdin stream
    // (§3.4).
    interrupt: false,
    resumePattern: QWEN_SESSION_ID_PATTERN,
    resumeLabel: "UUID",
    tools: false,
    // Safe mode is always on and is the whole hermetic claim
    // (adapters/qwen.ts): no session-keyed state exists to relocate, so
    // the session runs hermetic with no private home — the opencode
    // rule, an honest null private_home.
    hermetic: true,
  },
  gemini: {
    approvals: "none",
    approvalsNote: "no permission channel: ACP confirmations are denied (Gemini 0.60.0); native policy prevents automatic approvals in hermetic deny sessions",
    denyRules: "hermetic",
    floor: GEMINI_SESSION_FLOOR,
    // Gemini 0.60.0 ACP session/cancel interrupts the active native prompt.
    interrupt: true,
    resumePattern: GEMINI_SESSION_ID_PATTERN,
    resumeLabel: "UUID",
    tools: true,
    // The run path's GEMINI_CLI_HOME redirect (src/gemini-hermetic.ts),
    // held for the session's lifetime.
    hermetic: true,
  },
  copilot: {
    approvals: "none",
    approvalsNote: "no permission channel: native permission requests are denied by policy (Copilot 1.0.85); caller approval responses are not exposed",
    denyRules: "native",
    floor: COPILOT_SESSION_FLOOR,
    interrupt: true,
    resumePattern: COPILOT_SESSION_ID_PATTERN,
    resumeLabel: "UUID",
    tools: true,
    // The run path's COPILOT_HOME redirect (src/copilot-hermetic.ts),
    // held for the session's lifetime.
    hermetic: true,
  },
  goose: {
    approvals: "none",
    approvalsNote: "no permission channel: GOOSE_MODE bounds the whole turn at spawn and " +
      "the run JSON output carries no request frame (1.50.1)",
    floor: GOOSE_SESSION_FLOOR,
    // One `goose run` process per turn, prompt on argv: no verified
    // channel reaches into it (§3.4).
    interrupt: false,
    // Goose mints its date_time id; the driver adopts it from the first
    // turn's output object (the opencode model).
    resumePattern: scopedResumePattern("goose", GOOSE_SESSION_ID_PATTERN),
    resumeLabel: "goose session id",
    // The run path's --no-profile carrier reapplies on every turn
    // (src/session/goose-session.ts), so a resumed session keeps the
    // tool set the first turn promised.
    tools: true,
    // The run path's GOOSE_PATH_ROOT/XDG redirect (src/goose-hermetic.ts),
    // held for the session's lifetime; requires the provider override
    // (nothing can ride into the empty home).
    hermetic: true,
  },
};
