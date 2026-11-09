/**
 * The gemini agent's turn-per-process profile (turn-driver-core.ts): a
 * codemux-minted identity claimed with `--session-id <mint>` on the
 * first turn and continued with `--resume <mint>` on every later one,
 * the prompt on stdin (`-p ""` selects headless), and the stream-json wire parsed
 * line by line as the turn runs (src/session/gemini-session.ts) — the
 * one line-stream agent: assistant deltas emit as they arrive
 * (capabilities deltas), the init event confirms the identity and names
 * the served model, and the closing result event carries the usage. A
 * hermetic session runs every turn under the GEMINI_CLI_HOME redirect at
 * the session home (the module's own env wrap). The module's
 * grammar_error already carries the wrong-session defect (an init naming
 * a foreign id), so the driver's tier-2 fatal reports it through the
 * message.
 */

import type { TurnAgentProfile } from "./turn-driver-core.js";
import type { GeminiTurnSettings } from "./gemini-settings.js";
import {
  buildGeminiSessionCommand,
  geminiSessionCapabilities,
  parseGeminiStreamLine,
} from "./gemini-session.js";

export const GEMINI_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "gemini",
  capabilities: geminiSessionCapabilities(),
  identity: "minted",
  promptCarrier: "stdin",
  buildTurnCommand: (input) => {
    if (input.sessionId === null) {
      throw new Error("the minted gemini identity names its id before any turn");
    }
    const settings = input as typeof input & GeminiTurnSettings;
    return buildGeminiSessionCommand({
      sessionId: input.sessionId,
      firstTurn: input.firstTurn,
      autonomy: input.autonomy,
      model: input.model,
      prompt: input.text,
      hermeticHome: settings.geminiHome ?? input.hermeticHome ?? undefined,
      policyPath: settings.geminiPolicyPath,
    });
  },
  parseStreamLine: (line, knownSessionId) => {
    const parsed = parseGeminiStreamLine(line, { knownSessionId });
    switch (parsed.kind) {
      case "init":
        return { kind: "confirmed", sessionId: parsed.sessionId, model: parsed.model };
      case "assistant":
        return { kind: "assistant", text: parsed.text, delta: parsed.delta };
      case "tool_use":
        return {
          kind: "tool_use",
          callId: parsed.toolId,
          name: parsed.name,
          input: parsed.input,
        };
      case "tool_result":
        return {
          kind: "tool_result",
          callId: parsed.toolId,
          output: parsed.output,
          isError: parsed.isError,
        };
      case "error":
        // Severity "error" fails the turn; "warning" reports without
        // failing (the plain-run rule, the module's pin).
        return {
          kind: "error",
          message: parsed.message,
          failsTurn: parsed.severity === "error",
        };
      case "result":
        return {
          kind: "result",
          usage: parsed.usage,
          failed: parsed.status === "error",
          failureReason: parsed.errorText,
        };
      case "unknown":
        return { kind: "unknown" };
      case "grammar_error":
        return { kind: "grammar_error", message: parsed.message };
      case "unusable":
        return { kind: "unusable", excerpt: parsed.excerpt, bytes: parsed.bytes };
    }
  },
};
