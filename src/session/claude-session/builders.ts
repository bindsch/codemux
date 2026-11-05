/**
 * The claude-family session builders: the spawn argv, the session
 * autonomy flag mapping, the capability record, and the control-request
 * and control-response wire lines. src/session/claude-session.ts owns
 * the module's public surface and re-exports these.
 */

import { randomUUID } from "node:crypto";
import { claudeAutonomyFlags, claudeNativeAutonomyFlags, grantRule } from "../../claude-autonomy.js";
import { PROJECT_SETTING_SOURCES } from "../../claude-project-settings.js";
import { buildPlaywrightSandboxMcp } from "../../mcp.js";
import type { ExecutableCheck } from "../../executable-security.js";
import type { AutonomyLevel, ReasoningEffort } from "../../types.js";
import type { SessionCapabilities } from "../protocol.js";

export interface ClaudeSessionCommand {
  agent: "claude" | "zai";
  resumeId?: string;
  model?: string;
  autonomy: AutonomyLevel;
  effort?: ReasoningEffort;
  cwd?: string;
  /** Whether scode wraps the session; drives the Playwright MCP args. */
  sandboxed?: boolean;
  /** Enable the local Playwright MCP inside the sandbox (run parity). */
  enablePlaywrightMcp?: boolean;
  /** The inline `--settings` payload for a session whose model is not a
   * binary catalog id: the modelPicker row mapping it onto a tier the
   * catalog knows (claude-family.ts). Set for a provider override's
   * model and for a zai provider-format id alike — the same predicate
   * the run paths use; undefined — no flag — for catalog aliases and
   * default-model launches. */
  providerSettings?: string;
  /** The `--experiment-project-settings` isolation: the project and
   * local setting sources replace the user source, plus
   * `--disable-slash-commands` (all skills off, project ones included —
   * the run path's rule). No `--safe-mode` in this mode; a session never
   * passes it in any mode. The CLI pairs this with a private
   * CLAUDE_CONFIG_DIR keyed by the session id. */
  projectSettings?: boolean;
  /** The session id to pin on a fresh launch, when the caller has
   * already minted it — the CLI does, so the private config directory,
   * the registry record, and `--session-id` all name one id before
   * anything spawns. A resume ignores this in favor of `resumeId`. */
  sessionId?: string;
}

/** The session high mapping: `--permission-mode default` plus the grant
 * list — never `--dangerously-skip-permissions`. High's reach is set by
 * codemux's grants, not a harness side effect, so the resume ladder's
 * low→high move narrows reach on every build the floor admits. Medium
 * keeps only the scoped Edit grant; Bash stays under the ceiling callback.
 * Low and read-only reuse the run mapping without its web grants. The
 * ceiling answers each tool call, denies WebSearch and
 * WebFetch at every level but low, and an allow rule would bypass that
 * answer. */
export function claudeSessionAutonomyFlags(
  level: AutonomyLevel,
  launchDir: string
): string[] {
  if (level === "high") {
    return [
      "--permission-mode",
      "default",
      "--allowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
    ];
  }
  if (level === "medium") {
    return [...claudeNativeAutonomyFlags(level), "--allowedTools", grantRule(launchDir)];
  }
  return claudeAutonomyFlags(level, launchDir, { web: "callback" });
}

/**
 * The spawn command (§4.7). Flag order is load-bearing: the resume id
 * comes first and the autonomy flags after it, unconditionally, on every
 * launch — fresh or resumed — with the live invocation's `--auto` as
 * their only input. A session created at high and resumed at read-only
 * emits exactly read-only's flags. Notably WITHOUT
 * `--no-session-persistence` (that flag is `run`'s statelessness, wrong
 * here) and with `--replay-user-messages` so the transcript echoes what
 * codemux submits. Never `--safe-mode`, in any mode: the plain session
 * keeps its state in the operator's config directory, and the
 * project-settings mode replaces the flag with its own setting sources
 * (`--safe-mode` would ignore the project's rules — the thing that mode
 * exists to observe).
 */
/** What buildClaudeSessionCommand leaves for the spawn site: the argv and
 * the session id, plus this build's trust check of the Playwright MCP
 * binary the argv may embed (review round 110). That path sits inside the
 * `--mcp-config` JSON argument, so the command re-check never sees it;
 * the spawn site re-stats it through this check instead. Null when the
 * argv carries no Playwright arguments. */
export interface ClaudeSessionBuilt {
  argv: string[];
  sessionId: string;
  playwrightMcpCheck: ExecutableCheck | null;
}

