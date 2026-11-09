/**
 * The openhands agent's turn-per-process profile (turn-driver-core.ts):
 * one headless run per caller input, the prompt in a per-turn task file
 * (the run path's carrier — openhands has no stdin transport, so the
 * engine's stdin writer must not run), the json event stream as the
 * turn's verdict, and the deferred identity — the first turn's tail
 * names the conversation (`Conversation ID: <hex>`), every later turn
 * resumes it with `--resume <dashed>`.
 *
 * The task file's lifecycle: buildTurnCommand writes it (the run path's
 * own writeOpenhandsTaskFile — 0600, exclusive, swept, exit-hooked), and
 * the turn's parse finalizes it; a parse that never runs (a spawn that
 * failed before any output) leaves the file to its exit hook and the
 * stale sweep, the same contract a crashed run's file has.
 *
 * A hermetic session carries the private home's env prefix on every
 * turn (openhands-session.ts), the same redirect the run path carries.
 */

import type { TurnAgentProfile } from "./turn-driver-core.js";
import {
  buildOpenhandsSessionCommand,
  parseOpenhandsSessionTurn,
  openhandsSessionCapabilities,
} from "./openhands-session.js";
import { writeOpenhandsTaskFile, type OpenhandsTaskFile } from "../openhands-task-file.js";
import { loginHome } from "../harness-health.js";
import { join } from "node:path";

/** The task files this process's turns wrote, oldest first: each turn's
 * parse finalizes its own. Bounded by the turn count and swept by the
 * writer's own stale sweep once its owner is gone. */
const pendingTaskFiles: OpenhandsTaskFile[] = [];

export const OPENHANDS_DRIVER_PROFILE: TurnAgentProfile = {
  agent: "openhands",
  capabilities: openhandsSessionCapabilities(),
  identity: "deferred",
  // The prompt rides the task file, never argv text and never stdin
  // (openhands reads no stdin): the engine's stdin writer must not run,
  // and the argv the builder returns carries the file's path alone. The
  // argv carrier's deliverability bound (32 KiB) is the price of that
  // choice — the run path's file carrier is unbounded, and a session
  // turn above the bound is refused as text_too_long rather than
  // silently lost to a pipe the child never reads.
  promptCarrier: "argv",
  buildTurnCommand: (input) => {
    if (input.sessionId === null && !input.firstTurn) {
      throw new Error("a resumed openhands turn names the conversation it resumes");
    }
    const taskFile = writeOpenhandsTaskFile(
      join(input.callerHome ?? loginHome(process.env), ".openhands"),
      input.text
    );
    pendingTaskFiles.push(taskFile);
    return buildOpenhandsSessionCommand({
      firstTurn: input.firstTurn,
      conversationId: input.sessionId,
      taskFile: taskFile.path,
      // A hermetic turn always rides the override (the run path's rule:
      // the private home carries no settings).
      overrideWithEnv: input.callerHome !== undefined || input.model !== undefined ||
        input.hermeticHome !== null,
      ...(input.hermeticHome !== null ? { hermeticHome: input.hermeticHome } : {}),
    });
  },
  parseTurnOutput: (stdout, knownSessionId) => {
    // The turn is over, so its prompt file is done: finalize here, and a
    // refused removal reports instead of failing the parse — the exit
    // hook's retry owns the recovery (the run path's cleanup rule).
    const taskFile = pendingTaskFiles.shift();
    if (taskFile !== undefined) {
      try {
        taskFile.finalize();
      } catch (error) {
        console.error(`codemux: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const parsed = parseOpenhandsSessionTurn(stdout, {
      knownConversationId: knownSessionId,
    });
    return {
      answer: parsed.answer,
      usage: parsed.usage,
      modelEffective: null,
      sessionId: parsed.conversationId,
      noSessionId: parsed.noConversationId,
      wrongSession: parsed.wrongConversation,
      noWire: parsed.noWire,
      failed: parsed.failed,
      failureReason: parsed.failureReason,
    };
  },
};
