/**
 * The openhands arm of `codemux session --print-sandbox`: the
 * representative first turn's argv, built without any file write.
 *
 * A real turn writes its prompt to a task file under the openhands
 * directory's `.codemux/` (src/openhands-task-file.ts) and wraps its
 * command in the hermetic env prefix when the session is hermetic
 * (openhandsSessionEnvPrefix). The preview names a representative task
 * path in the same directory and the private home the session would
 * own, and creates neither. Its run context is empty: the adapter's
 * prepareRun would write a task file, and getRunEnv reads no context.
 */

import { join } from "node:path";
import type { RunContext } from "../adapters/base.js";
import { loginHome } from "../harness-health.js";
import { buildOpenhandsSessionCommand } from "./openhands-session.js";

/** The probe and preview context: empty on purpose (see above). */
export function openhandsPreviewContext(): RunContext {
  return {};
}

export interface OpenhandsPreviewInput {
  /** The resumed conversation id; undefined previews a fresh session. */
  resumeId?: string;
  /** The caller-owned home's directory, when the session has one. */
  callerHomeDir?: string;
  /** The private home a hermetic session would own; null when plain. */
  privateDir: string | null;
  model?: string;
}

/** The representative task file a turn would write (never created). */
export function openhandsPreviewTaskFile(callerHomeDir?: string): string {
  const root = callerHomeDir ?? loginHome(process.env);
  return join(root, ".openhands", ".codemux", "preview", "task.txt");
}

/** The first turn's argv, the shape OPENHANDS_DRIVER_PROFILE builds. */
export function buildOpenhandsPreviewCommand(input: OpenhandsPreviewInput): string[] {
  return buildOpenhandsSessionCommand({
    firstTurn: input.resumeId === undefined,
    conversationId: input.resumeId ?? null,
    taskFile: openhandsPreviewTaskFile(input.callerHomeDir),
    overrideWithEnv: input.callerHomeDir !== undefined || input.model !== undefined || input.privateDir !== null,
    ...(input.privateDir !== null ? { hermeticHome: input.privateDir } : {}),
  });
}