export function buildClaudeSessionCommand(
  command: ClaudeSessionCommand
): ClaudeSessionBuilt {
  const sessionId = command.resumeId ?? command.sessionId ?? randomUUID();
  // The whole family spawns the same `claude` binary: the zai agent is
  // that binary pointed at the Z.AI endpoint through the adapter's env
  // (ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL), not a separate executable
  // — the adapter's binaryName is "claude", and no zai binary exists.
  const binary = "claude";
  const launchDir = command.cwd ?? process.cwd();
  const argv = [
    binary,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--replay-user-messages",
  ];
  // The resume id precedes every autonomy-derived flag (§4.7).
  if (command.resumeId !== undefined) {
    argv.push("--resume", command.resumeId);
  } else {
    argv.push("--session-id", sessionId);
  }
  // The setting sources are the isolation boundary (§4.7): the user
  // source by default, or the project and local sources the
  // project-settings mode exists to observe — never both, because the
  // user source is what that mode keeps out.
  if (command.projectSettings === true) {
    argv.push("--disable-slash-commands");
    argv.push("--setting-sources", PROJECT_SETTING_SOURCES, "--strict-mcp-config");
  } else {
    argv.push("--setting-sources", "user", "--strict-mcp-config");
  }
  // Run parity for --enable-playwright-mcp (§4.5): the same verified
  // carrier, in run's position — after the writable roots, before the
  // model. Absent (not an error) unless sandboxed and enabled. The
  // binary's trust check rides the return value (review round 110): its
  // path sits inside the --mcp-config JSON argument, where the spawn's
  // command re-check cannot see it.
  const playwright = buildPlaywrightSandboxMcp(command.sandboxed, {
    enabled: command.enablePlaywrightMcp,
    forbiddenRoot: launchDir,
  });
  argv.push(...playwright.args);
  if (command.model !== undefined) {
    argv.push("--model", command.model);
  }
  // The provider-override picker mapping, right after the model it
  // describes: the same carrier the run path uses (modelFlags), pinned
  // here because the session's argv is built from this record alone.
  if (command.providerSettings !== undefined) {
    argv.push("--settings", command.providerSettings);
  }
  argv.push(...claudeSessionAutonomyFlags(command.autonomy, launchDir));
  if (command.effort !== undefined && command.effort !== "none") {
    argv.push("--effort", command.effort);
  }
  return { argv, sessionId, playwrightMcpCheck: playwright.check };
}

/** Capability flags for claude-family sessions (§4.3), pinned by the
 * fixtures: interrupts round-trip, asks surface through the stdio
 * carrier, and deltas stream with `--include-partial-messages`.
 * `user_during_turn` is honestly false (review live21): print mode
 * delivers a mid-turn message at the running turn's next model request
 * when there is one — folded into that turn, one result answering both
 * (fixture zai-session-a.ndjson) — and in a result of its own when there
 * is not, so which result answers it is not knowable when it is sent. A
 * mid-turn `user` line is rejected `busy`; the caller waits for
 * `turn_completed` or interrupts. `steer` is false for the same reason:
 * no carrier shapes the running turn on demand, so a `steer` line is
 * rejected `unsupported` by name. `usage_stream` is honestly false the
 * same way: the claude-family wire reports usage only on the turn's
 * `result` event, so per-turn usage arrives with `turn_completed` and
 * session usage with `session_ended`, never as standalone `usage`
 * events. */
export function claudeSessionCapabilities(): SessionCapabilities {
  return {
    live_input: true,
    user_during_turn: false,
    steer: false,
    interrupt: true,
    permissions: true,
    deltas: true,
    file_changes: "derived",
    usage_stream: false,
    resume: true,
  };
}

/** The harness-side line for one user/steer input. The recorded replay
 * echo (`isReplay: true` user frames) is this exact shape. */
export function buildHarnessUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
}

/** The interrupt control request, pinned by the fixture round-trip. */
export function buildInterruptRequest(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });
}

/** The default denial text: what Claude Code itself tells the model when
 * the user rejects a permission prompt (verified against the installed
 * 2.1.300 binary's own string). Every deny codemux sends — a caller's
 * decision, the session permission policy, the autonomy ceiling, the
 * permission and turn timeouts, supersession, shutdown — carries this
 * unless the caller's decision supplied its own `message`, so the agent
 * reads the rejection as its own harness's, never as an outside
 * wrapper's veto. */
export const DEFAULT_DENIAL_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/** The can_use_tool answer, pinned by the fixture round-trip: the
 * `updatedInput` the probe recorded carries the full merged input, so
 * the caller's `updated_input` (validated by the ceiling before this
 * runs) substitutes wholesale. An allow always carries one — the
 * request's own input when the caller substituted nothing — because the
 * harness runs the tool with exactly that object (review live18: a plain
 * allow went out without it). The overloads make an allow without it a
 * type error. A deny defaults to DEFAULT_DENIAL_MESSAGE; an explicit
 * message (the caller's `permission_decision.message`) substitutes. */
export function buildControlResponse(
  requestId: string,
  behavior: "allow",
  updatedInput: Record<string, unknown>,
  message?: string
): string;
export function buildControlResponse(
  requestId: string,
  behavior: "deny",
  updatedInput?: undefined,
  message?: string
): string;
export function buildControlResponse(
  requestId: string,
  behavior: "allow" | "deny",
  updatedInput?: Record<string, unknown>,
  message?: string
): string {
  const response: Record<string, unknown> = { behavior };
  if (updatedInput !== undefined) {
    response.updatedInput = updatedInput;
  }
  response.message =
    message ?? (behavior === "deny" ? DEFAULT_DENIAL_MESSAGE : `codemux: ${behavior}`);
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  });
}

/** The error answer for a harness `control_request` codemux does not
 * implement: the control protocol's `subtype: "error"` response, keyed
 * to the request's own id so the harness stops waiting on it (review
 * live18 — the codex driver's `-32601` answer, the claude-family
 * sibling). The id is echoed with its wire type. */
export function buildControlErrorResponse(
  requestId: string | number,
  error: string
): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error,
    },
  });
}
